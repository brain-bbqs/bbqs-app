// Smart-fill for the onboarding console (feature-004 principle: the LLM NORMALIZES &
// PROPOSES; the admin reviews the deterministic form and submits). Takes free text (a
// Google-Form row, an email, or a description) and returns sanitized onboarding fields to
// pre-fill the Onboard wizard. Never writes anything. Admin/curator only.
//
// Mirrors the KG's existing LLM path (Lovable AI gateway, google/gemini-2.5-flash).
// Deploy: supabase functions deploy parse-onboard  (needs LOVABLE_API_KEY on the project).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-bbqs-client",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const ROLES = ["contact_pi", "co_pi", "mpi", "co-investigator", "postdoc", "graduate_student", "research_staff", "data_manager", "project_manager", "nih_program", "admin", "other"];
const WGS = ["WG-Analytics", "WG-Devices", "WG-ELSI", "WG-Standards"];
const TIERS = ["member", "curator", "admin"];

const SYSTEM = `You extract BBQS member-onboarding fields from free text (a form row, an email, or a description). Return ONLY a JSON object — no prose, no markdown fences — with EXACTLY these keys:
{
 "name": string,                // full name "First Last"
 "email": string,               // primary email, lowercased
 "secondary_email": string|null,
 "role": string|null,           // ONE of: contact_pi, co_pi, mpi, co-investigator, postdoc, graduate_student, research_staff, data_manager, project_manager, nih_program, admin, other
 "working_groups": string[],    // subset of ["WG-Analytics","WG-Devices","WG-ELSI","WG-Standards"]
 "institution": string|null,
 "access_tier": string|null,    // "member" | "curator" | "admin"; default "member" unless clearly stated
 "grant_hint": string|null      // a grant number, grant title, or PI name to help locate the grant
}
Rules:
- Map role synonyms: "PI"/"Principal Investigator"/"Lead PI"/"Contact PI" -> contact_pi; "Co-PI"/"MPI"/"Multiple PI" -> co_pi; "Co-Investigator" -> co-investigator; "PhD student"/"graduate student"/"masters student" -> graduate_student; "postdoc" -> postdoc; "research scientist"/"research associate"/"staff" -> research_staff; "program officer"/"program official" -> nih_program.
- working_groups: infer tokens from any mention of Analytics / Devices / ELSI (a.k.a. Ethics) / Standards. Empty array if none.
- grant_hint: if a grant is given by number use the number; else the PI name (e.g. "Christopher Rozell") or the title. null if none.
- Use null (never a guess) for anything genuinely absent. NEVER invent an email.`;

const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { text } = await req.json().catch(() => ({}));
    if (!text || typeof text !== "string" || !text.trim()) return json({ ok: false, error: "Provide text" }, 400);

    // Authz: caller must be admin or curator (checked under their own JWT).
    const authHeader = req.headers.get("Authorization") || "";
    const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData } = await supa.auth.getUser();
    const uid = userData?.user?.id;
    if (!uid) return json({ ok: false, error: "Not authenticated" }, 401);
    const { data: roles } = await supa.from("user_roles").select("role").eq("user_id", uid);
    if (!(roles || []).some((r: { role: string }) => r.role === "admin" || r.role === "curator")) {
      return json({ ok: false, error: "Admin or curator only" }, 403);
    }

    const KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!KEY) return json({ ok: false, error: "LOVABLE_API_KEY not configured" }, 500);

    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        temperature: 0,
        max_tokens: 400,
        messages: [{ role: "system", content: SYSTEM }, { role: "user", content: text.slice(0, 4000) }],
      }),
    });
    if (!res.ok) return json({ ok: false, error: `LLM ${res.status}` }, 502);
    const data = await res.json();
    let content = String(data?.choices?.[0]?.message?.content || "").replace(/```json\s*|\s*```/gi, "").trim();
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) return json({ ok: false, error: "Model returned no JSON" }, 422);
    let f: Record<string, unknown>;
    try { f = JSON.parse(m[0]); } catch { return json({ ok: false, error: "Bad JSON from model" }, 422); }

    // Sanitize to the allowed enums so the client can trust the result.
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
    const out = {
      name: str(f.name) ?? "",
      email: (str(f.email) ?? "").toLowerCase(),
      secondary_email: str(f.secondary_email),
      role: ROLES.includes(f.role as string) ? (f.role as string) : null,
      working_groups: Array.isArray(f.working_groups) ? (f.working_groups as string[]).filter((w) => WGS.includes(w)) : [],
      institution: str(f.institution),
      access_tier: TIERS.includes(f.access_tier as string) ? (f.access_tier as string) : null,
      grant_hint: str(f.grant_hint),
    };
    return json({ ok: true, fields: out });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 500);
  }
});
