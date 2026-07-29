import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { getCorsHeaders, requireAuth } from "../_shared/auth.ts";
import {
  sanitizeForLLM,
  checkRateLimit,
  rateLimitResponse,
  LLM_RATE_LIMIT,
} from "../_shared/security.ts";
// Feature 009: use the SHARED retrieval core (one RAG path) + shared embedder.
import { retrieve } from "../_shared/rag.ts";
import { embedText } from "../_shared/kg.ts";

async function writeBackInteraction(
  supabase: any, _apiKey: string,
  opts: { userMessage: string; assistantResponse: string }
) {
  try {
    const content = `User asked: ${opts.userMessage}\n\nAssistant answered: ${opts.assistantResponse}`;
    let embedding: number[] | null = null;
    try { embedding = await embedText(content); } catch { /* skip write-back on embed failure */ }
    if (!embedding) return;
    await supabase.from("knowledge_embeddings").upsert({
      source_type: "chat_interaction",
      source_id: `discovery-chat_${Date.now()}`,
      title: `[discovery-chat] ${opts.userMessage.slice(0, 180)}`,
      content: content.slice(0, 4000),
      embedding: `[${embedding.join(",")}]`,
      metadata: {
        function: "discovery-chat",
        timestamp: new Date().toISOString(),
      },
    }, { onConflict: "source_id" });
  } catch (e) { console.error("Embedding write-back error:", e); }
}

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS")
    return new Response(null, { headers: corsHeaders });

  // Require authentication
  const auth = await requireAuth(req, corsHeaders);
  if (auth.error) return auth.error;

  try {
    // Phase 6: Per-user rate limiting
    const rl = checkRateLimit(`discovery-chat:${auth.user.id}`, LLM_RATE_LIMIT);
    if (!rl.allowed) return rateLimitResponse(corsHeaders, rl.retryAfterMs);

    const { query } = await req.json();
    if (!query || typeof query !== "string") {
      return new Response(JSON.stringify({ error: "query is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (query.length > 2000) {
      return new Response(JSON.stringify({ error: "query too long (max 2000 chars)" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Phase 5: Sanitize user input for prompt injection
    const sanitized = sanitizeForLLM(query);
    if (sanitized.injectionDetected) {
      console.warn(`Prompt injection detected in discovery-chat from user ${auth.user.id}:`, sanitized.patternsMatched);
    }
    const sanitizedQuery = sanitized.sanitized;

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // --- 1+2. Semantic retrieval via the SHARED RAG core (feature 009: one retrieval
    // path across bbqs-api /ask, bbqs-mcp ask_bbqs, and here). knowledge_embeddings is
    // public → anon; preserves the prior threshold/count so web-chat behavior is unchanged.
    let ragContext = "";
    try {
      const matches = await retrieve(sanitizedQuery, { anon: true }, { matchThreshold: 0.5, matchCount: 8 });
      if (matches.length) {
        ragContext = matches
          .map((m) => `[${m.source_type}] ${m.title}\n${m.content.slice(0, 600)}`)
          .join("\n---\n");
      }
    } catch (e) {
      console.error("shared retrieve error:", e);
    }

    // --- 3. Also do a direct DB search for people, projects, tools ---
    const STOP_WORDS = new Set(["the","a","an","is","are","was","were","be","been","being","have","has","had","do","does","did","will","would","shall","should","may","might","must","can","could","of","in","to","for","with","on","at","by","from","as","into","through","during","before","after","above","below","between","out","off","over","under","again","further","then","once","here","there","where","when","why","how","all","both","each","few","more","most","other","some","such","no","nor","not","only","own","same","so","than","too","very","just","about","what","which","who","whom","this","that","these","those","i","me","my","we","our","you","your","he","him","his","she","her","it","its","they","them","their","and","but","or","if","while","because","until","find","show","tell","give","get","know","want","like","need","use","look","help","let","say","see","go","come","make","take"]);
    const keywords = query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));

    const searchQueries = keywords.length > 0 ? keywords : [query.toLowerCase()];

    const allPiResults: any[] = [];
    const allGrantResults: any[] = [];
    const allPubResults: any[] = [];
    const allToolResults: any[] = [];

    const searchPromises = searchQueries.flatMap((kw) => {
      const pattern = `%${kw}%`;
      return [
        supabase.from("investigators").select("name, email, orcid, research_areas").ilike("name", pattern).limit(5).then((r) => { if (r.data) allPiResults.push(...r.data); }),
        supabase.from("grants").select("title, grant_number, abstract").ilike("title", pattern).limit(5).then((r) => { if (r.data) allGrantResults.push(...r.data); }),
        supabase.from("publications").select("title, pmid, journal, year, authors").ilike("title", pattern).limit(5).then((r) => { if (r.data) allPubResults.push(...r.data); }),
        supabase.from("resources").select("name, description, external_url, resource_type, metadata").or(`name.ilike.${pattern},description.ilike.${pattern}`).limit(10).then((r) => { if (r.data) allToolResults.push(...r.data); }),
      ];
    });

    await Promise.all(searchPromises);

    const dedupe = <T extends Record<string, any>>(arr: T[], key: string): T[] => {
      const seen = new Set<string>();
      return arr.filter((item) => {
        const k = (item[key] || "").toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    };

    const piRes = { data: dedupe(allPiResults, "name").slice(0, 8) };
    const grantRes = { data: dedupe(allGrantResults, "grant_number").slice(0, 8) };
    const pubRes = { data: dedupe(allPubResults, "pmid").slice(0, 8) };
    const toolRes = { data: dedupe(allToolResults, "name").slice(0, 8) };

    const dbContext: string[] = [];
    if (piRes.data?.length) {
      dbContext.push("INVESTIGATORS:\n" + piRes.data.map((p: any) => `- ${p.name}${p.orcid ? ` (ORCID: ${p.orcid})` : ""}${p.research_areas?.length ? ` — Areas: ${p.research_areas.join(", ")}` : ""}`).join("\n"));
    }
    if (grantRes.data?.length) {
      dbContext.push("GRANTS:\n" + grantRes.data.map((g: any) => `- ${g.title} (${g.grant_number})`).join("\n"));
    }
    if (pubRes.data?.length) {
      dbContext.push("PUBLICATIONS:\n" + pubRes.data.map((p: any) => `- ${p.title}${p.pmid ? ` (PMID: ${p.pmid})` : ""}${p.journal ? ` — ${p.journal}` : ""}${p.year ? ` (${p.year})` : ""}`).join("\n"));
    }
    if (toolRes.data?.length) {
      dbContext.push("SOFTWARE TOOLS & RESOURCES:\n" + toolRes.data.map((t: any) => {
        const meta = t.metadata || {};
        const parts = [`- **${t.name}** (${t.resource_type}): ${t.description || ""}`];
        if (meta.algorithm) parts.push(`  Algorithm: ${meta.algorithm}`);
        if (meta.species) parts.push(`  Species: ${meta.species}`);
        if (t.external_url) parts.push(`  URL: ${t.external_url}`);
        return parts.join("\n");
      }).join("\n"));
    }

    const fullContext = [ragContext, ...dbContext].filter(Boolean).join("\n\n===\n\n");

    // --- 4. Log query anonymously ---
    await supabase.from("search_queries").insert({ query, mode: "chat", results_count: (piRes.data?.length || 0) + (grantRes.data?.length || 0) + (pubRes.data?.length || 0) + (toolRes.data?.length || 0) });

    // --- 5. Call Lovable AI ---
    const systemPrompt = `You are a discovery assistant for the BBQS (Brain Behavior Quantification & Synchronization) consortium website. Your job is to help researchers find relevant people, projects, publications, software tools, datasets, and resources within the consortium.

IMPORTANT RULES:
- Be concise and helpful. Use bullet points and links when possible.
- When you mention a page, ALWAYS include a clickable markdown link using the internal path, e.g. [Projects](/projects), [Publications](/publications), [People](/investigators), [Software & Tools](/resources), [Species](/species), [Datasets](/datasets), [Knowledge Graph](/knowledge-graph).
- When mentioning a specific tool or software, link to the resources page: [DeepLabCut](/resources).
- When mentioning a specific person, link to the investigators page: [Dr. Smith](/investigators).
- When mentioning a grant or project, link to the projects page: [grant title](/projects).
- If the context includes an external URL for a tool, include it as a separate link.
- If the context contains matching results, present them clearly.
- If no matches are found, suggest related pages the user might explore with links.
- Always mention specific names, grant numbers, or tool names when available.
- Keep responses under 300 words.

CONTEXT FROM BBQS DATABASE:
${fullContext || "No specific matches found in the database for this query."}`;

    const response = await fetch(
      "https://ai.gateway.lovable.dev/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-3-flash-preview",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: sanitizedQuery },
          ],
          stream: true,
        }),
      }
    );

    if (!response.ok) {
      const status = response.status;
      if (status === 429) {
        return new Response(JSON.stringify({ error: "Rate limited. Please try again shortly." }), { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      if (status === 402) {
        return new Response(JSON.stringify({ error: "AI credits exhausted. Please add funds." }), { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      const t = await response.text();
      console.error("AI gateway error:", status, t);
      return new Response(JSON.stringify({ error: "AI gateway error" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Tee stream: one for client, one to collect for write-back
    const [clientStream, collectorStream] = response.body!.tee();

    // Fire-and-forget: collect full response and write back embedding
    (async () => {
      try {
        const reader = collectorStream.getReader();
        const decoder = new TextDecoder();
        let fullContent = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          for (const line of chunk.split("\n")) {
            if (line.startsWith("data: ") && line !== "data: [DONE]") {
              try {
                const json = JSON.parse(line.slice(6));
                const delta = json.choices?.[0]?.delta?.content;
                if (delta) fullContent += delta;
              } catch {}
            }
          }
        }
        if (fullContent && query) {
          await writeBackInteraction(supabase, LOVABLE_API_KEY, {
            userMessage: query,
            assistantResponse: fullContent,
          });
        }
      } catch (e) { console.error("Stream collection error:", e); }
    })();

    return new Response(clientStream, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (e) {
    console.error("discovery-chat error:", e);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
