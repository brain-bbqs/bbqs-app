/**
 * Shared helper used by both `nih-grants` (bulk refresh) and
 * `add-project-by-grant` (single-grant import) to keep the
 * `grant_investigators` PI roster in sync with NIH RePORTER.
 *
 * Contract:
 *   - RePORTER is the source of truth for PI / contact-PI / co-PI status.
 *   - Curator-added rows (role_source='curator') are NEVER overwritten,
 *     even if RePORTER also lists that person — the curator's intent wins.
 *   - Rows previously seeded by RePORTER (role_source='reporter') are
 *     refreshed to match the current RePORTER role.
 *   - Investigators dropped from RePORTER are NOT removed (we never delete
 *     team members automatically — curators may have linked them on purpose).
 *
 * The caller is responsible for ensuring the investigator + organization
 * rows exist; this helper only manages the grant_investigators link rows.
 */

const PI_LIKE = new Set(["pi", "contact_pi", "co_pi", "mpi"]);

export interface ReporterPi {
  /** Investigator UUID in our `investigators` table. */
  investigatorId: string;
  /** Display name (for logging only). */
  name: string;
  /** Whether RePORTER flagged this person as the contact PI. */
  isContactPi: boolean;
}

export interface SyncResult {
  inserted: number;
  promoted: number;
  preserved_curator: number;
  unchanged: number;
}

/**
 * Upsert the RePORTER PI roster for a single grant.
 * Returns counts so the caller can log what happened.
 */
export async function syncReporterPis(
  supabase: any,
  grantId: string,
  grantNumber: string,
  reporterPis: ReporterPi[],
): Promise<SyncResult> {
  const result: SyncResult = {
    inserted: 0,
    promoted: 0,
    preserved_curator: 0,
    unchanged: 0,
  };

  for (const pi of reporterPis) {
    if (!pi.investigatorId) continue;
    const desiredRole = pi.isContactPi ? "contact_pi" : "co_pi";

    const { data: existing } = await supabase
      .from("grant_investigators")
      .select("role, role_source")
      .eq("grant_id", grantId)
      .eq("investigator_id", pi.investigatorId)
      .maybeSingle();

    if (!existing) {
      const { error } = await supabase
        .from("grant_investigators")
        .insert({
          grant_id: grantId,
          investigator_id: pi.investigatorId,
          role: desiredRole,
          role_source: "reporter",
        });
      if (error) {
        console.error(
          `[grant-sync] failed to insert ${pi.name} on ${grantNumber}:`,
          error.message,
        );
      } else {
        result.inserted++;
        console.log(`[grant-sync] +${pi.name} -> ${grantNumber} (${desiredRole})`);
      }
      continue;
    }

    // Curator already touched this row — leave it alone, full stop.
    if (existing.role_source === "curator") {
      result.preserved_curator++;
      continue;
    }

    // Row was seeded by RePORTER previously. Re-sync to current RePORTER role.
    if (existing.role !== desiredRole) {
      // Only ever promote; never demote a PI-like role unless RePORTER
      // explicitly says contact_pi (in which case desiredRole already reflects it).
      const isPromotionToContact = desiredRole === "contact_pi";
      const isCurrentlyPiLike = PI_LIKE.has((existing.role || "").toLowerCase());
      // EXCEPTION — contact_pi is a SINGLETON. RePORTER marks exactly one PI per project with
      // is_contact_pi, so "this row says contact_pi but RePORTER says they are not" is not a
      // curator's judgement to protect, it is a stale fact that no later sync could ever correct.
      // Blanket never-demote made a wrong contact_pi permanent: 1R61MH138967 carried TWO
      // contact_pi rows (Ghuman, correct per RePORTER, and Neimat, wrong), both role_source
      // 'reporter'. Neimat went co_pi -> contact_pi on 2026-08-08 in the same instant another
      // contact_pi row was deleted -- a merge that let the incoming role win -- and every
      // re-import afterwards left it alone by design. Curator rows are still untouchable; this
      // only re-syncs rows RePORTER itself seeded.
      const isStaleContactPi = existing.role === "contact_pi" && desiredRole !== "contact_pi";
      if (!isCurrentlyPiLike || isPromotionToContact || isStaleContactPi) {
        const { error } = await supabase
          .from("grant_investigators")
          .update({ role: desiredRole, role_source: "reporter" })
          .eq("grant_id", grantId)
          .eq("investigator_id", pi.investigatorId);
        if (!error) {
          result.promoted++;
          console.log(
            `[grant-sync] ~${pi.name} on ${grantNumber}: ${existing.role} -> ${desiredRole}`,
          );
        }
      } else {
        result.unchanged++;
      }
    } else {
      result.unchanged++;
    }
  }

  return result;
}

export { PI_LIKE };