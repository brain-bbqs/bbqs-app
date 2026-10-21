// Serves the /sfn-2026 poster and talk schedule from the SfN form's published "Website" tab, a
// filtered view holding only Name + presentation for people who agreed to be listed. The response
// sheet itself is never read, so no email or attendance answer can reach the page.
import { getCorsHeaders } from "../_shared/auth.ts";
import { type Presentation, parsePresentations } from "./parse.ts";

const CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vS95mrGW2yAsYRWn9BQexMC8_Vu2MvN2kGCR8yBOw0WeBhStxJ3s_LbKxmoXWvlA92TvzoWU-RThDuZ/pub?gid=1446601298&single=true&output=csv";

// abstractsonline refuses server-side requests (403), so an answer given only as an abstract link is
// completed from what that page shows.
const ABSTRACTS: Record<string, Partial<Presentation>> = {
  "21503/presentation/27321": {
    day: 18, start: 780, end: 1020, time: "1:00–5:00 PM", number: "PSTR383.07",
    title: "Building Better Data Standards Together: The NWB Enhancement Proposal (NWBEP) Framework and Advances in NWB",
  },
};

const fill = (p: Presentation) => {
  const key = p.link && Object.keys(ABSTRACTS).find((k) => p.link!.includes(k));
  return key ? ABSTRACTS[key] : null;
};

Deno.serve(async (req) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const json = { ...cors, "Content-Type": "application/json" };

  try {
    const res = await fetch(CSV_URL, { redirect: "follow" });
    if (!res.ok) {
      return new Response(JSON.stringify({ ok: false, error: `sheet_fetch_failed:${res.status}` }), { status: 502, headers: json });
    }
    const presentations = parsePresentations(await res.text(), fill);
    return new Response(
      JSON.stringify({ ok: true, count: presentations.length, presentations, fetched_at: new Date().toISOString() }),
      { headers: { ...json, "Cache-Control": "public, max-age=300" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as Error)?.message ?? e) }), { status: 500, headers: json });
  }
});
