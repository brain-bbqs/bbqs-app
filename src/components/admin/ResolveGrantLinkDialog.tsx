import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Link2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { edgeError } from "@/lib/edgeError";

type Member = { id: string; name: string | null; email: string; role: string | null };
type Suggestion = { grant_id: string; grant_number: string; title: string | null; score: number; reason: string | null };
type GrantHit = { id: string; grant_number: string; title: string | null };

/** Actually RESOLVE the grant_link stage: rank candidate grants from live data (shared email
 *  domain / institution), or search manually, then associate in one call. Not a checkbox. */
export function ResolveGrantLinkDialog({ member, onClose }: { member: Member | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [q, setQ] = useState("");
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

  const { data: searchHits = [] } = useQuery({
    queryKey: ["grant-search-resolve", q],
    enabled: !!member && q.trim().length >= 2,
    queryFn: async () => {
      const term = q.trim().replace(/[%,]/g, " ");
      const { data, error } = await supabase
        .from("grants").select("id,grant_number,title")
        .or(`grant_number.ilike.%${term}%,title.ilike.%${term}%`).limit(8);
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

  const Row = ({ id, number, title, reason }: { id: string; number: string; title: string | null; reason?: string | null }) => (
    <div className="flex items-center gap-2 rounded-md border border-border p-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-foreground truncate">{title ?? number}</div>
        <div className="text-xs text-muted-foreground">
          {number}{reason ? <span className="text-primary"> · {reason}</span> : null}
        </div>
      </div>
      <Button size="sm" disabled={linking !== null} onClick={() => link(id, number)}>
        {linking === id ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Link2 className="mr-1.5 h-3.5 w-3.5" />Link</>}
      </Button>
    </div>
  );

  return (
    <Dialog open={!!member} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Associate a grant</DialogTitle>
          <DialogDescription>
            {member ? <>Link <strong>{member.name ?? member.email}</strong> to a consortium grant. Suggestions are inferred from live data — colleagues on a grant who share their email domain or institution.</> : null}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div>
            <div className="flex items-center gap-1.5 text-sm font-medium mb-1.5">
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
                  <Row key={s.grant_id} id={s.grant_id} number={s.grant_number} title={s.title} reason={s.reason} />
                ))}
              </div>
            )}
          </div>

          <div>
            <Label htmlFor="rg-search">Or search all grants</Label>
            <Input id="rg-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Grant number or title…" />
            {searchHits.length > 0 && (
              <div className="space-y-2 mt-2">
                {searchHits.map((g) => <Row key={g.id} id={g.id} number={g.grant_number} title={g.title} />)}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
