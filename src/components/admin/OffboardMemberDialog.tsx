import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, UserMinus, Search, AlertTriangle, Check, X } from "lucide-react";
import { toast } from "sonner";
import { edgeError } from "@/lib/edgeError";

type Member = { id: string; name: string | null; email: string; role: string | null; working_groups: string[] | null };
type Roster = { grant_id: string; role: string | null; grants: { grant_number: string; title: string | null } | null };
type Outcome = {
  ok?: boolean; name?: string; email?: string; roster_rows_removed?: number;
  full_departure?: boolean; remaining_grants?: string[]; remaining_roles?: string[];
  groups_to_remove?: string[]; slack_removal_recommended?: boolean; error?: string;
};

/** Offboard = a member leaves ONE grant, multi-grant-safe. The record is never deleted (that is
 *  the agent's "reset", deliberately not exposed here). Removal of mailing lists is a separate,
 *  explicit second step so an outward-facing action is never a hidden side effect. */
export function OffboardMemberDialog() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [member, setMember] = useState<Member | null>(null);
  const [grantId, setGrantId] = useState<string | "ALL" | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [groupsDone, setGroupsDone] = useState(false);

  const { data: hits = [] } = useQuery({
    queryKey: ["offboard-member-search", q],
    enabled: open && q.trim().length >= 2 && !member,
    queryFn: async () => {
      const t = q.trim().replace(/[%,]/g, " ");
      const { data, error } = await supabase
        .from("investigator_directory")
        .select("id,name,email,role,working_groups")
        .or(`name.ilike.%${t}%,email.ilike.%${t}%`)
        .limit(8);
      if (error) throw error;
      return (data ?? []) as Member[];
    },
  });

  const { data: roster = [], isLoading: rosterLoading } = useQuery({
    queryKey: ["offboard-roster", member?.id],
    enabled: !!member,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("grant_investigators")
        .select("grant_id,role,grants(grant_number,title)")
        .eq("investigator_id", member!.id);
      if (error) throw error;
      return (data ?? []) as unknown as Roster[];
    },
  });

  const reset = () => { setQ(""); setMember(null); setGrantId(null); setOutcome(null); setGroupsDone(false); setBusy(false); };
  const close = () => { setOpen(false); reset(); };

  const offboard = async () => {
    if (!member || grantId === null) return;
    setBusy(true);
    try {
      const { data, error } = await supabase.rpc("offboard_member" as any, {
        _investigator_id: member.id,
        _grant_id: grantId === "ALL" ? null : grantId,
      });
      if (error) throw new Error(await edgeError(error, data));
      const o = (data ?? {}) as Outcome;
      if (o.error) throw new Error(o.error);
      setOutcome(o);
      toast.success(o.full_departure ? "Offboarded from the consortium" : "Removed from that grant");
      queryClient.invalidateQueries({ queryKey: ["onboarding-pipeline"] });
    } catch (e: any) {
      toast.error(e?.message ?? "Offboarding failed");
    } finally {
      setBusy(false);
    }
  };

  const removeGroups = async () => {
    if (!outcome?.groups_to_remove?.length || !outcome.email) return;
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("group-audit", {
        body: { action: "remove_groups", email: outcome.email, groups: outcome.groups_to_remove },
      });
      if (error) throw new Error(await edgeError(error, data));
      const r = (data ?? {}) as { removed_from?: string[]; skipped?: string[]; error?: string };
      if (r.error) toast.warning(`Partially done: ${r.error}`);
      else toast.success(`Removed from ${r.removed_from?.length ?? 0} group(s)`);
      setGroupsDone(true);
    } catch (e: any) {
      toast.error(e?.message ?? "Group removal failed");
    } finally {
      setBusy(false);
    }
  };

  const leavingLabel = grantId === "ALL"
    ? "the consortium (all grants)"
    : roster.find((r) => r.grant_id === grantId)?.grants?.grant_number ?? "—";

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline"><UserMinus className="mr-1.5 h-4 w-4" />Offboard</Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Offboard a member</DialogTitle>
          <DialogDescription>
            Removes them from a grant and from any access that grant justified. Access kept by a
            REMAINING grant is left alone, and the member record is never deleted.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Step 1 — pick the member */}
          {!member ? (
            <div>
              <Label htmlFor="ob-search">Member</Label>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                <Input id="ob-search" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or email…" autoComplete="off" />
              </div>
              {hits.length > 0 && (
                <div className="mt-1 rounded-md border border-border divide-y divide-border max-h-56 overflow-y-auto">
                  {hits.map((m) => (
                    <button key={m.id} type="button" onClick={() => setMember(m)} className="block w-full text-left px-3 py-2 text-sm hover:bg-muted">
                      <div className="text-foreground">{m.name ?? m.email}</div>
                      <div className="text-xs text-muted-foreground">{m.email}{m.role ? ` · ${m.role}` : ""}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
              <div>
                <div className="font-medium text-foreground">{member.name ?? member.email}</div>
                <div className="text-xs text-muted-foreground">{member.email}</div>
              </div>
              {!outcome && (
                <button type="button" onClick={reset} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
              )}
            </div>
          )}

          {/* Step 2 — what are they leaving */}
          {member && !outcome && (
            <div>
              <Label>Leaving</Label>
              {rosterLoading ? (
                <div className="flex justify-center py-3"><Loader2 className="h-4 w-4 animate-spin text-primary" /></div>
              ) : (
                <div className="space-y-1.5 mt-1">
                  {roster.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      They are on no grant roster — only a full departure applies.
                    </p>
                  )}
                  {roster.map((r) => (
                    <label key={r.grant_id} className="flex items-start gap-2 text-sm cursor-pointer rounded border border-border p-2 hover:bg-muted">
                      <input type="radio" name="leaving" className="mt-1" checked={grantId === r.grant_id} onChange={() => setGrantId(r.grant_id)} />
                      <span>
                        <span className="text-foreground">{r.grants?.title ?? r.grants?.grant_number}</span>
                        <span className="block text-xs text-muted-foreground font-mono">{r.grants?.grant_number} · {r.role}</span>
                      </span>
                    </label>
                  ))}
                  <label className="flex items-start gap-2 text-sm cursor-pointer rounded border border-destructive/40 p-2 hover:bg-muted">
                    <input type="radio" name="leaving" className="mt-1" checked={grantId === "ALL"} onChange={() => setGrantId("ALL")} />
                    <span>
                      <span className="text-foreground font-medium">Leaving the consortium entirely</span>
                      <span className="block text-xs text-muted-foreground">Removes every grant and all consortium access</span>
                    </span>
                  </label>
                </div>
              )}
            </div>
          )}

          {/* Step 3 — outcome + the explicit external step */}
          {outcome && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
                <Check className="h-4 w-4" />
                {outcome.full_departure
                  ? `${outcome.name ?? outcome.email} offboarded from the consortium.`
                  : `Removed from that grant (${outcome.roster_rows_removed} roster row(s)).`}
              </div>
              {!outcome.full_departure && (
                <p className="text-xs text-muted-foreground">
                  Still on: {(outcome.remaining_grants ?? []).join(", ") || "—"} · roles {(outcome.remaining_roles ?? []).join(", ") || "—"}.
                  Access justified by those is unchanged.
                </p>
              )}
              <div className="rounded-md border border-amber-500/40 p-3 text-xs space-y-2">
                <div className="font-medium text-foreground">Mailing lists no longer justified</div>
                {(outcome.groups_to_remove ?? []).length === 0 ? (
                  <p className="text-muted-foreground">None — nothing to remove.</p>
                ) : (
                  <>
                    <div className="text-muted-foreground break-all">{(outcome.groups_to_remove ?? []).join(", ")}</div>
                    {groupsDone ? (
                      <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400"><Check className="h-3.5 w-3.5" />Removed</span>
                    ) : (
                      <Button size="sm" variant="destructive" onClick={removeGroups} disabled={busy}>
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><UserMinus className="mr-1.5 h-3.5 w-3.5" />Remove from these groups</>}
                      </Button>
                    )}
                  </>
                )}
              </div>
              {outcome.slack_removal_recommended && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="inline h-3.5 w-3.5 mr-1" />
                  Slack removal is not automated — remove them from the workspace in Slack if appropriate.
                </p>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          {outcome ? (
            <>
              <Button variant="outline" onClick={reset}>Offboard another</Button>
              <Button onClick={close}>Done</Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={close}>Cancel</Button>
              <Button
                variant="destructive"
                disabled={busy || !member || grantId === null}
                onClick={() => {
                  if (confirm(`Offboard ${member?.name ?? member?.email} from ${leavingLabel}?\n\nThis removes grant-roster access immediately. Mailing-list removal is a separate confirmation on the next screen.`)) offboard();
                }}
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <><UserMinus className="mr-1.5 h-4 w-4" />Offboard</>}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
