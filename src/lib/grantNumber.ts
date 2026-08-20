/** NIH project numbers arrive decorated: an application-type digit in front (1 = new, 5 = noncompeting
 *  continuation, 2 = renewal) and a support-year suffix behind — 5R34DA059510-02. The stable core is
 *  what identifies the project across years.
 *
 *  ANYTHING COMPARING GRANT NUMBERS FROM TWO SOURCES MUST REDUCE BOTH THROUGH THIS. The /projects
 *  species column was blank for four grants because the lookup normalized the row but not the map
 *  key, so a grant that had rolled from application type 1 to 5 silently matched nothing. A
 *  one-sided normalize looks correct until the fiscal year turns over.
 *
 *  Mirrors normalizeGrantNumber in the add-project-by-grant edge function and normalize_grant_number
 *  in KG migration 20260810170000. Three copies is two too many, but they live in three runtimes;
 *  this is the single copy for the browser bundle.
 */
export const coreGrantNumber = (raw: string | null | undefined): string =>
  (raw ?? "").trim().toUpperCase().replace(/-\d+$/, "").replace(/^\d+/, "");
