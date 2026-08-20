/** Per-cell provenance for one entity: where each field's current value came from, and how much
 *  that source can be trusted (Constitution v1.8.1, Principles X and XI).
 *
 *  WHY THIS IS READ SEPARATELY from the entity itself: provenance is RLS-restricted to admins and
 *  curators, while the project record is public. A single joined query would either leak provenance
 *  or fail for signed-out visitors, so it is its own query that is allowed to come back empty.
 *
 *  EMPTY IS NOT AN ERROR. Three different situations produce no rows -- the viewer is not staff, the
 *  migration has not been applied in this environment, or the cell genuinely has no claim -- and the
 *  UI must degrade to "show nothing extra" in all three rather than rendering a scary marker on
 *  every field. `available` distinguishes "we could read it" from "there was nothing to read".
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface FieldProvenance {
  entity_column: string;
  source_class: string;
  source_rank: number;
  source_label: string;
  agent_kind: "human" | "machine" | "external_registry";
  is_verified: boolean;
  activity: string;
  agent_label: string | null;
  source_ref: string | null;
  value_text: string | null;
  evidence: string | null;
  model_id: string | null;
  confidence: number | null;
  recorded_at: string;
  recorded_by: string | null;
  claim_count: number;
  /** Added by migration 20260819140000; absent in environments still on the earlier schema. */
  authored_at?: string | null;
  authored_at_precision?: string | null;
}

export interface ProvenanceLookup {
  /** Look up a field by its UI key. Handles both plain columns and metadata JSON paths. */
  get: (fieldKey: string) => FieldProvenance | undefined;
  all: FieldProvenance[];
  /** True when the provenance store was readable at all — i.e. the viewer is staff. */
  available: boolean;
  isLoading: boolean;
}

const EMPTY: FieldProvenance[] = [];

export function useFieldProvenance(entityTable: string, entityId?: string): ProvenanceLookup {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["field-provenance", entityTable, entityId],
    enabled: !!entityId,
    staleTime: 5 * 60 * 1000,
    retry: false, // A denial is a permanent answer for this viewer, not a transient failure.
    queryFn: async () => {
      const { data, error } = await supabase
        .from("field_provenance_current")
        .select("*")
        .eq("entity_table", entityTable)
        .eq("entity_id", entityId!);
      // RLS returns an empty set rather than an error for a non-staff viewer, but a missing table or
      // view (an environment behind on migrations) does error. Both mean "no provenance to show".
      if (error) throw error;
      return (data ?? []) as unknown as FieldProvenance[];
    },
  });

  const rows = isError ? EMPTY : (data ?? EMPTY);
  const byColumn = new Map<string, FieldProvenance>();
  for (const r of rows) byColumn.set(r.entity_column, r);

  return {
    // A UI field key is bare (`study_species`, `behavioral_data_formats`); a provenance row addresses
    // either a real column or a key inside the metadata blob. Try the plain name first so a genuine
    // column always wins over a same-named JSON key.
    get: (fieldKey: string) => byColumn.get(fieldKey) ?? byColumn.get(`metadata.${fieldKey}`),
    all: rows,
    available: !isError && rows.length > 0,
    isLoading,
  };
}
