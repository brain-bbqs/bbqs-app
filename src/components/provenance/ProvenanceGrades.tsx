/** The curator's view of information grades: how much of the record is vouched for, and a queue of
 *  what is not.
 *
 *  GROUPED BY RECORD, not by cell. A curator opens an investigator and checks it; they do not check
 *  "investigators.orcid" in isolation and then go looking for the next orphaned field. A flat list of
 *  ten thousand cells is a report — something you scroll, feel bad about, and close. Grouping by
 *  record makes a unit of work that can be finished, and "mark this record reviewed" is then a single
 *  honest action rather than thirty clicks.
 *
 *  WORST FIRST, and capped. The queue asks for the worst-graded cells and stops at a few hundred:
 *  the point is the next hour of work, not an inventory. The coverage strip above it is what says
 *  whether the hour helped.
 */
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useUserTier } from "@/hooks/useUserTier";
import {
  ShieldCheck, ShieldAlert, ChevronRight, ChevronDown, Check, Loader2, Search, Bot,
} from "lucide-react";
import { cn } from "@/lib/utils";

const QUEUE_LIMIT = 400;

interface CoverageRow {
  table_name: string;
  cells: number | null;
  verified: number | null;
  unverified: number | null;
  pct_verified: number | null;
}

interface WorklistRow {
  entity_table: string;
  entity_id: string;
  entity_column: string;
  source_class: string;
  source_grade: number | null;
  source_label: string;
  value_text: string | null;
  agent_label: string | null;
  record_label: string;
}

const GRADE_TONE = (g: number | null) =>
  g == null ? "text-muted-foreground"
    : g >= 7 ? "text-amber-600 dark:text-amber-400"
    : g >= 5 ? "text-violet-600 dark:text-violet-400"
    : "text-muted-foreground";

export function ProvenanceGrades() {
  const { isCurator } = useUserTier();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  // field_provenance is RLS-restricted to admins and curators, and the views are security_invoker,
  // so anyone else gets EMPTY SETS rather than an error. Without this check the page would say
  // "nothing unverified in scope" to a member who simply cannot see it — the most misleading
  // possible reading, and the exact inversion (absence looking like good news) that Principle XI
  // exists to prevent.
  const coverage = useQuery({
    queryKey: ["provenance-coverage"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("provenance_coverage" as any)
        .select("*")
        .order("unverified", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as CoverageRow[];
    },
  });

  const worklist = useQuery({
    queryKey: ["provenance-worklist"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("provenance_worklist" as any)
        .select("*")
        // Worst grade first: an unrecorded source (G8) is more urgent than a machine extraction.
        .order("source_grade", { ascending: false })
        .order("entity_table")
        .limit(QUEUE_LIMIT);
      if (error) throw error;
      return (data ?? []) as unknown as WorklistRow[];
    },
  });

  const totals = useMemo(() => {
    const rows = coverage.data ?? [];
    const cells = rows.reduce((n, r) => n + (r.cells ?? 0), 0);
    const verified = rows.reduce((n, r) => n + (r.verified ?? 0), 0);
    return { cells, verified, pct: cells ? Math.round((1000 * verified) / cells) / 10 : 0 };
  }, [coverage.data]);

  /** One card per record, its unverified fields inside. */
  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const byKey = new Map<string, { table: string; id: string; label: string; rows: WorklistRow[] }>();
    for (const r of worklist.data ?? []) {
      if (q && !`${r.record_label} ${r.entity_table} ${r.entity_column}`.toLowerCase().includes(q)) continue;
      const key = `${r.entity_table}:${r.entity_id}`;
      if (!byKey.has(key)) {
        byKey.set(key, { table: r.entity_table, id: r.entity_id, label: r.record_label, rows: [] });
      }
      byKey.get(key)!.rows.push(r);
    }
    return [...byKey.entries()]
      .map(([key, g]) => ({ key, ...g }))
      .sort((a, b) => b.rows.length - a.rows.length);
  }, [worklist.data, filter]);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["provenance-worklist"] }),
      queryClient.invalidateQueries({ queryKey: ["provenance-coverage"] }),
      queryClient.invalidateQueries({ queryKey: ["field-provenance"] }),
    ]);
  };

  /** Records the curator as the source for these cells. The values do not change. */
  const markCells = async (busyKey: string, rows: WorklistRow[]) => {
    setBusy(busyKey);
    let ok = 0;
    const failures: string[] = [];
    for (const r of rows) {
      const { error } = await (supabase.rpc as any)("provenance_mark_verified", {
        _table: r.entity_table, _id: r.entity_id, _column: r.entity_column, _note: null,
      });
      if (error) failures.push(`${r.entity_column}: ${error.message}`);
      else ok += 1;
    }
    setBusy(null);
    await refresh();
    // Report partial success honestly rather than a blanket "done" — a curator needs to know if
    // three of thirty fields were refused, and why.
    if (failures.length) {
      toast({
        variant: "destructive",
        description: `Recorded ${ok} of ${rows.length}. ${failures[0]}${failures.length > 1 ? ` (+${failures.length - 1} more)` : ""}`,
      });
    } else {
      toast({ description: `Recorded ${ok} field${ok === 1 ? "" : "s"} as checked by you.` });
    }
  };

  if (coverage.isLoading || worklist.isLoading) {
    return <div className="p-6 space-y-3"><Skeleton className="h-16 w-full" /><Skeleton className="h-64 w-full" /></div>;
  }

  const err = (coverage.error ?? worklist.error) as Error | null;
  if (err) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Field grades are not available: {err.message}
        <p className="text-xs mt-1">
          This view needs the provenance migrations applied and admin or curator access.
        </p>
      </div>
    );
  }

  // The store is RLS-restricted to admins and curators, and provenance_coverage is readable by
  // anyone — it just reports zero cells for a viewer who cannot see field_provenance. So "rows came
  // back but every count is zero" means NOT READABLE, and saying "nothing unverified" there would be
  // the worst possible message: absence reading as good news, which is the inversion this whole
  // feature exists to remove. useUserTier cannot answer this, because its preview fallback reports
  // the local developer as an admin regardless of what the database thinks.
  if (totals.cells === 0) {
    return (
      <div className="p-10 text-center">
        <ShieldAlert className="h-5 w-5 mx-auto mb-2 text-muted-foreground" />
        <p className="text-sm font-medium">No field grades to show here</p>
        <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
          Either you are not an admin or curator — provenance records carry submitter addresses, so
          the store is restricted — or the provenance migrations have not been applied in this
          environment. This is not the same as everything being verified.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      {/* Coverage */}
      <div className="px-6 py-4 border-b border-border bg-card/50">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
          <div>
            <p className="text-2xl font-bold tabular-nums">{totals.pct}%</p>
            <p className="text-[11px] text-muted-foreground">
              of {totals.cells.toLocaleString()} fields have a human or registry behind them
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <ShieldCheck className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="tabular-nums">{totals.verified.toLocaleString()} vouched for</span>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <ShieldAlert className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
            <span className="tabular-nums">
              {(totals.cells - totals.verified).toLocaleString()} not
            </span>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {(coverage.data ?? []).filter((r) => (r.cells ?? 0) > 0).slice(0, 14).map((r) => (
            <Badge key={r.table_name} variant="outline" className="text-[10px] font-normal gap-1">
              {r.table_name}
              <span className={cn("tabular-nums", (r.pct_verified ?? 0) > 50 ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400")}>
                {r.pct_verified ?? 0}%
              </span>
            </Badge>
          ))}
        </div>
      </div>

      {/* Queue */}
      <div className="px-6 py-3 flex items-center gap-3 border-b border-border">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input value={filter} onChange={(e) => setFilter(e.target.value)}
                 placeholder="Filter by record, table or field..." className="pl-9 h-8 text-xs" />
        </div>
        <p className="text-[11px] text-muted-foreground">
          {groups.length} record{groups.length === 1 ? "" : "s"} · worst grade first
          {(worklist.data?.length ?? 0) >= QUEUE_LIMIT && ` · showing the first ${QUEUE_LIMIT} fields`}
        </p>
      </div>

      <div className="divide-y divide-border">
        {groups.length === 0 && (
          <p className="px-6 py-10 text-center text-sm text-muted-foreground">
            Nothing unverified in scope. {filter && "Try clearing the filter."}
          </p>
        )}

        {groups.map((g) => {
          const isOpen = open.has(g.key);
          const worst = Math.max(...g.rows.map((r) => r.source_grade ?? 0));
          return (
            <div key={g.key}>
              <div className="px-6 py-2.5 flex items-center gap-3 hover:bg-muted/40">
                <button className="flex items-center gap-2 flex-1 min-w-0 text-left"
                        onClick={() => setOpen((s) => {
                          const n = new Set(s);
                          n.has(g.key) ? n.delete(g.key) : n.add(g.key);
                          return n;
                        })}>
                  {isOpen ? <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                          : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                  <span className="text-sm font-medium truncate">{g.label}</span>
                  <span className="text-[11px] text-muted-foreground shrink-0">{g.table}</span>
                  <span className={cn("text-[11px] tabular-nums shrink-0", GRADE_TONE(worst))}>
                    {g.rows.length} field{g.rows.length === 1 ? "" : "s"} · worst G{worst}
                  </span>
                </button>
                {isCurator && (
                  <Button size="sm" variant="outline" className="h-7 text-xs shrink-0"
                          disabled={busy === g.key}
                          onClick={() => markCells(g.key, g.rows)}>
                    {busy === g.key ? <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                                    : <Check className="h-3 w-3 mr-1.5" />}
                    I have reviewed this record
                  </Button>
                )}
              </div>

              {isOpen && (
                <div className="px-6 pb-3 pl-14 space-y-1">
                  {g.rows.map((r) => (
                    <div key={r.entity_column} className="flex items-start gap-3 text-xs py-1">
                      <span className="font-mono text-muted-foreground w-56 shrink-0 truncate">
                        {r.entity_column}
                      </span>
                      <span className="flex-1 min-w-0 truncate">{r.value_text ?? "—"}</span>
                      <span className={cn("shrink-0 inline-flex items-center gap-1", GRADE_TONE(r.source_grade))}>
                        {r.source_class === "llm_extract" || r.source_class === "algorithmic"
                          ? <Bot className="h-3 w-3" /> : null}
                        G{r.source_grade} {r.source_label}
                      </span>
                      {isCurator && (
                        <button className="shrink-0 text-muted-foreground hover:text-foreground"
                                title="Record me as the source for this field"
                                disabled={busy === r.entity_column}
                                onClick={() => markCells(r.entity_column, [r])}>
                          {busy === r.entity_column
                            ? <Loader2 className="h-3 w-3 animate-spin" />
                            : <Check className="h-3 w-3" />}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
