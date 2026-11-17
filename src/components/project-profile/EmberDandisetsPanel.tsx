import { useQuery } from "@tanstack/react-query";
import { Database, ExternalLink, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/hooks/use-toast";
import { useState } from "react";

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function EmberDandisetsPanel({ grantId, canSync = false }: { grantId: string; canSync?: boolean }) {
  const [syncing, setSyncing] = useState(false);
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["ember-dandisets", grantId],
    queryFn: async () => {
      // Named columns, never dandisets(*): a visitor may not read raw (EMBER's payload, contributor
      // e-mail addresses in it) or the curator's hide decision (20261117190000).
      const { data, error } = await supabase
        .from("grant_dandisets")
        .select("matched_award, dandiset:dandisets(id, dandiset_id, name, contact_name, file_count, size_bytes, species, draft_url, neurosift_url)")
        .eq("grant_id", grantId);
      if (error) throw error;
      return data || [];
    },
  });

  const triggerSync = async () => {
    setSyncing(true);
    try {
      const { error } = await supabase.functions.invoke("ember-dandiset-sync", { body: {} });
      if (error) throw error;
      toast({ title: "EMBER sync complete", description: "Dandiset links refreshed." });
      await refetch();
    } catch (e: any) {
      toast({ title: "Sync failed", description: e.message, variant: "destructive" });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="bg-card border border-border rounded-xl p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
            EMBER Datasets
          </h2>
        </div>
        {canSync && (
          <Button size="sm" variant="ghost" onClick={triggerSync} disabled={syncing}>
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${syncing ? "animate-spin" : ""}`} />
            Sync
          </Button>
        )}
      </div>

      {isLoading ? (
        <Skeleton className="h-20 w-full" />
      ) : !data || data.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No EMBER dandisets linked to this grant. Datasets are matched automatically when their
          DANDI <code>contributor.awardNumber</code> matches this grant's number.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {data.map((row: any) => {
            const d = row.dandiset;
            if (!d) return null;
            return (
              <li key={d.id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <a
                      href={d.draft_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm font-medium text-foreground hover:text-primary inline-flex items-center gap-1"
                    >
                      {d.name}
                      <ExternalLink className="h-3 w-3 opacity-60" />
                    </a>
                    <p className="text-xs font-mono text-muted-foreground mt-0.5">
                      DANDI:{d.dandiset_id} · matched {row.matched_award}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {d.contact_name ? `${d.contact_name} · ` : ""}
                      {d.file_count?.toLocaleString() || "—"} files · {formatBytes(d.size_bytes)}
                      {d.species?.length ? ` · ${d.species.join(", ")}` : ""}
                    </p>
                  </div>
                  {d.neurosift_url && (
                    <a
                      href={d.neurosift_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-primary hover:underline whitespace-nowrap shrink-0"
                    >
                      Neurosift →
                    </a>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}