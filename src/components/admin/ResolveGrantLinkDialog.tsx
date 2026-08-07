import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Link2, Sparkles, Search } from "lucide-react";
import { toast } from "sonner";
import { edgeError } from "@/lib/edgeError";

type Member = { id: string; name: string | null; email: string; role: string | null };
type Suggestion = { grant_id: string; grant_number: string; title: string | null; score: number; reason: string | null };
type GrantHit = { id: string; grant_number: string; title: string | null };

/** Actually RESOLVE the grant_link stage: rank candidate grants from live data (shared email
 *  domain / institution), or type-ahead search all grants, then associate in one click. */
export function ResolveGrantLinkDialog({ member, onClose }: { member: Member | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [q, setQ] = useState("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [linking, setLinking] = useState<string | null>(null);

  const { data: suggestions = [], isLoading } = useQuery({
    queryKey: ["grant-suggestions", member?.id],
    enabled: !!member,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("suggest_grants_for_investigator" as any, { _investigator_id: member!.id });
      if (error) throw error;
      return (data ?? []) as Suggestion[];
    },
  });

  const { data: searchHits = [], isFetching: searching } = useQuery({
    queryKey: ["grant-search-resolve", q],
    enabled: !!member && q.trim().length >= 2,
    queryFn: async () => {
      const term = q.trim().replace(/[%,]/g, " ");
      const { data, error } = await supabase
        .from("grants").select("id,grant_number,title")
        .or(`grant_number.ilike.%${term}%,title.ilike.%${term}%`).limit(10);
      if (error) throw error;
      return (data ?? []) as GrantHit[];
    },
  });

  const link = async (grantId: string, label: string) => {
    if (!member) return;
    setLinking(grantId);
    try {
      const { data, error } = await supabase.rpc("link_investigator_grant" as any, {
        _investigator_id: member.id, _grant_id: grantId, _role: null,
      });
      if (error || (data as any)?.ok === false) throw new Error(await edgeError(error, data));
      toast.success(`Linked to ${label}`);
      queryClient.invalidateQueries({ queryKey: ["onboarding-pipeline"] });
      onClose();
    } catch (e: any) {
      toast.error(e?.message ?? "Could not link the grant");
    } finally {
      setLinking(null);
    }
  };

  const close = () => { setQ(""); setDropdownOpen(false); onClose(); };

  /** A whole-row click target — the entire card links the grant, no button-hunting. */
  const GrantRow = ({ id, number, title, reason }: { id: string; number: string; title: string | null; reason?: string | null }) => (
    <button
      type="button"
      onClick={() => link(id, number)}
      disabled={linking !== null}
      className="group w-full text-left flex items-start gap-3 rounded-md border border-border p-3 transition-colors hover:bg-muted hover:border-primary/50 disabled:opacity-60 disabled:cursor-not-allowed"
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground leading-snug">{title ?? number}</div>
        <div className="text-xs text-muted-foreground mt-0.5">
          <span className="font-mono">{number}</span>
          {reason ? <span className="text-primary"> · {reason}</span> : null}
        </div>
      </div>
      <span className="shrink-0 inline-flex items-center gap-1 text-xs text-muted-foreground group-hover:text-primary pt-0.5">
        {linking === id ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Link2 className="h-3.5 w-3.5" />Link</>}
      </span>
    </button>
  );

  return (
    <Dialog open={!!member} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Associate a grant</DialogTitle>
          <DialogDescription>
            {member ? <>Link <strong>{member.name ?? member.email}</strong> to a consortium grant. Suggestions are inferred from live data — colleagues on a grant who share their email domain or institution. Click any grant to link it.</> : null}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-1">
          {/* Suggested */}
          <div>
            <div className="flex items-center gap-1.5 text-sm font-medium mb-2">
              <Sparkles className="h-4 w-4 text-primary" /> Suggested
            </div>
            {isLoading ? (
              <div className="flex justify-center py-4"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
            ) : suggestions.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No confident match from their email domain or institution — search below.
              </p>
            ) : (
              <div className="space-y-2">
                {suggestions.map((s) => (
                  <GrantRow key={s.grant_id} id={s.grant_id} number={s.grant_number} title={s.title} reason={s.reason} />
                ))}
              </div>
            )}
          </div>

          {/* Type-ahead search over all grants */}
          <div className="relative">
            <Label htmlFor="rg-search">Or search all grants</Label>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
              <Input
                id="rg-search"
                className="pl-8"
                value={q}
                onChange={(e) => { setQ(e.target.value); setDropdownOpen(true); }}
                onFocus={() => setDropdownOpen(true)}
                onKeyDown={(e) => { if (e.key === "Escape") { setDropdownOpen(false); e.stopPropagation(); } }}
                placeholder="Type a grant number or title…"
                autoComplete="off"
              />
              {searching && <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />}
            </div>

            {dropdownOpen && q.trim().length >= 2 && (
              <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-popover shadow-lg max-h-72 overflow-y-auto">
                {searchHits.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-muted-foreground">
                    {searching ? "Searching…" : "No grants match that search."}
                  </div>
                ) : (
                  searchHits.map((g) => (
                    <button
                      key={g.id}
                      type="button"
                      onClick={() => link(g.id, g.grant_number)}
                      disabled={linking !== null}
                      className="w-full text-left px-3 py-2.5 hover:bg-muted border-b border-border last:border-b-0 transition-colors disabled:opacity-60"
                    >
                      <div className="text-sm text-foreground leading-snug">{g.title ?? g.grant_number}</div>
                      <div className="text-xs text-muted-foreground font-mono mt-0.5">
                        {g.grant_number}
                        {linking === g.id && <span className="ml-2 text-primary">linking…</span>}
                      </div>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
