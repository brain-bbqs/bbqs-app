import { createClient } from "npm:@supabase/supabase-js@2.39.3";
import { requireCuratorOrService } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const EMBER_API = "https://api-dandi.emberarchive.org/api";

// Match NIH core project numbers like R34DA059723 or U24MH136628 (with optional leading activity digit).
const CORE_RE = /\d?([A-Z]\d{2}[A-Z]{2}\d{6})/g;

function normalizeAward(raw: string): string | null {
  const s = (raw || "").toUpperCase().replace(/\s+/g, "");
  CORE_RE.lastIndex = 0;
  const m = CORE_RE.exec(s);
  return m ? m[1] : null;
}

type DandisetSummary = {
  identifier: string;
  draft_version?: { version: string };
  most_recent_published_version?: { version: string } | null;
  contact_person?: string;
};

type Version = {
  name?: string;
  description?: string;
  license?: string[];
  access?: Array<{ status?: string }>;
  contributor?: Array<{
    name?: string;
    schemaKey?: string;
    awardNumber?: string;
    identifier?: string;
    roleName?: string[];
  }>;
  assetsSummary?: {
    numberOfFiles?: number;
    numberOfBytes?: number;
    species?: Array<{ name?: string }>;
  };
};

async function fetchJson(url: string) {
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

async function listDandisets(): Promise<DandisetSummary[]> {
  const out: DandisetSummary[] = [];
  let url: string | null = `${EMBER_API}/dandisets/?page_size=100&draft=true&empty=true`;
  while (url) {
    const page: any = await fetchJson(url);
    for (const r of page.results || []) out.push(r);
    url = page.next || null;
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const denied = await requireCuratorOrService(req, corsHeaders);
  if (denied) return denied;

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const dandisets = await listDandisets();
    console.log(`[ember-sync] discovered ${dandisets.length} dandisets`);

    // Preload grants for matching
    const { data: grantRows } = await admin.from("grants").select("id, grant_number");
    const grantByCore = new Map<string, string>(); // core -> grant.id
    for (const g of grantRows || []) {
      const core = normalizeAward(g.grant_number);
      if (core) grantByCore.set(core, g.id);
    }

    let synced = 0;
    let linked = 0;
    const results: any[] = [];

    for (const ds of dandisets) {
      try {
        const versionTag =
          ds.most_recent_published_version?.version || ds.draft_version?.version || "draft";
        const v: Version = await fetchJson(
          `${EMBER_API}/dandisets/${ds.identifier}/versions/${versionTag}/`,
        );

        // Extract award numbers and contact
        const awardsRaw: string[] = [];
        let contactName: string | null = ds.contact_person || null;
        for (const c of v.contributor || []) {
          if (c.awardNumber) {
            for (const part of String(c.awardNumber).split(/[;,]+/)) {
              const t = part.trim();
              if (t) awardsRaw.push(t);
            }
          }
          if (!contactName && (c.roleName || []).some((r) => /contact|principal/i.test(r))) {
            contactName = c.name || null;
          }
        }
        const awardCores = Array.from(
          new Set(
            awardsRaw.map(normalizeAward).filter((x): x is string => !!x),
          ),
        );

        const species = (v.assetsSummary?.species || [])
          .map((s) => s.name || "")
          .filter(Boolean);

        // select("*"): `hidden` exists only once 20261105120000 is applied, and naming it before then
        // would fail the query. A failed lookup must not fall through to creating a second resource.
        const { data: existing, error: exErr } = await admin
          .from("dandisets")
          .select("*")
          .eq("instance", "ember")
          .eq("dandiset_id", ds.identifier)
          .maybeSingle();
        if (exErr) throw exErr;

        // A dandiset becomes a resource only when a curator has not hidden it (set_dandiset_hidden)
        // and it holds at least one file. EMBER is also where people test uploads (#506).
        const hidden = existing?.hidden === true;
        const fileCount = v.assetsSummary?.numberOfFiles ?? 0;
        let resourceId = existing?.resource_id || null;
        const resource = resourceId ? "kept" : hidden ? "hidden" : fileCount > 0 ? "created" : "empty";
        if (resource === "created") {
          const { data: res } = await admin
            .from("resources")
            .insert({
              name: v.name || `EMBER ${ds.identifier}`,
              description: (v.description || "").slice(0, 4000),
              resource_type: "dataset",
              external_url: `https://dandi.emberarchive.org/dandiset/${ds.identifier}`,
              metadata: { source: "ember", dandiset_id: ds.identifier },
            })
            .select("id")
            .single();
          resourceId = res?.id || null;
        }

        const row = {
          instance: "ember",
          dandiset_id: ds.identifier,
          resource_id: resourceId,
          name: v.name || `EMBER ${ds.identifier}`,
          description: v.description || null,
          contact_name: contactName,
          file_count: v.assetsSummary?.numberOfFiles ?? null,
          size_bytes: v.assetsSummary?.numberOfBytes ?? null,
          license: (v.license || [])[0] || null,
          access: v.access?.[0]?.status || null,
          species,
          award_numbers: awardCores,
          draft_url: `https://dandi.emberarchive.org/dandiset/${ds.identifier}`,
          api_url: `${EMBER_API}/dandisets/${ds.identifier}/versions/${versionTag}/`,
          neurosift_url: `https://neurosift.app/dandiset/${ds.identifier}?dandisetVersion=${versionTag}&staging=ember`,
          raw: v as any,
          last_synced_at: new Date().toISOString(),
        };

        const { data: upserted, error: upErr } = await admin
          .from("dandisets")
          .upsert(row, { onConflict: "instance,dandiset_id" })
          .select("id")
          .single();
        if (upErr) throw upErr;
        synced++;

        // Link to grants by award number
        if (upserted?.id && awardCores.length) {
          // Clear existing automated links for this dandiset
          await admin
            .from("grant_dandisets")
            .delete()
            .eq("dandiset_id", upserted.id)
            .eq("match_source", "award_number");

          for (const core of awardCores) {
            const gid = grantByCore.get(core);
            if (!gid) continue;
            await admin.from("grant_dandisets").upsert(
              {
                grant_id: gid,
                dandiset_id: upserted.id,
                match_source: "award_number",
                matched_award: core,
              },
              { onConflict: "grant_id,dandiset_id" },
            );
            linked++;
          }
        }

        results.push({
          dandiset: ds.identifier,
          resource,
          awards: awardCores,
          linked_grants: awardCores.filter((c) => grantByCore.has(c)),
        });
      } catch (e) {
        console.error(`[ember-sync] ${ds.identifier} failed:`, e);
        results.push({ dandiset: ds.identifier, error: String(e) });
      }
    }

    return new Response(
      JSON.stringify({ ok: true, total: dandisets.length, synced, linked, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[ember-sync] fatal:", e);
    return new Response(JSON.stringify({ ok: false, error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});