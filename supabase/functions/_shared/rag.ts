// Single RAG path for the external faces — feature 009.
// Retrieval over the unified KG index (knowledge_embeddings via search_knowledge_embeddings),
// anon KG (RLS authority), answer via OpenRouter. Used by bbqs-mcp ask_bbqs + bbqs-api /ask;
// discovery-chat reuses this retrieval core (keeps its own interaction write-back).

import { ANON_KEY, authBearer, embedText, SUPABASE_URL, type KgAuth } from "./kg.ts";

const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY")!;

export type RagSource = { type: string; title: string };
export type RagResult = { answer: string; sources: RagSource[] };

type MatchRow = { source_type: string; title: string; content: string };

/** Retrieve top matches from the unified index (anon). Exposed so callers (e.g.
 *  discovery-chat) can reuse the exact same retrieval without duplicating a RAG. */
export async function retrieve(
  question: string,
  auth: KgAuth,
  opts: { matchThreshold?: number; matchCount?: number } = {},
): Promise<MatchRow[]> {
  const vec = await embedText(question);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/search_knowledge_embeddings`, {
    method: "POST",
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${authBearer(auth)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query_embedding: `[${vec.join(",")}]`,
      // 0.3 floor (matches the agent's semantic leg) — 0.5 dropped real moderate matches,
      // starving the LLM of grounding and inviting fabrication.
      match_threshold: opts.matchThreshold ?? 0.3,
      match_count: opts.matchCount ?? 8,
    }),
  });
  if (!res.ok) return [];
  return (await res.json()) as MatchRow[];
}

/** Full RAG: retrieve → answer. Grounded ONLY in retrieved public context. */
export async function askKG(question: string, auth: KgAuth): Promise<RagResult> {
  const contexts = await retrieve(question, auth);

  // Anti-fabrication: with NO retrieved context, do NOT call the LLM — it will invent
  // plausible-but-fake projects. Refuse honestly instead (grounded-only guarantee).
  if (contexts.length === 0) {
    return {
      answer:
        "I couldn't find anything in the BBQS knowledge base to answer that. Try rephrasing, or ask about consortium projects, investigators, grants, datasets, publications, or resources.",
      sources: [],
    };
  }

  let systemPrompt =
    "You are a helpful assistant for the BBQS (Brain Behavior Quantification and Synchronization) consortium. Answer using ONLY the provided context. Be concise and factual. If the context does not cover the question, say so.";
  if (contexts.length) {
    systemPrompt += "\n\n## Context:\n";
    for (const ctx of contexts) systemPrompt += `\n### [${ctx.source_type}] ${ctx.title}\n${ctx.content}\n`;
  }

  const chat = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://bbqs.dev",
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: question },
      ],
      max_tokens: 1024,
      temperature: 0.3,
    }),
  });
  if (!chat.ok) throw new Error(`LLM error: ${(await chat.text()).slice(0, 200)}`);
  const data = await chat.json();
  const answer = data.choices?.[0]?.message?.content || "Unable to generate a response.";
  const sources = contexts.map((c) => ({ type: c.source_type, title: c.title }));
  return { answer, sources };
}
