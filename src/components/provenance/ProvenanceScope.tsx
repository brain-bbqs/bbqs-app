/** One provenance lookup per entity panel, so every field in it can show its grade without each
 *  summary component threading the lookup through by hand.
 *
 *  WHY A CONTEXT. Provenance chips existed only on the project profile, because that was the only
 *  place willing to call useFieldProvenance and pass the result down through its field components.
 *  Every other entity in the graph — people, publications, species, organizations, software,
 *  resources — rendered its fields with no indication of where any value came from. That is exactly
 *  the gap Principle XI exists to close: an unmarked value reads as fact, and most of the graph was
 *  unmarked.
 *
 *  Doing it per-field would mean one query per field. Doing it per-panel is one query for the whole
 *  entity, shared by every SummaryField inside it, and it costs each summary a single wrapper.
 *
 *  DEGRADES TO NOTHING. Outside a provider, useProvenanceScope returns an empty lookup and
 *  ProvenanceChip renders null — so a summary that has not been wired yet looks exactly as it does
 *  today rather than breaking. Same for a viewer without staff permission, whose query comes back
 *  empty by RLS.
 */
import { createContext, useContext, type ReactNode } from "react";
import { useFieldProvenance, type ProvenanceLookup } from "@/hooks/useFieldProvenance";

const EMPTY_LOOKUP: ProvenanceLookup = {
  get: () => undefined,
  all: [],
  available: false,
  isLoading: false,
};

const ProvenanceScopeContext = createContext<ProvenanceLookup>(EMPTY_LOOKUP);

/** Wrap an entity panel to give every field inside it access to that entity's provenance.
 *
 *  `table` must be the real KG table name, because that is what field_provenance.entity_table
 *  holds — 'investigators', not 'people'; 'software_tools', not 'software'. A wrong name is not an
 *  error, it silently matches nothing, which is why the ones in use are listed in
 *  tests/guards/provenance-scope-tables.test.mjs. */
export function ProvenanceScope({
  table,
  id,
  children,
}: {
  table: string;
  id?: string | null;
  children: ReactNode;
}) {
  const lookup = useFieldProvenance(table, id ?? undefined);
  return (
    <ProvenanceScopeContext.Provider value={lookup}>{children}</ProvenanceScopeContext.Provider>
  );
}

export function useProvenanceScope(): ProvenanceLookup {
  return useContext(ProvenanceScopeContext);
}
