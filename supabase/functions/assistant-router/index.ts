// Pre-selection router for the BBQS Workbench assistant.
//
// Handles user messages BEFORE a project is selected. Classifies intent and
// returns one of:
//   - "discover":   project candidates matching a search (PI / title / keyword)
//   - "add_grant":  detected NIH grant ID — caller should run add-project flow
//   - "qa":         general consortium Q&A answer
//   - "select_required": ambiguous — ask user to pick or clarify
//
// Response shape:
//   { intent, reply, candidates?: [{grant_number,title,pi?,institution?}], grant_number?: string }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { requireService } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// NIH grant pattern (loose). Full token must be 7-15 alphanumerics.
const GRANT_RE = /\b([A-Z]?\d?[A-Z]{1,3}\d{2}[A-Z]{2}\d{6})(?:-\d{1,3})?\b/i;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY") || "";

async function searchGrants(admin: any, query: string, limit = 6) {
  const cleaned = query.trim();
  if (!cleaned) return [];
  // Tokenize for fuzzy multi-word matching (handles "Satrajit Ghosh" matching
  // "Satrajit Sujit Ghosh", or "cory inman" matching "Cory Shields Inman").
  const tokens = cleaned
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}\-']/gu, ""))
    .filter((t) => t.length >= 2);

  // ── PI search first (most common intent) ──
  // Build an AND of ilike filters across all tokens against investigator name.
  let invQuery = admin.from("investigators").select("id, name").limit(20);
  if (tokens.length > 0) {
    for (const t of tokens) {
      invQuery = invQuery.ilike("name", `%${t}%`);
    }
  } else {
    invQuery = invQuery.ilike("name", `%${cleaned}%`);
  }
  const { data: invs } = await invQuery;

  const collected: any[] = [];
  const seen = new Set<string>();

  if (invs && invs.length > 0) {
    const invIds = invs.map((i: any) => i.id);
    const { data: gi } = await admin
      .from("grant_investigators")
      .select("grant_id, role, investigators:investigator_id(name), grants:grant_id(grant_number, title)")
      .in("investigator_id", invIds)
      .limit(limit * 3);
    for (const row of gi || []) {
      if (!row?.grants) continue;
      const gn = row.grants.grant_number;
      if (seen.has(gn)) continue;
      seen.add(gn);
      collected.push({
        grant_number: gn,
        title: row.grants.title,
        pi: row.investigators?.name,
      });
      if (collected.length >= limit) break;
    }
  }

  if (collected.length >= limit) return collected;

  // ── Title / grant_number fallback ──
  const { data: grants } = await admin
    .from("grants")
    .select("grant_number, title, id")
    .or(`title.ilike.%${cleaned}%,grant_number.ilike.%${cleaned}%`)
    .limit(limit);

  if (!grants || grants.length === 0) {
    return collected;
  }

  // Enrich with contact PI + institution
  const ids = grants.map((g: any) => g.id);
  const { data: gi } = await admin
    .from("grant_investigators")
    .select("grant_id, role, investigators:investigator_id(name)")
    .in("grant_id", ids);
  const piByGrant = new Map<string, string>();
  for (const row of gi || []) {
    if (row.role === "contact_pi" && row.investigators?.name && !piByGrant.has(row.grant_id)) {
      piByGrant.set(row.grant_id, row.investigators.name);
    }
  }
  for (const g of grants) {
    if (seen.has(g.grant_number)) continue;
    seen.add(g.grant_number);
    collected.push({
      grant_number: g.grant_number,
      title: g.title,
      pi: piByGrant.get(g.id) || undefined,
    });
    if (collected.length >= limit) break;
  }
  return collected;
}

async function callLLM(messages: { role: string; content: string }[], system: string) {
  if (!LOVABLE_API_KEY) {
    return "I can help you find a project, answer consortium questions, or register a new project from a NIH grant ID. What would you like to do?";
  }
  try {
    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [{ role: "system", content: system }, ...messages],
        temperature: 0.3,
        max_tokens: 500,
      }),
    });
    if (!res.ok) {
      console.error("LLM error", res.status, await res.text().catch(() => ""));
      return "I had trouble generating a reply. Could you rephrase?";
    }
    const j = await res.json();
    return j?.choices?.[0]?.message?.content || "Sorry, no answer available.";
  } catch (err) {
    console.error("callLLM failed", err);
    return "I couldn't reach the language model just now. Please try again.";
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const denied = requireService(req, corsHeaders);
  if (denied) return denied;
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return jsonResponse({ error: "Invalid JSON" }, 400); }

  const messages: { role: "user" | "assistant"; content: string }[] = Array.isArray(body?.messages) ? body.messages : [];
  const last = messages[messages.length - 1]?.content?.trim() || "";
  if (!last) return jsonResponse({ error: "No message" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  // 1. Direct grant ID detection
  const grantMatch = last.match(GRANT_RE);
  if (grantMatch) {
    const grantNumber = grantMatch[1].toUpperCase();
    // Already in our DB?
    const { data: existing } = await admin
      .from("grants")
      .select("grant_number, title")
      .eq("grant_number", grantNumber)
      .maybeSingle();
    if (existing) {
      return jsonResponse({
        intent: "discover",
        reply: `I found **${existing.grant_number}** in the consortium: *${existing.title}*. Open it to start curating?`,
        candidates: [{ grant_number: existing.grant_number, title: existing.title }],
        grant_number: existing.grant_number,
      });
    }
    return jsonResponse({
      intent: "add_grant",
      reply: `**${grantNumber}** isn't in the consortium yet. I can look it up on NIH RePORTER and register it — confirm to proceed.`,
      grant_number: grantNumber,
    });
  }

  // 2. Treat almost anything that isn't a clear Q&A question as a discovery
  // attempt. This makes the assistant invariant to capitalization, partial
  // names ("inman", "satra"), and lowercase input.
  const lower = last.toLowerCase();
  const isQuestion =
    /[?]$/.test(last) ||
    /^(what|who|when|where|why|how|can|could|would|should|do |does |is |are |tell me|explain|help)/i.test(last);
  const wordCount = last.split(/\s+/).filter(Boolean).length;
  const looksDiscovery = !isQuestion && wordCount <= 6;

  if (looksDiscovery) {
    // Strip leading verbs
    const query = last
      .replace(/^(find|search|show|look up|look for|which project|whose|project on|project about|grant for|pi |open|edit|select)\s+/i, "")
      .replace(/[?.!]+$/, "")
      .trim();
    const candidates = await searchGrants(admin, query, 6);
    if (candidates.length > 0) {
      const reply = candidates.length === 1
        ? `I found one match for "${query}". Open it to begin curating?`
        : `I found ${candidates.length} possible matches for "${query}" — pick one to begin curating, or refine your search.`;
      return jsonResponse({ intent: "discover", reply, candidates });
    }
    // Fall through to QA if no matches
    const reply = await callLLM(messages, [
      "You are the BBQS Workbench assistant. The user is searching for a project but no matches were found in the consortium grant database.",
      "Politely say no matches were found, suggest alternatives (e.g. broader keywords, PI last name, NIH grant ID), and ask one short clarifying question.",
      "Be concise: 2-3 sentences max.",
    ].join(" "));
    return jsonResponse({ intent: "qa", reply, candidates: [] });
  }

  // 3. Generic Q&A about the consortium
  // Pull a tiny context: counts + a few project titles for grounding
  const [{ count: grantCount }, { count: projCount }, { data: sampleGrants }] = await Promise.all([
    admin.from("grants").select("id", { count: "exact", head: true }),
    admin.from("projects").select("id", { count: "exact", head: true }),
    admin.from("grants").select("grant_number, title").limit(5),
  ]);

  const system = [
    "You are the BBQS Workbench assistant for the NIH BRAIN BBQS consortium.",
    "Answer the user's question about the consortium, its projects, metadata curation, or how to use this tool.",
    `Context: ${grantCount ?? 0} grants and ${projCount ?? 0} projects in the database.`,
    sampleGrants && sampleGrants.length > 0
      ? `Sample projects: ${sampleGrants.map((g: any) => `${g.grant_number} — ${g.title}`).join("; ")}`
      : "",
    "If the user wants to edit a specific project, gently remind them they can search by name/PI or paste a NIH grant ID.",
    "Be concise (2-4 sentences). Use markdown sparingly.",
  ].filter(Boolean).join(" ");

  const reply = await callLLM(messages, system);
  return jsonResponse({ intent: "qa", reply });
});
