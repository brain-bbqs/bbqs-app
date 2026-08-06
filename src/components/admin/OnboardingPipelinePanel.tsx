import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useUserTier } from "@/hooks/useUserTier";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, Lock, AlertTriangle, RefreshCw } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

// A row of the onboarding_pipeline view (migration 20260806140000). Queried untyped
// (the view isn't in the generated Database types yet).
type PipelineRow = {
  id: string;
  name: string | null;
  email: string;
  role: string | null;
  working_groups: string[] | null;
  created_at: string;
  checklist: Record<string, string> | null;
  live_grant_count: number;
  days_since_created: number;
  steps_done: number;
  steps_total: number;
  is_stuck: boolean;
};

// Persisted checklist stages (meta keys pre_check/status/offboarded_at are excluded server-side).
const STAGE_ORDER = [
  "kg_created",
  "grant_link",
  "consortium_group",
  "pi_group",
  "young_investigators_group",
  "wg_groups",
  "welcome_email",
  "data_questionnaire",
  "slack",
] as const;

const STAGE_LABELS: Record<string, string> = {
  kg_created: "KG record",
  grant_link: "Grant",
  consortium_group: "Consortium",
  pi_group: "PI list",
  young_investigators_group: "Young inv.",
  wg_groups: "WGs",
  welcome_email: "Welcome",
  data_questionnaire: "Questionnaire",
  slack: "Slack",
};

const stageClass = (status: string | undefined): string => {
  if (status === "done") return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30";
  if (status === "pending" || status === "queued") return "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30";
  return "bg-muted text-muted-foreground border-border";
};

type Filter = "all" | "in_progress" | "stuck";

export function OnboardingPipelinePanel({ embedded }: { embedded?: boolean } = {}) {
  const tier = useUserTier();
  const [filter, setFilter] = useState<Filter>("all");

  const { data: rows = [], isLoading, isRefetching, refetch } = useQuery({
    queryKey: ["onboarding-pipeline"],
    enabled: tier.isCurator,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("onboarding_pipeline" as any)
        .select("*")
        .order("is_stuck", { ascending: false })
        .order("days_since_created", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as PipelineRow[];
    },
  });

  const filtered = useMemo(() => {
    if (filter === "stuck") return rows.filter((r) => r.is_stuck);
    if (filter === "in_progress") return rows.filter((r) => r.steps_done > 0);
    return rows;
  }, [rows, filter]);

  const stuckCount = useMemo(() => rows.filter((r) => r.is_stuck).length, [rows]);

  if (tier.isLoading) {
    return <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>;
  }
  if (!tier.isCurator) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 py-8 text-muted-foreground">
          <Lock className="h-5 w-5" />
          Reviewer access required — this panel is for admins and curators.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className={embedded ? "" : "max-w-6xl mx-auto px-4 py-8"}>
      {!embedded && (
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-foreground mb-1">Onboarding pipeline</h1>
          <p className="text-sm text-muted-foreground">Members with onboarding in progress and the stages still remaining.</p>
        </div>
      )}

      {/* KPI counters */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
        <Card><CardContent className="py-4">
          <div className="text-2xl font-bold text-foreground">{rows.length}</div>
          <div className="text-xs text-muted-foreground">In pipeline</div>
        </CardContent></Card>
        <Card><CardContent className="py-4">
          <div className={`text-2xl font-bold ${stuckCount > 0 ? "text-destructive" : "text-foreground"}`}>{stuckCount}</div>
          <div className="text-xs text-muted-foreground">Stuck (&gt;14 days)</div>
        </CardContent></Card>
        <Card><CardContent className="py-4">
          <div className="text-2xl font-bold text-foreground">
            {rows.length ? Math.round((rows.reduce((a, r) => a + (r.steps_total ? r.steps_done / r.steps_total : 0), 0) / rows.length) * 100) : 0}%
          </div>
          <div className="text-xs text-muted-foreground">Avg. completion</div>
        </CardContent></Card>
      </div>

      {/* Filters + refresh */}
      <div className="flex items-center gap-2 mb-3">
        {(["all", "in_progress", "stuck"] as Filter[]).map((f) => (
          <Button key={f} size="sm" variant={filter === f ? "default" : "outline"} onClick={() => setFilter(f)}>
            {f === "all" ? "All" : f === "in_progress" ? "In progress" : "Stuck"}
          </Button>
        ))}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => refetch()} disabled={isRefetching}>
          <RefreshCw className={`h-4 w-4 ${isRefetching ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
      ) : filtered.length === 0 ? (
        <Card><CardContent className="py-8 text-center text-muted-foreground text-sm">
          No members {filter === "stuck" ? "are stuck" : filter === "in_progress" ? "in progress" : "in the onboarding pipeline"}.
        </CardContent></Card>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                <TableHead>Role</TableHead>
                <TableHead className="whitespace-nowrap">Progress</TableHead>
                <TableHead>Remaining stages</TableHead>
                <TableHead className="whitespace-nowrap">In flight</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((r) => {
                const checklist = r.checklist ?? {};
                const stages = STAGE_ORDER.filter((k) => k in checklist);
                return (
                  <TableRow key={r.id} className={r.is_stuck ? "bg-destructive/5" : undefined}>
                    <TableCell>
                      <div className="font-medium text-foreground">{r.name ?? "(no name)"}</div>
                      <div className="text-xs text-muted-foreground">{r.email}</div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground whitespace-nowrap">{r.role ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      <div className="text-sm font-medium">{r.steps_done}/{r.steps_total}</div>
                      <div className="h-1.5 w-24 rounded-full bg-muted mt-1">
                        <div
                          className="h-1.5 rounded-full bg-primary"
                          style={{ width: `${r.steps_total ? (r.steps_done / r.steps_total) * 100 : 0}%` }}
                        />
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {stages.map((k) => (
                          <span
                            key={k}
                            className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] leading-none ${stageClass(checklist[k])}`}
                            title={`${STAGE_LABELS[k] ?? k}: ${checklist[k]}`}
                          >
                            {STAGE_LABELS[k] ?? k}
                          </span>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm">
                      {r.is_stuck && (
                        <span className="inline-flex items-center gap-1 text-destructive font-medium">
                          <AlertTriangle className="h-3.5 w-3.5" /> stuck
                        </span>
                      )}
                      <div className="text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
