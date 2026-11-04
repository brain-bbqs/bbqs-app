// Aggregated site analytics for the Social Force Field dashboard.
// Uses the service role internally so that preview / signed-in admin
// sessions can both read summary numbers without hitting RLS row-by-row.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/auth.ts";

type Row = {
  path: string | null;
  session_id: string | null;
  user_id: string | null;
  created_at: string;
  element_tag?: string | null;
  element_text?: string | null;
  element_href?: string | null;
};

function pct(curr: number, prev: number) {
  if (prev === 0) return curr > 0 ? 100 : 0;
  return Math.round(((curr - prev) / prev) * 100);
}

async function callerIsAdminOrCurator(req: Request, url: string, anon: string): Promise<boolean> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return false;
  try {
    const client = createClient(url, anon, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await client.auth.getUser();
    if (!user) return false;
    const { data } = await client
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id);
    return (data ?? []).some((r: any) => r.role === "admin" || r.role === "curator");
  } catch {
    return false;
  }
}

async function fetchAll(admin: ReturnType<typeof createClient>, table: string, cols: string): Promise<Row[]> {
  const pageSize = 1000;
  const out: Row[] = [];
  for (let from = 0; from < 500_000; from += pageSize) {
    const { data, error } = await admin
      .from(table)
      .select(cols)
      .order("created_at", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...(data as unknown as Row[]));
    if (data.length < pageSize) break;
  }
  return out;
}

Deno.serve(async (req) => {
  const headers = { ...getCorsHeaders(req), "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response(null, { headers });

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Origin is caller-controlled (curl sends any), so it is never a credential.
  const allowed = await callerIsAdminOrCurator(req, url, anon);
  if (!allowed) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers });
  }

  try {
    const admin = createClient(url, service);
    const [clicks, pvs] = await Promise.all([
      fetchAll(admin, "analytics_clicks", "path, session_id, user_id, created_at, element_tag, element_text, element_href"),
      fetchAll(admin, "analytics_pageviews", "path, session_id, user_id, created_at"),
    ]);
    const all = [...clicks, ...pvs];
    const firstTs = all.reduce((min, r) => Math.min(min, new Date(r.created_at).getTime()), Date.now());
    const days = Math.max(14, Math.min(180, Math.ceil((Date.now() - firstTs) / 86_400_000) + 1));

    const bucket = (rows: Row[]) => {
      const b = new Array(days).fill(0);
      const now = Date.now();
      for (const r of rows) {
        const idx = days - 1 - Math.floor((now - new Date(r.created_at).getTime()) / 86_400_000);
        if (idx >= 0 && idx < days) b[idx]++;
      }
      return b;
    };
    const uniqBucket = (rows: Row[]) => {
      const seen: Array<Set<string>> = Array.from({ length: days }, () => new Set());
      const now = Date.now();
      for (const r of rows) {
        const idx = days - 1 - Math.floor((now - new Date(r.created_at).getTime()) / 86_400_000);
        const id = r.user_id || r.session_id;
        if (idx >= 0 && idx < days && id) seen[idx].add(id);
      }
      return seen.map((s) => s.size);
    };

    const w = 7 * 86_400_000;
    const now = Date.now();
    const inRange = (r: Row, a: number, b: number) => {
      const t = new Date(r.created_at).getTime();
      return t >= a && t < b;
    };
    const cLast = clicks.filter((r) => inRange(r, now - w, now)).length;
    const cPrev = clicks.filter((r) => inRange(r, now - 2 * w, now - w)).length;
    const pLast = pvs.filter((r) => inRange(r, now - w, now)).length;
    const pPrev = pvs.filter((r) => inRange(r, now - 2 * w, now - w)).length;
    const sLast = new Set(all.filter((r) => inRange(r, now - w, now)).map((r) => r.session_id).filter(Boolean)).size;
    const sPrev = new Set(all.filter((r) => inRange(r, now - 2 * w, now - w)).map((r) => r.session_id).filter(Boolean)).size;
    const uLast = new Set(all.filter((r) => inRange(r, now - w, now)).map((r) => r.user_id).filter(Boolean)).size;
    const uPrev = new Set(all.filter((r) => inRange(r, now - 2 * w, now - w)).map((r) => r.user_id).filter(Boolean)).size;

    const pvByPath = new Map<string, number>();
    pvs.forEach((r) => { const p = r.path || "/"; pvByPath.set(p, (pvByPath.get(p) ?? 0) + 1); });
    const clicksByPath = new Map<string, number>();
    clicks.forEach((r) => { const p = r.path || "/"; clicksByPath.set(p, (clicksByPath.get(p) ?? 0) + 1); });
    const topPages = [...pvByPath.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 12)
      .map(([path, views]) => ({ path, views, clicks: clicksByPath.get(path) ?? 0 }));

    const byText = new Map<string, number>();
    clicks.forEach((r) => {
      const t = (r.element_text || "").trim();
      if (!t) return;
      byText.set(t, (byText.get(t) ?? 0) + 1);
    });
    const topClickTargets = [...byText.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([text, count]) => ({ text, count }));

    const byTag = new Map<string, number>();
    clicks.forEach((r) => { const t = r.element_tag || "other"; byTag.set(t, (byTag.get(t) ?? 0) + 1); });
    const tagBreakdown = [...byTag.entries()].sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count }));

    const sortedClicks = [...clicksByPath.entries()].sort((a, b) => b[1] - a[1]).slice(0, 36);
    const maxCount = sortedClicks[0]?.[1] ?? 1;
    const heatmap = new Array(36).fill(0);
    const heatmapLabels = new Array(36).fill("");
    sortedClicks.forEach(([path, count], i) => {
      heatmap[i] = Math.max(0, Math.min(1, count / maxCount));
      heatmapLabels[i] = `${path} — ${count} clicks`;
    });

    // --- Project clicks: which grants people open / land on ---
    const grantHits = new Map<string, number>();
    const grantRe = /\/projects\/([^/?#]+)(?:\/|$)/;
    for (const r of clicks) {
      const src = r.element_href || "";
      const m1 = src.match(grantRe);
      const g = m1?.[1];
      if (g && g !== "") grantHits.set(g, (grantHits.get(g) ?? 0) + 1);
    }
    for (const r of pvs) {
      const m = (r.path || "").match(grantRe);
      const g = m?.[1];
      if (g) grantHits.set(g, (grantHits.get(g) ?? 0) + 1);
    }
    let projectClicks: { grant_number: string; title: string | null; count: number }[] = [];
    if (grantHits.size > 0) {
      const nums = [...grantHits.keys()];
      const { data: gs } = await admin
        .from("grants")
        .select("grant_number, title")
        .in("grant_number", nums);
      const titleMap = new Map<string, string>();
      (gs ?? []).forEach((g: any) => titleMap.set(g.grant_number, g.title));
      projectClicks = [...grantHits.entries()]
        .map(([grant_number, count]) => ({
          grant_number,
          title: titleMap.get(grant_number) ?? null,
          count,
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 15);
    }

    // --- Side-nav / link destinations: where clicks send people next ---
    const destHits = new Map<string, number>();
    for (const r of clicks) {
      const h = (r.element_href || "").trim();
      if (!h || !h.startsWith("/")) continue;
      const clean = h.split("#")[0];
      destHits.set(clean, (destHits.get(clean) ?? 0) + 1);
    }
    const topDestinations = [...destHits.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([href, count]) => ({ href, count }));

    // --- Tab / filter buttons: buttons grouped by originating path ---
    // Heuristic: buttons on a page whose text is short-ish and not empty.
    const tabAgg = new Map<string, number>();
    for (const r of clicks) {
      if ((r.element_tag || "") !== "button") continue;
      const text = (r.element_text || "").trim();
      if (!text || text.length > 60) continue;
      const path = r.path || "/";
      // Skip generic actions we already surface elsewhere
      if (/^(Refresh|Next day|Prev day|Sign in|Sign out)$/i.test(text)) continue;
      tabAgg.set(`${path}\u0001${text}`, (tabAgg.get(`${path}\u0001${text}`) ?? 0) + 1);
    }
    const tabClicks = [...tabAgg.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([k, count]) => {
        const [path, label] = k.split("\u0001");
        return { path, label, count };
      });

    const body = {
      clicks: clicks.length,
      pageviews: pvs.length,
      sessions: new Set(all.map((r) => r.session_id).filter(Boolean)).size,
      users: new Set(all.map((r) => r.user_id).filter(Boolean)).size,
      clickSpark: bucket(clicks),
      pvSpark: bucket(pvs),
      sessionSpark: uniqBucket(all),
      clickDelta: pct(cLast, cPrev),
      pvDelta: pct(pLast, pPrev),
      sessionDelta: pct(sLast, sPrev),
      userDelta: pct(uLast, uPrev),
      topPages, topClickTargets, tagBreakdown,
      heatmap, heatmapLabels,
      projectClicks, topDestinations, tabClicks,
      firstSeen: all.length ? new Date(firstTs).toISOString() : null,
    };
    return new Response(JSON.stringify(body), { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown";
    return new Response(JSON.stringify({ error: message }), { status: 500, headers });
  }
});