// The questionnaire answers a visitor may read: the keys of projects.metadata the public pages show,
// from the view project_metadata_public (supabase/migrations/20261118120000_privacy_round_two.sql).
//
// projects.metadata itself holds every answer, free text included, and once that migration is applied
// only signed-in users may read it. A page that shows answers to everyone reads them here, so the same
// code works for a visitor and for a member, before the migration and after it:
//   * after it: the view carries exactly PUBLIC_METADATA_KEYS (and, under `devices`, PUBLIC_DEVICE_KEYS);
//   * before it (the migration is applied by hand, and is on hold): the view does not exist, the
//     column is still readable by everyone, so it is read once and cut down to the same keys. The pages
//     show the same content in both states, whichever is deployed first.
// A key a public page starts to show must be added to the view and to these lists;
// tests/guards/anon-private-columns holds the three equal.
import { supabase } from "@/integrations/supabase/client";

export type PublicProjectMetadata = Record<string, any>;

/** The keys of projects.metadata project_metadata_public exposes. */
export const PUBLIC_METADATA_KEYS = [
  "use_approaches", "marr_l1_ethological_goal", "marr_l2_algorithmic_function",
  "marr_l3_implementational_hardware", "cross_project_synergy", "data_analysis_approach",
  "target_species_domain", "agentic_action_required", "experimental_approaches", "data_modalities",
  "data_type", "analysis_types", "analysis_methods", "software_tools_used", "produce_data_modality",
  "produce_data_type", "use_analysis_types", "use_analysis_method", "develope_software_type", "devices",
] as const;

/** The keys of metadata.devices it exposes. */
export const PUBLIC_DEVICE_KEYS = [
  "sensor", "data_acquisition_modalities", "behavioral_rigs", "electrophysiology_setup",
] as const;

/** What the view would return for one project's metadata: the public keys only. */
export function publicSubset(metadata: unknown): PublicProjectMetadata {
  const out: PublicProjectMetadata = {};
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return out;
  const source = metadata as Record<string, unknown>;
  for (const key of PUBLIC_METADATA_KEYS) {
    if (!(key in source)) continue;
    if (key !== "devices") { out[key] = source[key]; continue; }
    const devices = source.devices;
    if (!devices || typeof devices !== "object" || Array.isArray(devices)) { out.devices = null; continue; }
    out.devices = Object.fromEntries(
      PUBLIC_DEVICE_KEYS.filter((k) => k in (devices as Record<string, unknown>))
        .map((k) => [k, (devices as Record<string, unknown>)[k]]),
    );
  }
  return out;
}

/** The view is missing: 20261118120000 is not applied (PostgREST PGRST205; Postgres 42P01). */
const viewMissing = (error: { code?: string } | null) => error?.code === "PGRST205" || error?.code === "42P01";

/** grant_number -> the public keys of that project's metadata, for the given projects (every project
 *  when none are given). Empty, not an error, when neither read is allowed. */
export async function fetchPublicProjectMetadata(grantNumbers?: string[]): Promise<Map<string, PublicProjectMetadata>> {
  const out = new Map<string, PublicProjectMetadata>();
  if (grantNumbers && grantNumbers.length === 0) return out;
  let query = (supabase.from("project_metadata_public" as any) as any).select("grant_number, metadata");
  if (grantNumbers) query = query.in("grant_number", grantNumbers);
  let { data, error } = await query;
  if (viewMissing(error)) {
    let fallback = (supabase.from("projects") as any)
      // before 20261118120000 only: the view does not exist yet, and anon may still read the column
      .select("grant_number, metadata");
    if (grantNumbers) fallback = fallback.in("grant_number", grantNumbers);
    const before = await fallback;
    error = before.error;
    data = (before.data ?? []).map((row: { grant_number: string | null; metadata: unknown }) => ({
      grant_number: row.grant_number, metadata: publicSubset(row.metadata),
    }));
  }
  if (error) {
    console.warn("public project metadata:", error.message);
    return out;
  }
  for (const row of (data ?? []) as { grant_number: string | null; metadata: PublicProjectMetadata | null }[]) {
    if (row.grant_number) out.set(row.grant_number, row.metadata ?? {});
  }
  return out;
}
