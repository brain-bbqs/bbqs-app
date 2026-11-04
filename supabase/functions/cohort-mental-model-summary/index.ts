// Synthesizes a one-paragraph "shared mental model" summary per cohort
// (R61 / R34) from every grant abstract in that mechanism. Cached in
// public.cohort_summaries so we only hit the LLM once per refresh.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders, requireService } from "../_shared/auth.ts";

const MECH = ["R61", "R34"] as const;
type Mech = typeof MECH[number];

function classify(grantNumber: string): Mech | null {
  const gn = grantNumber.toUpperCase();
  if (gn.includes("R61")) return "R61";
  if (gn.includes("R34")) return "R34";
  return null;
}

async function summarize(mech: Mech, abstracts: string[]): Promise<string> {
  const key = Deno.env.get("LOVABLE_API_KEY");
  if (!key) return "";
  const joined = abstracts.slice(0, 25).map((a, i) => `Abstract ${i + 1}:\n${a.slice(0, 1200)}`).join("\n\n");
  const system = mech === "R61"
    ? "You are summarizing the shared mental model across NIH R61 translational neural device grants in the BBQS consortium. Focus on shared engineering approaches, target species/populations, and clinical translation aims."
    : "You are summarizing the shared mental model across NIH R34 animal behavior & collective intelligence grants in the BBQS consortium. Focus on shared behavioral paradigms, species, quantification methods, and cross-species themes.";
  const user = `Read these ${abstracts.length} grant abstracts and write ONE tight paragraph (max 90 words) describing what these teams collectively believe / are working on. No bullet lists. No preamble.\n\n${joined}`;
  const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!resp.ok) return "";
  const json = await resp.json();
  return json.choices?.[0]?.message?.content?.trim() ?? "";
}

Deno.serve(async (req) => {
  const headers = { ...getCorsHeaders(req), "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response(null, { headers });
  const denied = await requireService(req, headers);
  if (denied) return denied;
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(url, service);
    const body = await req.json().catch(() => ({}));
    const force = body?.force === true;

    // Return cache if fresh (< 24h) and not forced.
    const { data: cached } = await admin.from("cohort_summaries").select("*");
    const now = Date.now();
    const fresh = new Map<string, any>();
    for (const row of cached ?? []) {
      if (!force && now - new Date(row.generated_at).getTime() < 24 * 3600_000) {
        fresh.set(row.mechanism, row);
      }
    }

    const { data: grants } = await admin.from("grants").select("grant_number, abstract, title");
    const byMech: Record<Mech, string[]> = { R61: [], R34: [] };
    const countByMech: Record<Mech, number> = { R61: 0, R34: 0 };
    for (const g of grants ?? []) {
      const m = classify(g.grant_number);
      if (!m) continue;
      countByMech[m]++;
      if (g.abstract) byMech[m].push(`${g.title}\n${g.abstract}`);
    }

    const out: Record<string, { summary: string; n_grants: number; generated_at: string }> = {};
    for (const m of MECH) {
      if (fresh.has(m)) {
        out[m] = { summary: fresh.get(m).summary, n_grants: fresh.get(m).n_grants, generated_at: fresh.get(m).generated_at };
        continue;
      }
      const summary = await summarize(m, byMech[m]);
      if (summary) {
        await admin.from("cohort_summaries").upsert({
          mechanism: m, summary, n_grants: countByMech[m], generated_at: new Date().toISOString(),
        });
      }
      out[m] = { summary, n_grants: countByMech[m], generated_at: new Date().toISOString() };
    }
    return new Response(JSON.stringify(out), { headers });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    return new Response(JSON.stringify({ error: msg }), { status: 500, headers });
  }
});