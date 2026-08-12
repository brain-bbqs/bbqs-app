import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Check, RefreshCw, ExternalLink, SkipForward, Mail, Search, Hash } from "lucide-react";
import { toast } from "sonner";
import { edgeError } from "@/lib/edgeError";

const AGENT_URL = "https://agent.brain-bbqs.org";
const WORKING_GROUPS = [
  { token: "WG-Analytics", label: "Analytics" },
  { token: "WG-Devices", label: "Devices" },
  { token: "WG-ELSI", label: "ELSI" },
  { token: "WG-Standards", label: "Standards" },
];

export type StageTarget = {
  stage: string;
  id: string;
  name: string | null;
  email: string;
  role: string | null;
  working_groups: string[] | null;
};

const STAGE_TITLES: Record<string, string> = {
  wg_groups: "Working groups",
  consortium_group: "Consortium mailing list",
  pi_group: "PI mailing list",
  young_investigators_group: "Young-investigators list",
  slack: "Slack access",
  data_questionnaire: "Data questionnaire",
  kg_created: "Knowledge-graph record",
  welcome_email: "Welcome email",
};

const GROUP_STAGES = new Set(["consortium_group", "pi_group", "young_investigators_group"]);

/** Resolve ANY onboarding stage with the real action, not a checkbox:
 *  wg_groups → set the member's groups (trigger provisions the mailing lists);
 *  *_group   → re-run the Google-Group sync from live role/WG state;
 *  welcome   → send the email; slack → hand off to the agent; questionnaire → PI-owned link. */
export function ResolveStageDialog({ target, onClose }: { target: StageTarget | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [wgs, setWgs] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  /** Last slack-channels result: { not_in_workspace | in_channels/missing | invited/failed }. */
  const [slackInfo, setSlackInfo] = useState<Record<string, any> | null>(null);

  useEffect(() => {
    setWgs(new Set((target?.working_groups ?? []).filter(Boolean)));
    setSlackInfo(null);
  }, [target]);

  if (!target) return null;
  const stage = target.stage;
  const who = target.name ?? target.email;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["onboarding-pipeline"] });

  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    try { await fn(); toast.success(ok); refresh(); onClose(); }
    catch (e: any) { toast.error(e?.message ?? "Action failed"); }
    finally { setBusy(false); }
  };

  const markStep = async (status: "done" | "skipped") => {
    const { error } = await supabase.rpc("set_onboarding_step", {
      _investigator_id: target.id, _step: stage, _status: status,
    });
    if (error) throw error;
  };

  // wg_groups: write the real membership (trg_sync_member_groups provisions wg-*@ lists).
  const saveWorkingGroups = () =>
    run(async () => {
      const { data, error } = await supabase.rpc("approve_working_groups", {
        _investigator_id: target.id, _groups: [...wgs],
      });
      if (error || (data as any)?.ok === false) throw new Error(await edgeError(error, data));
      await markStep("done");
    }, "Working groups updated — mailing lists syncing");

  // *_group: re-assert membership from live role/working_groups (additive; never removes).
  const resyncGroups = () =>
    run(async () => {
      const { data, error } = await supabase.functions.invoke("sync-member-groups", {
        body: {
          email: target.email,
          old: { working_groups: [], role: null },
          new: { working_groups: target.working_groups ?? [], role: target.role },
        },
      });
      if (error || (data as any)?.ok === false) throw new Error(await edgeError(error, data));
      await markStep("done");
    }, "Mailing-list membership re-synced");

  const sendWelcome = () =>
    run(async () => {
      const { data, error } = await supabase.functions.invoke("send-welcome-email", {
        body: { to: target.email, name: target.name, role: target.role },
      });
      if (error || (data as any)?.success === false) throw new Error(await edgeError(error, data));
      await markStep("done");
    }, "Welcome email sent");

  // Slack: check membership / add to the configured channels via the KG slack-channels
  // function. Deliberately does NOT close the dialog — the admin needs to read the result
  // (e.g. "not in the workspace yet — send a guest invite first").
  const callSlack = async (action: "check" | "invite") => {
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("slack-channels", {
        body: { email: target.email, role: target.role, working_groups: target.working_groups ?? [], action },
      });
      if (error) throw new Error(await edgeError(error, data));
      const res = (data ?? {}) as Record<string, any>;
      setSlackInfo(res);
      if (res.not_in_workspace) toast.warning("Not in the Slack workspace yet — invite them as a guest first");
      else if (res.error) toast.error(res.error);
      else if (action === "invite") {
        await markStep("done");
        toast.success(res.invited?.length ? `Added to ${res.invited.length} channel(s)` : "Already in all channels");
        refresh();
      } else {
        toast.success(res.missing?.length ? `Missing ${res.missing.length} channel(s)` : "Already in all channels");
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Slack call failed");
    } finally {
      setBusy(false);
    }
  };
  const checkSlack = () => callSlack("check");
  const inviteSlack = () => callSlack("invite");

  const askAgent = (cmd: string) => {
    window.open(`${AGENT_URL}/?ask=${encodeURIComponent(cmd)}`, "_blank", "noopener");
  };

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{STAGE_TITLES[stage] ?? stage}</DialogTitle>
          <DialogDescription>Resolve this step for <strong>{who}</strong>.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {stage === "wg_groups" && (
            <>
              <p className="text-sm text-muted-foreground">
                Set their working groups. Saving updates the record and automatically adds/removes
                them from the matching <code className="text-xs">wg-*@brain-bbqs.org</code> lists.
              </p>
              <div className="flex flex-wrap gap-3">
                {WORKING_GROUPS.map((wg) => (
                  <label key={wg.token} className="flex items-center gap-1.5 text-sm cursor-pointer">
                    <Checkbox
                      checked={wgs.has(wg.token)}
                      onCheckedChange={() =>
                        setWgs((p) => { const n = new Set(p); n.has(wg.token) ? n.delete(wg.token) : n.add(wg.token); return n; })
                      }
                    />
                    {wg.label}
                  </label>
                ))}
              </div>
              <Button onClick={saveWorkingGroups} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Check className="mr-1.5 h-4 w-4" />Save &amp; sync groups</>}
              </Button>
            </>
          )}

          {GROUP_STAGES.has(stage) && (
            <>
              <p className="text-sm text-muted-foreground">
                Re-run the Google-Group sync from their live role and working groups. This adds any
                missing memberships (it never removes).
              </p>
              <Button onClick={resyncGroups} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><RefreshCw className="mr-1.5 h-4 w-4" />Re-sync mailing lists</>}
              </Button>
            </>
          )}

          {stage === "welcome_email" && (
            <>
              <p className="text-sm text-muted-foreground">Send (or re-send) the role-tailored welcome email.</p>
              <Button onClick={sendWelcome} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Mail className="mr-1.5 h-4 w-4" />Send welcome email</>}
              </Button>
            </>
          )}

          {stage === "slack" && (
            <>
              <p className="text-sm text-muted-foreground">
                Adds them to the configured onboarding channels (postdocs and grad students also get
                the young-investigator channel). Workspace entry itself can't be automated — an
                external guest must be invited to Slack manually first; this reports that plainly.
              </p>
              {slackInfo && (
                <div className="rounded-md border border-border p-2.5 text-xs space-y-0.5">
                  {slackInfo.not_in_workspace ? (
                    <p className="text-amber-600 dark:text-amber-400">{slackInfo.error}</p>
                  ) : slackInfo.error ? (
                    <p className="text-destructive">{slackInfo.error}</p>
                  ) : (
                    <>
                      <p className="text-foreground">
                        In workspace{slackInfo.is_young_investigator ? " · young investigator (gets the YI channel too)" : ""}
                      </p>
                      {(slackInfo.in_channels ?? slackInfo.already_in ?? []).length > 0 && (
                        <p className="text-emerald-600 dark:text-emerald-400">
                          Already in: {(slackInfo.in_channels ?? slackInfo.already_in ?? []).join(", ")}
                        </p>
                      )}
                      {(slackInfo.missing ?? []).length > 0 && (
                        <p className="text-amber-600 dark:text-amber-400">
                          Missing: {(slackInfo.missing ?? []).join(", ")}
                        </p>
                      )}
                      {(slackInfo.invited ?? []).length > 0 && (
                        <p className="text-emerald-600 dark:text-emerald-400">
                          Added: {(slackInfo.invited ?? []).join(", ")}
                        </p>
                      )}
                      {(slackInfo.target ?? []).length > 0 && (
                        <p className="text-muted-foreground">
                          Should be in: {(slackInfo.target ?? []).join(", ")}
                        </p>
                      )}
                    </>
                  )}
                </div>
              )}
              <div className="flex gap-2">
                <Button variant="secondary" onClick={checkSlack} disabled={busy}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Search className="mr-1.5 h-4 w-4" />Check status</>}
                </Button>
                <Button onClick={inviteSlack} disabled={busy}>
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Hash className="mr-1.5 h-4 w-4" />Add to channels</>}
                </Button>
              </div>
            </>
          )}

          {stage === "data_questionnaire" && <QuestionnaireStatus email={target.email} />}

          {stage === "kg_created" && (
            <p className="text-sm text-muted-foreground">
              Their knowledge-graph record exists (they appear in this pipeline). Mark it done if the
              flag is stale.
            </p>
          )}

          <div className="border-t border-border pt-3 flex gap-2">
            <Button variant="outline" size="sm" onClick={() => run(() => markStep("done"), "Marked done")} disabled={busy}>
              <Check className="mr-1.5 h-3.5 w-3.5" />Mark done (manual)
            </Button>
            <Button variant="ghost" size="sm" onClick={() => run(() => markStep("skipped"), "Dismissed")} disabled={busy}>
              <SkipForward className="mr-1.5 h-3.5 w-3.5" />Not needed
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Deterministic Data Questionnaire status, read from project_questionnaire_status.
 *
 *  This used to open the CHAT AGENT with "What is the data questionnaire status for <email>?" — an
 *  exact question handed to an LLM, whose answer then came from projects.metadata_completeness, a
 *  column reading 86 for almost every project regardless of content. The console already knows the
 *  member, so it can resolve grant → project → the ten canonical fields itself and say which are
 *  blank. Percentages here are COMPUTED, never the stored column.
 */
function QuestionnaireStatus({ email }: { email: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["questionnaire-status", email],
    queryFn: async () => {
      // Their grants, then the status row per grant. A member can be on several; a scalar answer
      // would have to pick one arbitrarily, so show them all.
      const { data: inv, error: e1 } = await supabase
        .from("investigators").select("id").ilike("email", email).maybeSingle();
      if (e1) throw e1;
      if (!inv) return [];
      const { data: rows, error: e2 } = await supabase
        .from("grant_investigators").select("grant_id, role").eq("investigator_id", inv.id);
      if (e2) throw e2;
      const ids = (rows ?? []).map((r) => r.grant_id);
      if (!ids.length) return [];
      const { data: st, error: e3 } = await supabase
        .from("project_questionnaire_status").select("*").in("grant_id", ids);
      if (e3) throw e3;
      return st ?? [];
    },
  });

  if (isLoading) return <div className="flex justify-center py-3"><Loader2 className="h-4 w-4 animate-spin text-primary" /></div>;
  if (error) return <p className="text-sm text-destructive">Could not read questionnaire status: {(error as Error).message}</p>;
  if (!data?.length) {
    return (
      <p className="text-sm text-muted-foreground">
        They are on no grant roster, so there is no project questionnaire for them. Link a grant first.
      </p>
    );
  }

  const STANDING: Record<string, { label: string; cls: string }> = {
    pi:             { label: "submitted by a PI on this grant",        cls: "text-emerald-600 dark:text-emerald-400" },
    project_member: { label: "submitted by a project member, not a PI", cls: "text-amber-600 dark:text-amber-400" },
    not_on_roster:  { label: "submitter is NOT on this grant's roster", cls: "text-destructive" },
    unknown:        { label: "submitter unknown — imported before provenance was recorded", cls: "text-muted-foreground" },
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        The questionnaire is <strong>contact-PI-owned</strong> and filled per project. Percentages are
        computed from the ten canonical fields, not from the stored completeness column.
      </p>
      {data.map((q: any) => {
        const st = STANDING[q.submitter_standing] ?? STANDING.unknown;
        return (
          <div key={q.grant_id} className="rounded-md border border-border p-3 text-xs space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[11px] text-foreground">{q.grant_number}</span>
              <span className={q.status === "complete" ? "text-emerald-600 dark:text-emerald-400"
                : q.status === "partial" ? "text-amber-600 dark:text-amber-400" : "text-destructive"}>
                {q.status.replace("_", " ")} · {q.fields_filled}/{q.fields_total} ({q.pct}%)
              </span>
            </div>
            {q.owner_name && (
              <div className="text-muted-foreground">Owner (contact PI): {q.owner_name}{q.owner_email ? ` — ${q.owner_email}` : ""}</div>
            )}
            <div className={st.cls}>
              {q.submitted_by ? `${q.submitted_by} — ${st.label}` : st.label}
              {q.submitted_at ? ` (${new Date(q.submitted_at).toLocaleDateString()})` : ""}
            </div>
            {q.missing_fields?.length ? (
              <div className="text-muted-foreground">
                Still blank: <span className="break-all">{q.missing_fields.join(", ")}</span>
              </div>
            ) : null}
            {/* Open the actual form. The URL comes from the view (public.questionnaire_form_url), not
                a constant here, so the console, the agent and any reminder cannot drift apart. */}
            {/* THE SUBMISSION ITSELF. An admin reviewing a questionnaire wants to read the answers;
                the blank responder form shows an empty questionnaire and is only useful for sending
                to a PI who has not filled it. Answers come from the imported response in
                projects.metadata, so this works with no Google call. */}
            {answerEntries(q.answers).length > 0 && (
              <details className="pt-1">
                <summary className="cursor-pointer text-foreground">
                  Read the {answerEntries(q.answers).length} submitted answer(s)
                </summary>
                <dl className="mt-1.5 space-y-1.5 max-h-64 overflow-y-auto pr-1">
                  {answerEntries(q.answers).map(([k, v]) => (
                    <div key={k}>
                      <dt className="text-muted-foreground">{k.replace(/_/g, " ")}</dt>
                      <dd className="text-foreground break-words">{formatAnswer(v)}</dd>
                    </div>
                  ))}
                </dl>
              </details>
            )}
            <div className="flex flex-wrap gap-2 pt-1">
              <Button size="sm" variant="secondary" className="h-7 text-[11px]" asChild>
                <a href={q.responses_url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="mr-1 h-3 w-3" />All responses in Google Forms
                </a>
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-[11px]" asChild>
                <a href={q.form_url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="mr-1 h-3 w-3" />Blank form (to send)
                </a>
              </Button>
              {q.owner_email && (
                <Button size="sm" variant="ghost" className="h-7 text-[11px]" asChild>
                  <a
                    href={`mailto:${q.owner_email}?subject=${encodeURIComponent(
                      `BBQS Data Questionnaire — ${q.grant_number}`,
                    )}&body=${encodeURIComponent(
                      `Hi ${(q.owner_name ?? "").split(" ")[0] || "there"},

` +
                        `The BBQS Data Questionnaire for ${q.grant_number} is ${q.status.replace("_", " ")} ` +
                        `(${q.fields_filled} of ${q.fields_total} sections answered).

` +
                        (q.missing_fields?.length
                          ? `Still needed: ${q.missing_fields.join(", ")}

`
                          : "") +
                        `You can complete it here: ${q.form_url}

Thanks,
`,
                    )}`}
                  >
                    <Mail className="mr-1 h-3 w-3" />Email the owner
                  </a>
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Populated answers only, in a stable order. A key present with '' / [] / {} is not an answer. */
function answerEntries(answers: unknown): Array<[string, unknown]> {
  if (!answers || typeof answers !== "object") return [];
  return Object.entries(answers as Record<string, unknown>)
    .filter(([, v]) =>
      v !== null && v !== undefined &&
      !(typeof v === "string" && v.trim() === "") &&
      !(Array.isArray(v) && v.length === 0))
    .sort(([a], [b]) => a.localeCompare(b));
}

/** Render an answer the way the respondent gave it: checkbox groups are arrays, Yes/No are booleans. */
function formatAnswer(v: unknown): string {
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
}
