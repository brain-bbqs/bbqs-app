// The questionnaire answers a visitor may read: the keys of projects.metadata the public pages show,
// from the view project_metadata_public (supabase/migrations/20261118120000_privacy_round_two.sql).
//
// projects.metadata itself holds every answer, free text included, and only signed-in users may read
// it. A page that shows answers to everyone reads them here, so the same code works for a visitor and
// for a member, and before the migration is applied (the view is missing: the page shows no details
// rather than failing). A key a public page starts to show must be added to the view;
// tests/guards/anon-private-columns checks the keys the pages read against it.
import { supabase } from "@/integrations/supabase/client";

export type PublicProjectMetadata = Record<string, any>;

/** grant_number -> the public keys of that project's metadata, for the given projects (every project
 *  when none are given). Empty, not an error, when the view is missing or refuses. */
export async function fetchPublicProjectMetadata(grantNumbers?: string[]): Promise<Map<string, PublicProjectMetadata>> {
  const out = new Map<string, PublicProjectMetadata>();
  if (grantNumbers && grantNumbers.length === 0) return out;
  let query = (supabase.from("project_metadata_public" as any) as any).select("grant_number, metadata");
  if (grantNumbers) query = query.in("grant_number", grantNumbers);
  const { data, error } = await query;
  if (error) {
    // 42P01 / PGRST205 before 20261118120000 is applied. The pages around this degrade to "no details".
    console.warn("project_metadata_public:", error.message);
    return out;
  }
  for (const row of (data ?? []) as { grant_number: string | null; metadata: PublicProjectMetadata | null }[]) {
    if (row.grant_number) out.set(row.grant_number, row.metadata ?? {});
  }
  return out;
}
