import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useUserTier } from "@/hooks/useUserTier";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, Check, X, UsersRound } from "lucide-react";
import { toast } from "sonner";
import { edgeError } from "@/lib/edgeError";

type ReqRow = {
  id: string;
  name: string | null;
  email: string;
  working_groups: string[] | null;
  requested_working_groups: string[] | null;
};

const short = (t: string) => t.replace(/^WG-/, "");

/** Admin surface for member working-group REQUESTS (from the Profile self-serve editor).
 *  Approve → promotes the request into working_groups (mailing-list sync fires). Dismiss →
 *  clears the request without changing membership. Renders nothing when there are none. */
export function WorkingGroupRequestsPanel() {
  const tier = useUserTier();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["wg-requests"],
    enabled: tier.isCurator,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("investigators")
        .select("id, name, email, working_groups, requested_working_groups")
        .not("requested_working_groups", "is", null);
      if (error) throw error;
      return ((data ?? []) as ReqRow[]).filter((r) => (r.requested_working_groups ?? []).length > 0);
    },
  });

  const act = async (id: string, fn: () => Promise<void>, ok: string) => {
    setBusy(id);
    try {
      await fn();
      toast.success(ok);
      queryClient.invalidateQueries({ queryKey: ["wg-requests"] });
      queryClient.invalidateQueries({ queryKey: ["onboarding-pipeline"] });
    } catch (e: any) {
      toast.error(e?.message ?? "Action failed");
    } finally {
      setBusy(null);
    }
  };

  const approve = (r: ReqRow) =>
    act(r.id, async () => {
      const { data, error } = await supabase.rpc("approve_working_groups" as any, { _investigator_id: r.id });
      if (error || (data as any)?.ok === false) throw new Error(await edgeError(error, data));
    }, "Working groups approved");

  const dismiss = (r: ReqRow) =>
    act(r.id, async () => {
      // Admin/curator RLS permits updating investigators; clear the request, leave membership.
      const { error } = await supabase.from("investigators").update({ requested_working_groups: null } as any).eq("id", r.id);
      if (error) throw error;
    }, "Request dismissed");

  if (!tier.isCurator) return null;
  if (isLoading || rows.length === 0) return null; // stay out of the way when nothing pending

  return (
    <Card className="mb-4 border-amber-500/40">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <UsersRound className="h-4 w-4 text-amber-600 dark:text-amber-400" />
          Working-group requests <span className="text-xs font-normal text-muted-foreground">({rows.length} pending)</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.map((r) => {
          const current = (r.working_groups ?? []).filter(Boolean).map(short);
          const requested = (r.requested_working_groups ?? []).filter(Boolean).map(short);
          return (
            <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2.5 text-sm">
              <div className="min-w-0 flex-1">
                <div className="font-medium text-foreground">{r.name ?? r.email}</div>
                <div className="text-xs text-muted-foreground">
                  <span className="text-muted-foreground">now: </span>{current.length ? current.join(", ") : "none"}
                  <span className="mx-1">→</span>
                  <span className="text-amber-600 dark:text-amber-400 font-medium">requested: {requested.join(", ")}</span>
                </div>
              </div>
              <Button size="sm" disabled={busy === r.id} onClick={() => approve(r)}>
                {busy === r.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Check className="mr-1.5 h-3.5 w-3.5" />Approve</>}
              </Button>
              <Button size="sm" variant="outline" disabled={busy === r.id} onClick={() => dismiss(r)}>
                <X className="mr-1.5 h-3.5 w-3.5" />Dismiss
              </Button>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
