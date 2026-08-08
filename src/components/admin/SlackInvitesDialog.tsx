import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, Slack, Copy, Check, UserPlus, Hash } from "lucide-react";
import { toast } from "sonner";
import { edgeError } from "@/lib/edgeError";

type Person = { email: string; name: string | null; role: string | null; working_groups: string[] | null };
type Row = { email: string; name: string | null; in_workspace: boolean; missing?: string[]; missing_ids?: string[]; reason?: string };
type Result = { ok?: boolean; checked?: number; needs_guest_invite?: Row[]; needs_channels?: Row[]; complete?: Row[]; error?: string };

/** Batch Slack triage: split everyone with an unfinished Slack step into
 *  (a) not in the workspace -> copy ALL their emails and send ONE group guest invite, and
 *  (b) in the workspace but missing channels -> add them all in one click. */
export function SlackInvitesDialog({ people }: { people: Person[] }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result | null>(null);
  const [copied, setCopied] = useState(false);

  const check = async () => {
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("slack-channels", {
        body: { action: "bulk_check", people },
      });
      if (error) throw new Error(await edgeError(error, data));
      const r = (data ?? {}) as Result;
      if (r.error) throw new Error(r.error);
      setRes(r);
      toast.success(`Checked ${r.checked ?? 0} member(s)`);
    } catch (e: any) {
      toast.error(e?.message ?? "Slack check failed");
    } finally {
      setBusy(false);
    }
  };

  const guests = res?.needs_guest_invite ?? [];
  const chans = res?.needs_channels ?? [];

  const copyEmails = async () => {
    const list = guests.map((g) => g.email).join(", ");
    try {
      await navigator.clipboard.writeText(list);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
      toast.success(`${guests.length} email(s) copied — paste into Slack's invite box`);
    } catch {
      toast.error("Could not copy — select the list and copy manually");
    }
  };

  const addAllChannels = async () => {
    setBusy(true);
    let ok = 0;
    const failed: string[] = [];
    try {
      for (const p of chans) {
        const { data, error } = await supabase.functions.invoke("slack-channels", {
          body: { email: p.email, role: people.find((x) => x.email === p.email)?.role,
                 working_groups: people.find((x) => x.email === p.email)?.working_groups ?? [], action: "invite" },
        });
        if (error || (data as any)?.ok === false) failed.push(`${p.email}: ${(data as any)?.error ?? "failed"}`);
        else ok++;
      }
      toast[failed.length ? "warning" : "success"](
        failed.length ? `Added ${ok}, ${failed.length} failed` : `Added ${ok} member(s) to their channels`,
      );
      if (failed.length) console.warn("slack add failures:", failed);
      queryClient.invalidateQueries({ queryKey: ["onboarding-pipeline"] });
      await check();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setRes(null); setCopied(false); } }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline"><Slack className="mr-1.5 h-4 w-4" />Slack invites</Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Slack invites</DialogTitle>
          <DialogDescription>
            Checks everyone whose Slack step is unfinished ({people.length} member{people.length === 1 ? "" : "s"}) and splits
            them into those who still need a workspace guest invite and those who just need channels.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {!res ? (
            <p className="text-sm text-muted-foreground">Run the check to see who needs what. Nothing is sent.</p>
          ) : (
            <>
              {/* Needs a guest invite — the batch action */}
              <div className="rounded-md border border-amber-500/40 p-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="text-sm font-medium flex items-center gap-1.5">
                    <UserPlus className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                    Not in Slack yet — {guests.length}
                  </div>
                  {guests.length > 0 && (
                    <Button size="sm" onClick={copyEmails}>
                      {copied ? <><Check className="mr-1.5 h-3.5 w-3.5" />Copied</> : <><Copy className="mr-1.5 h-3.5 w-3.5" />Copy all emails</>}
                    </Button>
                  )}
                </div>
                {guests.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Everyone is already in the workspace.</p>
                ) : (
                  <>
                    <p className="text-xs text-muted-foreground mb-2">
                      Copy these, then in Slack: <strong>Invite people</strong> → paste the whole list → send one group invite.
                    </p>
                    <div className="text-xs font-mono bg-muted rounded p-2 max-h-32 overflow-y-auto break-all">
                      {guests.map((g) => g.email).join(", ")}
                    </div>
                  </>
                )}
              </div>

              {/* Already in the workspace, just missing channels */}
              <div className="rounded-md border border-border p-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="text-sm font-medium flex items-center gap-1.5">
                    <Hash className="h-4 w-4 text-primary" />
                    In Slack, missing channels — {chans.length}
                  </div>
                  {chans.length > 0 && (
                    <Button size="sm" variant="secondary" onClick={addAllChannels} disabled={busy}>
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Add all to channels"}
                    </Button>
                  )}
                </div>
                {chans.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Nobody is missing a channel.</p>
                ) : (
                  <ul className="text-xs space-y-1">
                    {chans.map((c) => (
                      <li key={c.email} className="text-muted-foreground">
                        <span className="text-foreground">{c.name ?? c.email}</span> — missing {(c.missing ?? []).join(", ")}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {(res.complete ?? []).length > 0 && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400">
                  {(res.complete ?? []).length} already fully set up in Slack.
                </p>
              )}
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={check} disabled={busy || people.length === 0}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Check Slack status"}
          </Button>
          <Button onClick={() => setOpen(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
