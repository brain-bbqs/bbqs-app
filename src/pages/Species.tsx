"use client";

import { useState, useMemo } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { useHashState } from "@/hooks/useHashState";
import { MobileCardList } from "@/components/MobileCardList";
import { AgGridReact } from "ag-grid-react";
import type { ColDef } from "ag-grid-community";
import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-alpine.css";
import { useMarrProjects } from "@/hooks/useMarrProjects";
import { useQuery } from "@tanstack/react-query";
import { coreGrantNumber } from "@/lib/grantNumber";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { useEntitySummary } from "@/contexts/EntitySummaryContext";
import { SpeciesHeatmap } from "@/components/diagrams/SpeciesHeatmap";
import { Table, Grid3X3 } from "lucide-react";
import "@/styles/ag-grid-theme.css";

interface ProjectInfo {
  name: string;
  grantId: string;
}

interface SpeciesRow {
  species: string;
  latinName: string;
  projects: ProjectInfo[];
  behaviors: string[];
  color: string;
  projectCount: number;
  /** "2/3" — projects under this species whose species value someone stands behind. Empty when the
   *  viewer cannot read the provenance store, in which case the column is hidden entirely. */
  sourced: string;
}

const getProjectTitle = (shortName: string) => {
  const parts = shortName.split(" – ");
  return parts.length > 1 ? parts.slice(1).join(" – ").trim() : shortName;
};

const SpeciesBadge = ({ value, data }: { value: string; data: SpeciesRow }) => {
  const { open } = useEntitySummary();

  const openSpecies = async () => {
    const { data: sp } = await supabase
      .from("species")
      .select("id, resource_id")
      .or(`common_name.ilike.${value},name.ilike.${value}`)
      .maybeSingle();
    if (sp) {
      open({ type: "species", id: sp.id, resourceId: sp.resource_id || undefined, label: value });
    }
  };

  return (
    <button
      onClick={openSpecies}
      className="inline-flex items-center gap-1.5 font-semibold text-sm text-primary hover:underline cursor-pointer"
    >
      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: data.color }} />
      {value}
      <Badge variant="secondary" className="text-[10px] ml-1">{data.projectCount}</Badge>
    </button>
  );
};

const ProjectLinks = ({ data }: { value: any; data: SpeciesRow }) => {
  const { open } = useEntitySummary();

  const openGrant = async (grantId: string, name: string) => {
    const cleanId = grantId.replace(/^\d(?=[A-Z])/, "");
    const { data: grant } = await supabase
      .from("grants")
      .select("id, resource_id")
      .eq("grant_number", cleanId)
      .maybeSingle();
    if (grant) {
      open({ type: "grant", id: grant.id, resourceId: grant.resource_id || undefined, label: name });
    }
  };

  return (
    <div className="flex flex-col gap-1 py-1">
      {data.projects.map((p) => (
        <button
          key={p.grantId}
          onClick={() => openGrant(p.grantId, p.name)}
          className="text-primary hover:underline font-medium cursor-pointer text-sm text-left"
        >
          {p.name}
        </button>
      ))}
    </div>
  );
};

const BehaviorBadges = ({ data }: { value: any; data: SpeciesRow }) => {
  if (!data.behaviors.length) return null;
  return (
    <div className="flex flex-wrap gap-1 py-1">
      {data.behaviors.map((item) => (
        <Badge key={item} variant="secondary" className="text-[10px] font-normal whitespace-nowrap">
          {item}
        </Badge>
      ))}
    </div>
  );
};

export default function Species() {
  const { projects, loading } = useMarrProjects();

  // Species come from the CANONICAL view, not from the raw study_species strings. Reading the raw
  // values put five spellings of Homo sapiens on this page as five species, listed "Interacting
  // Animals" and "Freely moving animals" among them, and invented a species called Unknown out of
  // one project's empty field. The vocabulary lives in species_aliases so the agent agrees with the
  // site about what a species is.
  const { data: canonical = [] } = useQuery({
    queryKey: ["project-species-canonical"],
    staleTime: 60 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("project_species" as any)
        .select("project_id, grant_number, recorded_value, canonical_name, kind, common_name, note");
      if (error) throw error;
      return (data ?? []) as unknown as {
        project_id: string; grant_number: string | null; recorded_value: string | null;
        canonical_name: string | null; kind: string; common_name: string | null; note: string | null;
      }[];
    },
  });
  const [quickFilterText, setQuickFilterText] = useState("");
  const [view] = useHashState<"table" | "heatmap">("table", ["table", "heatmap"] as const);

  // Provenance for the species field of every project, so each species row can say how much of it
  // is vouched for. A single chip makes no sense here: a species row spans several projects, each
  // with its own claim. Empty for non-staff (RLS), and the column then simply does not render.
  const { data: speciesProv = [] } = useQuery({
    queryKey: ["species-field-provenance"],
    staleTime: 60 * 60 * 1000,
    retry: false,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("field_provenance_current" as any)
        .select("entity_id, is_verified, source_label")
        .eq("entity_table", "projects")
        .eq("entity_column", "study_species");
      if (error) throw error;
      return (data ?? []) as unknown as { entity_id: string; is_verified: boolean; source_label: string }[];
    },
  });

  const provByProject = useMemo(
    () => new Map(speciesProv.map((r) => [r.entity_id, r])),
    [speciesProv],
  );

  /** Real species only, deduplicated by canonical name. */
  const rows: SpeciesRow[] = useMemo(() => {
    const byGrant = new Map(projects.map((p) => [coreGrantNumber(p.id), p]));
    const grouped = new Map<string, { commonName: string; projects: ProjectInfo[]; behaviors: Set<string>; color: string; assumed: boolean; note: string | null }>();

    for (const c of canonical) {
      // Anything that is not a species does not belong in a list of species. It is reported
      // separately below rather than dropped, because "this project records no species" is a fact.
      if (c.kind !== "taxon" && c.kind !== "taxon_assumed") continue;
      const key = c.canonical_name || c.recorded_value || "";
      if (!key) continue;
      const p = byGrant.get(coreGrantNumber(c.grant_number));
      const project: ProjectInfo = { name: p?.title || p?.shortName || c.grant_number || "", grantId: p?.id || c.grant_number || "" };

      const existing = grouped.get(key);
      if (existing) {
        if (!existing.projects.some((ep) => ep.grantId === project.grantId)) existing.projects.push(project);
        (p?.computational ?? []).forEach((b) => existing.behaviors.add(b));
        existing.assumed = existing.assumed || c.kind === "taxon_assumed";
      } else {
        grouped.set(key, {
          commonName: c.common_name || "",
          projects: [project],
          behaviors: new Set(p?.computational ?? []),
          color: p?.color || "#90a4ae",
          assumed: c.kind === "taxon_assumed",
          note: c.note,
        });
      }
    }

    return Array.from(grouped.entries()).map(([latinName, data]) => ({
      sourced: (() => {
        const ids = canonical
          .filter((c) => (c.canonical_name || c.recorded_value) === latinName)
          .map((c) => c.project_id);
        const known = ids.filter((id) => provByProject.has(id));
        if (known.length === 0) return "";
        const ok = known.filter((id) => provByProject.get(id)!.is_verified).length;
        return `${ok}/${known.length}`;
      })(),
      species: data.commonName
        ? `${data.commonName.charAt(0).toUpperCase()}${data.commonName.slice(1)}`
        : latinName,
      latinName: data.assumed ? `${latinName} (assumed)` : latinName,
      projects: data.projects,
      behaviors: Array.from(data.behaviors),
      color: data.color,
      projectCount: data.projects.length,
    }));
  }, [projects, canonical]);

  /** Values recorded in the species field that are not species. Shown, not hidden: a project whose
   *  species field says "Interacting Animals" has a data problem someone should fix, and burying it
   *  is how it survived this long. */
  const notSpecies = useMemo(
    () =>
      canonical
        .filter((c) => c.kind !== "taxon" && c.kind !== "taxon_assumed")
        .map((c) => ({
          grant: c.grant_number ?? "",
          value: c.recorded_value,
          kind: c.kind,
          note: c.note,
        }))
        .sort((a, b) => a.kind.localeCompare(b.kind) || (a.value ?? "").localeCompare(b.value ?? "")),
    [canonical],
  );

  const defaultColDef = useMemo<ColDef>(
    () => ({ sortable: true, resizable: true, unSortIcon: true, wrapText: true, autoHeight: true }),
    []
  );

  const columnDefs = useMemo<ColDef<SpeciesRow>[]>(
    () => [
      { field: "species", headerName: "Species", width: 180, cellRenderer: SpeciesBadge },
      // Only rendered when the provenance store is readable; a column of blanks tells nobody
      // anything, and a column that reads 0/3 tells a curator exactly where to look.
      ...(speciesProv.length > 0
        ? [{
            field: "sourced",
            headerName: "Vouched for",
            width: 110,
            headerTooltip: "Projects under this species whose species value a person or registry stands behind",
            cellRenderer: ({ value }: { value: string }) => {
              if (!value) return <span className="text-muted-foreground">—</span>;
              const [ok, total] = value.split("/").map(Number);
              return (
                <span className={ok === 0 ? "text-amber-600 dark:text-amber-400" : ok === total ? "" : "text-muted-foreground"}>
                  {value}
                </span>
              );
            },
          } as ColDef<SpeciesRow>]
        : []),
      { field: "latinName", headerName: "Taxonomy", width: 200, cellStyle: { fontStyle: "italic" } },
      { field: "projects", headerName: "Projects", width: 300, cellRenderer: ProjectLinks,
        getQuickFilterText: (params) => params.data?.projects.map((p) => p.name).join(" ") || "" },
      { field: "behaviors", headerName: "Behaviors", flex: 1, minWidth: 300, cellRenderer: BehaviorBadges,
        getQuickFilterText: (params) => params.data?.behaviors.join(" ") || "" },
    ],
    // Depends on whether provenance is readable. With an empty deps array the conditional
    // "Vouched for" column is computed once, while the query is still in flight, and never appears.
    [speciesProv.length]
  );
  const isMobile = useIsMobile();

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-muted-foreground">Loading species data from YAML...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="px-6 py-8">
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-foreground mb-2">Species</h1>
          <p className="text-muted-foreground mb-4">
            Overview of species studied across BBQS consortium projects and the behaviors being investigated.
          </p>
          {/* Explorer tab hidden */}
          {view === "table" && (
          <div className="flex items-center gap-4 mb-4">
            <input
              type="text"
              placeholder="Filter by species, project, behavior..."
              value={quickFilterText}
              onChange={(e) => setQuickFilterText(e.target.value)}
              className="px-4 py-2 rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary w-full max-w-md"
            />
            <span className="text-sm text-muted-foreground whitespace-nowrap">
              {rows.length} species · {projects.length} projects
            </span>
          </div>
          )}
        </div>

        {view === "heatmap" ? (
          <SpeciesHeatmap />
        ) : isMobile ? (
          <MobileCardList
            items={rows
              .filter((r) => !quickFilterText || r.species.toLowerCase().includes(quickFilterText.toLowerCase()))
              .map((r) => ({
                id: r.species,
                title: r.species,
                fields: [
                  { label: "Latin Name", value: r.latinName || "—" },
                  { label: "Projects", value: String(r.projectCount) },
                  { label: "Behaviors", value: r.behaviors.join(", ") || "—" },
                ],
              }))}
            emptyMessage="No species found"
          />
        ) : (
          <div className="ag-theme-alpine rounded-lg border border-border overflow-hidden" style={{ width: "100%" }}>
            <AgGridReact<SpeciesRow>
              rowData={rows} columnDefs={columnDefs} defaultColDef={defaultColDef}
              quickFilterText={quickFilterText} animateRows={true} domLayout="autoHeight"
              suppressCellFocus={true} enableCellTextSelection={true} headerHeight={40}
            />
          </div>
        )}

        {notSpecies.length > 0 && (
          <div className="mt-6 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
            <p className="text-sm font-semibold">
              {notSpecies.length} record{notSpecies.length === 1 ? "" : "s"} something other than a species
            </p>
            <p className="text-xs text-muted-foreground mt-1 mb-3 max-w-2xl">
              These values sit in the species field but are not species — a grouping, a recording
              condition, or a placeholder. Listed here rather than among the species, which is what
              made this page appear to have an animal called “Interacting Animals”. The project
              questionnaire is the right place to fix them.
            </p>
            <div className="space-y-1">
              {notSpecies.map((n, i) => (
                <div key={`${n.grant}-${i}`} className="flex flex-wrap items-baseline gap-2 text-xs">
                  <span className="font-mono text-muted-foreground w-28 shrink-0">{n.grant}</span>
                  <span className="font-medium">{n.value ?? "— no species recorded —"}</span>
                  <Badge variant="outline" className="text-[10px] font-normal">{n.kind}</Badge>
                  {n.note && <span className="text-muted-foreground">{n.note}</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
