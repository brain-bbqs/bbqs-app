// Columns that exist only once a hand-applied migration has run.
//
// Migrations here are applied by hand in the SQL editor, so the live database can lack a column the
// code already knows. A select that NAMES a missing column is refused whole (PostgREST 400, code
// 42703: "column investigators_public.onboarded does not exist"), where select("*") just returned
// the rows without it. Since 20261117190000 these views must be read by named columns, so a missing
// optional column would take the whole page down. On 2026-11-18 production's investigators_public
// had no `onboarded` (20261008120000 was not applied), and the People page and the person summary
// both named it.
//
// selectWithOptionalColumns asks for the optional columns too, and when the database says one does
// not exist it asks again without that one. The rows then simply lack the field, which every caller
// must already tolerate ("code must degrade gracefully when a migration has not been applied yet").
// tests/guards/optional-columns holds every reader of a registered column to this helper.
import { supabase } from "@/integrations/supabase/client";

/** object -> { column: the migration that adds it }. */
export const OPTIONAL_COLUMNS: Record<string, Record<string, string>> = {
  investigators_public: { onboarded: "20261008120000_people_page_onboarded_members" },
};

type Result<T> = { data: T | null; error: { code?: string; message?: string } | null };

/**
 * select `required` plus `optional` from `object`; drop an optional column the database lacks and
 * retry. `refine` adds the filters and modifiers (eq, single, order ...) to the query.
 */
export async function selectWithOptionalColumns<T = any>(
  object: string,
  required: string,
  optional: readonly string[],
  refine: (query: any) => PromiseLike<Result<T>> = (query) => query,
): Promise<Result<T>> {
  let extra = [...optional];
  for (;;) {
    const res = await refine((supabase.from(object as any) as any).select([required, ...extra].join(", ")));
    const gone = res.error?.code === "42703"
      ? /column (?:[\w"]+\.)?"?(\w+)"? does not exist/.exec(res.error.message ?? "")?.[1]
      : undefined;
    if (!gone || !extra.includes(gone)) return res;
    console.warn(`${object}: column ${gone} does not exist in this database yet; read without it`);
    extra = extra.filter((column) => column !== gone);
  }
}
