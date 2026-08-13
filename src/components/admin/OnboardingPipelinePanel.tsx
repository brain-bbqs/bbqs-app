import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useUserTier } from "@/hooks/useUserTier";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, Lock, AlertTriangle, RefreshCw, UserPlus, Bell } from "lucide-react";
import { ResolveGrantLinkDialog } from "@/components/admin/ResolveGrantLinkDialog";
import { ResolveStageDialog, type StageTarget } from "@/components/admin/ResolveStageDialog";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { edgeError } from "@/lib/edgeError";
import { OnboardMemberDialog } from "@/components/admin/OnboardMemberDialog";
import { useSortableTable } from "@/components/admin/useSortableTable";
import { GroupAuditDialog } from "@/components/admin/GroupAuditDialog";
import { SlackInvitesDialog } from "@/components/admin/SlackInvitesDialog";
import { OffboardMemberDialog } from "@/components/admin/OffboardMemberDialog";

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
  last_reminder_sent_at: string | null;
  reminder_count: number;
};

/** Don't nudge the same person more often than this. */
const REMINDER_COOLDOWN_DAYS = 7;
const daysSince = (iso: string | null) =>
  iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000) : null;

const STAGE_ORDER = [
  "kg_created", "grant_link", "consortium_group", "pi_group",
  "young_investigators_group", "wg_groups", "welcome_email", "data_questionnaire", "slack",
] as const;

const STAGE_LABELS: Record<string, string> = {
  kg_created: "KG record", grant_link: "Grant", consortium_group: "Consortium", pi_group: "PI list",
  young_investigators_group: "Young inv.", wg_groups: "WGs", welcome_email: "Welcome",
  data_questionnaire: "Questionnaire", slack: "Slack",
};

const isDone = (s: string | undefined) => s === "done" || s === "skipped";
const stageClass = (status: string | undefined): string => {
  if (status === "done") return "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30";
  if (status === "skipped") return "bg-slate-500/15 text-slate-500 border-slate-500/30 line-through";
  if (status === "pending" || status === "queued") return "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30";
  return "bg-muted text-muted-foreground border-border";
};

// "completed" reads a DIFFERENT source: onboarding_pipeline excludes finished members by design, so
// the graduates come from onboarding_completed. Kept as a filter rather than a separate tab so it
// reuses this table, its sorting and its stage badges — switching filters IS the tab affordance here.
type Filter = "all" | "in_progress" | "stuck" | "completed";
const remainingSteps = (r: PipelineRow) =>
  STAGE_ORDER.filter((k) => r.checklist && k in r.checklist && !isDone(r.checklist[k]));

export function OnboardingPipelinePanel({ embedded }: { embedded?: boolean } = {}) {
  const tier = useUserTier();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState(false);
  // Member whose grant_link is being RESOLVED (real association, not a checkbox).
  const [resolvingGrant, setResolvingGrant] = useState<{ id: string; name: string | null; email: string; role: string | null } | null>(null);
  // Any other stage → the generic resolver (WG membership, group re-sync, welcome, slack, …).
  const [resolvingStage, setResolvingStage] = useState<StageTarget | null>(null);

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

  // The graduates. Shaped to PipelineRow so the same table renders both: days_since_created carries
  // days_to_complete here (the column header switches to "Took"), and is_stuck is always false because
  // a completed member by definition has no required step open.
  const { data: completedRows = [] } = useQuery({
    queryKey: ["onboarding-completed"],
    enabled: tier.isCurator,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("onboarding_completed" as any)
        .select("*")
        .order("completed_at", { ascending: false });
      if (error) throw error;
      return (data ?? []).map((r: any) => ({
        ...r,
        days_since_created: r.days_to_complete ?? 0,
        is_stuck: false,
        last_reminder_sent_at: r.last_reminder_sent_at ?? null,
        reminder_count: r.reminder_count ?? 0,
      })) as unknown as PipelineRow[];
    },
  });

  const filtered = useMemo(() => {
    if (filter === "stuck") return rows.filter((r) => r.is_stuck);
    if (filter === "completed") return completedRows;
    if (filter === "in_progress") return rows.filter((r) => r.steps_done > 0);
    return rows;
    // completedRows belongs here: it is a separate query with its own 60s refetch, so omitting it
    // would freeze the Completed list at whatever the first render saw.
  }, [rows, completedRows, filter]);

  // Sorting sits OUTSIDE the filter so the two compose: filter to "stuck", then sort by Role to
  // group the PIs. Default order is unsorted (server order) until a header is clicked.
  const { sorted, SortableHead } = useSortableTable<PipelineRow>(filtered);
  const stuckCount = useMemo(() => rows.filter((r) => r.is_stuck).length, [rows]);
  // Everyone whose Slack step is still open — fed to the batch guest-invite triage.
  const slackPending = useMemo(
    () => rows.filter((r) => r.checklist && "slack" in r.checklist && !isDone(r.checklist.slack))
              .map((r) => ({ email: r.email, name: r.name, role: r.role, working_groups: r.working_groups })),
    [rows],
  );

  // Run an action, toast, refresh. Serialized via `busy` to avoid double-clicks.
  const act = async (fn: () => Promise<void>, ok: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      queryClient.invalidateQueries({ queryKey: ["onboarding-pipeline"] });
    } catch (e: any) {
      toast.error(e?.message ?? "Action failed");
    } finally {
      setBusy(false);
    }
  };


  const remind = (r: PipelineRow) =>
    act(async () => {
      const steps = remainingSteps(r);
      if (!steps.length) throw new Error("No remaining steps to remind about");
      const { data, error } = await supabase.functions.invoke("send-onboarding-reminder", { body: { to: r.email, name: r.name, steps } });
      if (error || (data as any)?.success === false) throw new Error(await edgeError(error, data));
      // Stamp it so the panel shows "reminded Nd ago" and the cooldown can bite.
      await supabase.rpc("record_onboarding_reminder", { _investigator_id: r.id });
    }, "Reminder sent");

  if (tier.isLoading) return <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>;
  if (!tier.isCurator) {
    return (
      <Card><CardContent className="flex items-center gap-3 py-8 text-muted-foreground">
        <Lock className="h-5 w-5" /> Reviewer access required — this panel is for admins and curators.
      </CardContent></Card>
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

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
        <Card><CardContent className="py-4"><div className="text-2xl font-bold text-foreground">{rows.length}</div><div className="text-xs text-muted-foreground">In pipeline</div></CardContent></Card>
        <Card><CardContent className="py-4"><div className={`text-2xl font-bold ${stuckCount > 0 ? "text-destructive" : "text-foreground"}`}>{stuckCount}</div><div className="text-xs text-muted-foreground">Stuck (&gt;14 days)</div></CardContent></Card>
        <Card><CardContent className="py-4"><div className="text-2xl font-bold text-foreground">{rows.length ? Math.round((rows.reduce((a, r) => a + (r.steps_total ? r.steps_done / r.steps_total : 0), 0) / rows.length) * 100) : 0}%</div><div className="text-xs text-muted-foreground">Avg. completion</div></CardContent></Card>
      </div>

      <div className="flex items-center gap-2 mb-3">
        {(["all", "in_progress", "stuck", "completed"] as Filter[]).map((f) => (
          <Button key={f} size="sm" variant={filter === f ? "default" : "outline"} onClick={() => setFilter(f)}>
            {f === "all" ? "All" : f === "in_progress" ? "In progress" : f === "stuck" ? "Stuck"
              : `Completed${completedRows.length ? ` (${completedRows.length})` : ""}`}
          </Button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <SlackInvitesDialog people={slackPending} />
          <GroupAuditDialog />
          <OnboardMemberDialog trigger={<Button size="sm"><UserPlus className="mr-1.5 h-4 w-4" />Onboard member</Button>} />
          <OffboardMemberDialog />
          <Button size="sm" variant="ghost" onClick={() => refetch()} disabled={isRefetching}><RefreshCw className={`h-4 w-4 ${isRefetching ? "animate-spin" : ""}`} /></Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
      ) : filtered.length === 0 ? (
        <Card><CardContent className="py-8 text-center text-muted-foreground text-sm">No members {filter === "stuck" ? "are stuck" : filter === "in_progress" ? "in progress" : filter === "completed" ? "have completed onboarding yet" : "in the onboarding pipeline"}.</CardContent></Card>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableHead columnKey="member" accessor={(r) => r.name ?? r.email}>Member</SortableHead>
                <SortableHead columnKey="role" accessor={(r) => r.role}>Role</SortableHead>
                <SortableHead columnKey="progress" className="whitespace-nowrap"
                  accessor={(r) => (r.steps_total ? r.steps_done / r.steps_total : 0)}>Progress</SortableHead>
                <SortableHead columnKey="remaining" accessor={(r) => remainingSteps(r).length}>
                  Remaining stages <span className="font-normal text-muted-foreground">(click to resolve)</span>
                </SortableHead>
                <SortableHead columnKey="in_flight" className="whitespace-nowrap"
                  accessor={(r) => r.days_since_created}>{filter === "completed" ? "Took" : "In flight"}</SortableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((r) => {
                const checklist = r.checklist ?? {};
                const stages = STAGE_ORDER.filter((k) => k in checklist);
                const hasRemaining = remainingSteps(r).length > 0;
                return (
                  <TableRow key={r.id} className={r.is_stuck ? "bg-destructive/5" : undefined}>
                    <TableCell>
                      <div className="font-medium text-foreground">{r.name ?? "(no name)"}</div>
                      <div className="text-xs text-muted-foreground">{r.email}</div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground whitespace-nowrap">{r.role ?? "—"}</TableCell>
                    <TableCell className="whitespace-nowrap">
                      <div className="text-sm font-medium">{r.steps_done}/{r.steps_total}</div>
                      <div className="h-1.5 w-24 rounded-full bg-muted mt-1"><div className="h-1.5 rounded-full bg-primary" style={{ width: `${r.steps_total ? (r.steps_done / r.steps_total) * 100 : 0}%` }} /></div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {stages.map((k) => {
                          const status = checklist[k];
                          const cls = `inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] leading-none ${stageClass(status)}`;
                          if (isDone(status)) return <span key={k} className={cls} title={`${STAGE_LABELS[k] ?? k}: ${status}`}>{STAGE_LABELS[k] ?? k}</span>;
                          // Every unresolved tag is a direct click → the resolver that actually
                          // fixes THAT stage (grant association, WG membership, group re-sync, …).
                          return (
                            <button
                              key={k}
                              disabled={busy}
                              className={`${cls} cursor-pointer hover:ring-1 hover:ring-ring`}
                              title={`${STAGE_LABELS[k] ?? k}: ${status} — click to resolve`}
                              onClick={() =>
                                k === "grant_link"
                                  ? setResolvingGrant({ id: r.id, name: r.name, email: r.email, role: r.role })
                                  : setResolvingStage({ stage: k, id: r.id, name: r.name, email: r.email, role: r.role, working_groups: r.working_groups })
                              }
                            >
                              {STAGE_LABELS[k] ?? k}
                            </button>
                          );
                        })}
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm">
                      {r.is_stuck && <span className="inline-flex items-center gap-1 text-destructive font-medium"><AlertTriangle className="h-3.5 w-3.5" /> stuck</span>}
                      <div className="text-xs text-muted-foreground">{formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}</div>
                    </TableCell>
                    <TableCell className="text-right">
                      {(() => {
                        const d = daysSince(r.last_reminder_sent_at);
                        const cooling = d !== null && d < REMINDER_COOLDOWN_DAYS;
                        return (
                          <div className="inline-flex flex-col items-end gap-0.5">
                            <Button
                              size="sm"
                              variant={cooling ? "ghost" : "outline"}
                              disabled={busy || !hasRemaining || cooling}
                              onClick={() => remind(r)}
                              title={
                                !hasRemaining ? "Nothing remaining"
                                : cooling ? `Reminded ${d === 0 ? "today" : `${d}d ago`} — wait ${REMINDER_COOLDOWN_DAYS - (d ?? 0)} more day(s)`
                                : "Email this member their remaining steps"
                              }
                            >
                              <Bell className="mr-1.5 h-3.5 w-3.5" />Remind
                            </Button>
                            <span className="text-[10px] text-muted-foreground">
                              {d === null
                                ? "never reminded"
                                : `${d === 0 ? "reminded today" : `reminded ${d}d ago`}${r.reminder_count > 1 ? ` ·${r.reminder_count}x` : ""}`}
                            </span>
                          </div>
                        );
                      })()}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <ResolveGrantLinkDialog member={resolvingGrant} onClose={() => setResolvingGrant(null)} />
      <ResolveStageDialog target={resolvingStage} onClose={() => setResolvingStage(null)} />
    </div>
  );
}
