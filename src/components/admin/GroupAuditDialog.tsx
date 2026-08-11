import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, ShieldCheck, Wrench, AlertTriangle, UserMinus, BellOff, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { edgeError } from "@/lib/edgeError";

type Summary = Record<string, { expected: number; in_google: number; missing: number; extra: number }>;
type Result = { ok?: boolean; summary?: Summary; missing_by_group?: Record<string, string[]>; extra_by_group?: Record<string, string[]>; dismissed_by_group?: Record<string, string[]>; protected_by_group?: Record<string, string[]>; additive_only_groups?: string[]; repaired?: number; removed?: number; removed_from?: string; failures?: string[]; error?: string };

/** Audit ACTUAL Google Group membership vs what the KG implies, and optionally repair.
 *  Necessary because working_groups is an intent record: the sync trigger only fires on
 *  UPDATE (never INSERT), only when the value changed, and pg_net failures are silent. */
export function GroupAuditDialog() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result | null>(null);

  const run = async (action: "audit" | "repair" | "remove_extra", group?: string) => {
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("group-audit", { body: { action, group } });
      if (error) throw new Error(await edgeError(error, data));
      const r = (data ?? {}) as Result;
      setRes(r);
      if (r.error) toast.error(r.error);
      else if (action === "repair") toast.success(`Added ${r.repaired ?? 0} missing membership(s)`);
      else if (action === "remove_extra") toast.success(`Removed ${r.removed ?? 0} from ${r.removed_from}`);
      else {
        const miss = Object.values(r.summary ?? {}).reduce((a, v) => a + v.missing, 0);
        toast[miss ? "warning" : "success"](miss ? `${miss} missing membership(s) found` : "All groups in sync");
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Audit failed");
    } finally {
      setBusy(false);
    }
  };

  /** Record that a flagged member may stay (or undo that), then re-audit so the lists move.
   *  A dismissal is scoped to ONE group and stamped with the member's current role, so it lapses
   *  if their role changes — an admin judged the person as the KG then described them. */
  const setDismissed = async (group: string, email: string, dismiss: boolean, reason?: string) => {
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc(
        (dismiss ? "dismiss_group_audit_entry" : "undismiss_group_audit_entry") as any,
        dismiss
          ? { _group_email: group, _member_email: email, _reason: reason ?? null }
          : { _group_email: group, _member_email: email },
      );
      if (error) throw new Error(await edgeError(error, data));
      toast.success(dismiss ? `Dismissed ${email}` : `Restored ${email} to the review list`);
      await run("audit");
    } catch (e: any) {
      toast.error(e?.message ?? "Could not update the dismissal");
    } finally {
      setBusy(false);
    }
  };

  const totalMissing = Object.values(res?.summary ?? {}).reduce((a, v) => a + v.missing, 0);

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) setRes(null); }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline"><ShieldCheck className="mr-1.5 h-4 w-4" />Audit groups</Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Google Group membership audit</DialogTitle>
          <DialogDescription>
            Compares LIVE Google Group membership against what the knowledge graph implies
            (role + working groups). The KG's <code className="text-xs">working_groups</code> is an
            intent record — the sync trigger only fires on update, never on insert — so drift is expected.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {!res ? (
            <p className="text-sm text-muted-foreground">Run the audit to see per-group drift. It writes nothing.</p>
          ) : res.summary ? (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="text-left p-2 font-medium">Group</th>
                    <th className="text-right p-2 font-medium">Expected</th>
                    <th className="text-right p-2 font-medium">In Google</th>
                    <th className="text-right p-2 font-medium">Missing</th>
                    <th className="text-right p-2 font-medium">Extra</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(res.summary).map(([g, v]) => (
                    <tr key={g} className="border-t border-border">
                      <td className="p-2 font-mono text-xs">{g}</td>
                      <td className="p-2 text-right">{v.expected}</td>
                      <td className="p-2 text-right">{v.in_google}</td>
                      <td className={`p-2 text-right font-medium ${v.missing ? "text-destructive" : "text-emerald-600 dark:text-emerald-400"}`}>{v.missing}</td>
                      <td className={`p-2 text-right font-medium ${v.extra ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"}`}>{v.extra}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {res?.missing_by_group && totalMissing > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">Show the {totalMissing} missing address(es)</summary>
              <div className="mt-2 space-y-2">
                {Object.entries(res.missing_by_group).filter(([, v]) => v.length).map(([g, v]) => (
                  <div key={g}>
                    <div className="font-mono text-[11px] text-foreground">{g}</div>
                    <div className="text-muted-foreground">{v.join(", ")}</div>
                  </div>
                ))}
              </div>
            </details>
          )}

          {res?.extra_by_group && Object.values(res.extra_by_group).some((v) => v.length) && (
            <details className="text-xs" open>
              <summary className="cursor-pointer text-amber-600 dark:text-amber-400">
                In the group but NOT entitled — review for removal
              </summary>
              <p className="mt-1 text-muted-foreground">
                These are consortium members the KG does not entitle to the group (e.g. co-investigators
                on pi@, which is roster-derived). Removal is per-group and explicit — it never runs as
                part of Repair, and it skips owners, managers, service accounts and nested groups.
              </p>
              <div className="mt-2 space-y-2">
                {Object.entries(res.extra_by_group).filter(([, v]) => v.length).map(([g, v]) => (
                  <div key={g} className="rounded border border-border p-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-mono text-[11px] text-foreground">{g} — {v.length}</div>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={busy}
                        onClick={() => {
                          if (confirm(`Remove ${v.length} member(s) from ${g}?

This is a real Google Group removal. Only consortium members with plain MEMBER status are affected — owners, managers, service accounts and nested groups are never touched.`)) {
                            run("remove_extra", g);
                          }
                        }}
                      >
                        <UserMinus className="mr-1.5 h-3.5 w-3.5" />Remove {v.length}
                      </Button>
                    </div>
                    {/* One row per address so a judgement can be recorded per PERSON. Dismissing is
                        the answer to an entry that is neither clearly wrong nor removable — without
                        it the only way to clear the list is to remove someone. */}
                    <ul className="mt-1.5 divide-y divide-border">
                      {v.map((email) => (
                        <li key={email} className="flex items-center justify-between gap-2 py-1">
                          <span className="font-mono text-[11px] text-muted-foreground break-all">{email}</span>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 shrink-0 px-2 text-[11px]"
                            disabled={busy}
                            onClick={() => {
                              const reason = prompt(`Keep ${email} on ${g}?\n\nOptional note (why this is fine):`);
                              if (reason === null) return;   // cancelled
                              setDismissed(g, email, true, reason);
                            }}
                          >
                            <BellOff className="mr-1 h-3 w-3" />Dismiss
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </details>
          )}

          {res?.dismissed_by_group && Object.values(res.dismissed_by_group).some((v) => v.length) && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                Reviewed and kept —{" "}
                {Object.values(res.dismissed_by_group).reduce((a, v) => a + v.length, 0)}
              </summary>
              <p className="mt-1 text-muted-foreground">
                Entries an admin judged acceptable. They are excluded from the review list and from
                Remove, so a bulk removal can never sweep them up. A dismissal lapses if the
                member's role changes — the judgement was made about the role they held then.
              </p>
              <div className="mt-2 space-y-2">
                {Object.entries(res.dismissed_by_group).filter(([, v]) => v.length).map(([g, v]) => (
                  <div key={g} className="rounded border border-border p-2">
                    <div className="font-mono text-[11px] text-foreground">{g} — {v.length}</div>
                    <ul className="mt-1.5 divide-y divide-border">
                      {v.map((email) => (
                        <li key={email} className="flex items-center justify-between gap-2 py-1">
                          <span className="font-mono text-[11px] text-muted-foreground break-all">{email}</span>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 shrink-0 px-2 text-[11px]"
                            disabled={busy}
                            onClick={() => setDismissed(g, email, false)}
                          >
                            <RotateCcw className="mr-1 h-3 w-3" />Undo
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </details>
          )}

          {res?.protected_by_group && Object.values(res.protected_by_group).some((v) => v.length) && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                In the group, not KG-entitled, not proposed for removal —{" "}
                {Object.values(res.protected_by_group).reduce((a, v) => a + v.length, 0)}
              </summary>
              <p className="mt-1 text-muted-foreground">
                Shown for visibility only, with no action attached: service accounts, nested groups,
                owners and managers, roles the KG cannot classify, and every member of an
                additive-only group. An address here with no knowledge-graph record is worth
                following up — they receive consortium mail while being invisible to every roster,
                reminder and offboarding path.
              </p>
              <div className="mt-2 space-y-2">
                {Object.entries(res.protected_by_group).filter(([, v]) => v.length).map(([g, v]) => (
                  <div key={g} className="rounded border border-border p-2">
                    <div className="font-mono text-[11px] text-foreground">
                      {g} — {v.length}
                      {res.additive_only_groups?.includes(g) && (
                        <span className="ml-1.5 font-sans text-muted-foreground">
                          (additive-only: membership is never revoked here)
                        </span>
                      )}
                    </div>
                    <div className="text-muted-foreground break-all mt-1">{v.join(", ")}</div>
                  </div>
                ))}
              </div>
            </details>
          )}

          {res?.failures?.length ? (
            <div className="rounded-md border border-destructive/40 p-2 text-xs text-destructive">
              <div className="flex items-center gap-1.5 font-medium"><AlertTriangle className="h-3.5 w-3.5" />Some additions failed</div>
              <ul className="mt-1 list-disc pl-4">{res.failures.slice(0, 8).map((f, i) => <li key={i}>{f}</li>)}</ul>
            </div>
          ) : null}

          {totalMissing > 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Repair ADDS {totalMissing} membership(s) — real Google Group additions. It never removes anyone.
            </p>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => run("audit")} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><ShieldCheck className="mr-1.5 h-4 w-4" />Run audit</>}
          </Button>
          <Button onClick={() => run("repair")} disabled={busy || !res || totalMissing === 0}>
            <Wrench className="mr-1.5 h-4 w-4" />Repair {totalMissing || ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
