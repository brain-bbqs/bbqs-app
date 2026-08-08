import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, ShieldCheck, Wrench, AlertTriangle, UserMinus } from "lucide-react";
import { toast } from "sonner";
import { edgeError } from "@/lib/edgeError";

type Summary = Record<string, { expected: number; in_google: number; missing: number; extra: number }>;
type Result = { ok?: boolean; summary?: Summary; missing_by_group?: Record<string, string[]>; extra_by_group?: Record<string, string[]>; repaired?: number; removed?: number; removed_from?: string; failures?: string[]; error?: string };

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
