import { useEffect, useState } from "react";
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

          {stage === "data_questionnaire" && (
            <>
              <p className="text-sm text-muted-foreground">
                The data questionnaire is <strong>PI-owned</strong> and filled per project. Ask the PI
                to complete it from their project page, or check status via the agent.
              </p>
              <Button variant="secondary" onClick={() => askAgent(`What is the data questionnaire status for ${target.email}?`)}>
                <ExternalLink className="mr-1.5 h-4 w-4" />Check questionnaire status
              </Button>
            </>
          )}

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
