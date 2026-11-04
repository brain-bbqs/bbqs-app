import { useState } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, ExternalLink, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { PageMeta } from "@/components/PageMeta";
import { useUserTier } from "@/hooks/useUserTier";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export default function GrantMethodsEvidence() {
  const { grantNumber = "" } = useParams();
  const { isCurator } = useUserTier();
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState<"depth2" | "multihop">("depth2");

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["grant-methods-evidence", grantNumber],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("grant_methods_evidence")
        .select("*")
        .eq("seed_grant_number", grantNumber)
        .order("depth", { ascending: true })
        .order("confidence", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: paths } = useQuery({
    queryKey: ["grant-methods-paths", grantNumber],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("grant_methods_traversal_paths")
        .select("*")
        .eq("seed_grant_number", grantNumber)
        .order("chain_score", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const runHarvest = async () => {
    setRunning(true);
    try {
      const fn = mode === "multihop" ? "harvest-grant-methods-multihop" : "harvest-grant-methods";
      const { data: res, error } = await supabase.functions.invoke(fn, {
        body: { seedGrantNumber: grantNumber },
      });
      if (error) throw error;
      toast.success(`Harvested ${res?.publications_extracted ?? 0} new publications across ${res?.projects_visited ?? 0} projects`);
      refetch();
    } catch (e: any) {
      toast.error(e.message ?? "Harvest failed");
    } finally {
      setRunning(false);
    }
  };

  const rows = data ?? [];
  const byDepth: Record<number, typeof rows> = { 0: [], 1: [], 2: [] };
  rows.forEach((r: any) => (byDepth[r.depth] ??= []).push(r));

  return (
    <div className="container mx-auto px-4 py-8 space-y-6">
      <PageMeta title={`Methods Evidence — ${grantNumber}`} description={`Hardware & methods evidence harvested for ${grantNumber}`} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold">Hardware & Methods Evidence</h1>
          <p className="text-muted-foreground mt-1">
            Seed grant: <span className="font-mono">{grantNumber}</span>. Walks NIH RePORTER similar-project graph and extracts Methods sections from linked publications.
          </p>
        </div>
        {/* Each run spends LLM calls; the harvest functions accept curators only. */}
        {isCurator && <div className="flex gap-2 items-center">
          <Select value={mode} onValueChange={(v) => setMode(v as any)}>
            <SelectTrigger className="w-[220px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="depth2">Depth-2 (fast)</SelectItem>
              <SelectItem value="multihop">Multi-hop reasoning</SelectItem>
            </SelectContent>
          </Select>
          <Button onClick={runHarvest} disabled={running}>
            {running ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <RefreshCw className="w-4 h-4 mr-2" />}
            {rows.length ? "Re-run harvest" : "Run harvest"}
          </Button>
        </div>}
      </div>

      {isLoading && <p className="text-muted-foreground">Loading…</p>}

      {!isLoading && rows.length === 0 && (
        <Card className="p-6 text-center text-muted-foreground">
          No evidence yet. Click <strong>Run harvest</strong> to walk the NIH RePORTER graph for this grant. This may take a minute or two.
        </Card>
      )}

      <Tabs defaultValue="evidence">
        <TabsList>
          <TabsTrigger value="evidence">Evidence ({rows.length})</TabsTrigger>
          <TabsTrigger value="paths">Discovery paths ({paths?.length ?? 0})</TabsTrigger>
        </TabsList>
        <TabsContent value="evidence" className="space-y-4">
      {[0, 1, 2, 3, 4].map((d) =>
        byDepth[d]?.length ? (
          <section key={d} className="space-y-3">
            <h2 className="text-xl font-semibold">
              Depth {d} <span className="text-sm font-normal text-muted-foreground">({byDepth[d].length} extracts)</span>
            </h2>
            <div className="grid gap-3">
              {byDepth[d].map((r: any) => (
                <Card key={r.id} className="p-4 space-y-2">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold">{r.publication_title || "(untitled)"}</div>
                      <div className="text-xs text-muted-foreground font-mono">
                        {r.source_grant_number} · {r.source_org}{r.source_org_type ? ` (${r.source_org_type})` : ""} · PMID {r.pmid}
                      </div>
                    </div>
                    <div className="flex gap-2 items-center">
                      {r.setting && <Badge variant="secondary">{r.setting}</Badge>}
                      {r.confidence != null && <Badge>conf {Number(r.confidence).toFixed(2)}</Badge>}
                      {r.source_url && (
                        <a href={r.source_url} target="_blank" rel="noopener noreferrer" className="text-primary inline-flex items-center text-sm">
                          source <ExternalLink className="w-3 h-3 ml-1" />
                        </a>
                      )}
                    </div>
                  </div>
                  {r.quote && <blockquote className="border-l-2 border-primary pl-3 italic text-sm">"{r.quote}"</blockquote>}
                  {Array.isArray(r.device_hardware) && r.device_hardware.length > 0 && (
                    <div className="text-sm">
                      <span className="font-medium">Hardware:</span>{" "}
                      {r.device_hardware.map((h: string, i: number) => (
                        <Badge key={i} variant="outline" className="mr-1">{h}</Badge>
                      ))}
                    </div>
                  )}
                  {Array.isArray(r.analysis_metrics) && r.analysis_metrics.length > 0 && (
                    <div className="text-sm">
                      <span className="font-medium">Metrics:</span>{" "}
                      {r.analysis_metrics.map((m: string, i: number) => (
                        <Badge key={i} variant="outline" className="mr-1">{m}</Badge>
                      ))}
                    </div>
                  )}
                  {(r.stimulation_params && Object.keys(r.stimulation_params).length > 0) && (
                    <details className="text-sm">
                      <summary className="cursor-pointer text-muted-foreground">Stimulation params</summary>
                      <pre className="text-xs bg-muted p-2 rounded mt-1 overflow-auto">{JSON.stringify(r.stimulation_params, null, 2)}</pre>
                    </details>
                  )}
                  {(r.recording_params && Object.keys(r.recording_params).length > 0) && (
                    <details className="text-sm">
                      <summary className="cursor-pointer text-muted-foreground">Recording params</summary>
                      <pre className="text-xs bg-muted p-2 rounded mt-1 overflow-auto">{JSON.stringify(r.recording_params, null, 2)}</pre>
                    </details>
                  )}
                  {r.irb_or_population && (
                    <div className="text-xs text-muted-foreground">Population/IRB: {r.irb_or_population}</div>
                  )}
                  {r.discovery_path_id && (
                    <details className="text-xs text-muted-foreground">
                      <summary className="cursor-pointer">Found via path</summary>
                      <PathChain pathId={r.discovery_path_id} paths={paths ?? []} />
                    </details>
                  )}
                </Card>
              ))}
            </div>
          </section>
        ) : null,
      )}
        </TabsContent>
        <TabsContent value="paths" className="space-y-3 pt-2">
          {(paths ?? []).length === 0 && (
            <Card className="p-6 text-center text-muted-foreground">
              No discovery paths recorded yet. Run the harvest in <strong>Multi-hop reasoning</strong> mode to capture them.
            </Card>
          )}
          {(paths ?? []).map((p: any) => (
            <Card key={p.id} className="p-4 space-y-2">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span className="font-mono">chain {Number(p.chain_score).toFixed(3)}</span>
                <span>{p.planner_model}</span>
              </div>
              <div className="flex flex-wrap items-center gap-1 text-sm">
                {(p.path as any[]).map((step, i) => (
                  <span key={i} className="flex items-center gap-1">
                    {step.relation_in && <span className="text-muted-foreground">—[{step.relation_in}]→</span>}
                    <Badge variant="outline" className="font-mono text-xs">
                      {step.node_type}:{step.label?.slice(0, 30) ?? step.node_id}
                    </Badge>
                  </span>
                ))}
              </div>
            </Card>
          ))}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function PathChain({ pathId, paths }: { pathId: string; paths: any[] }) {
  const p = paths.find((x) => x.id === pathId);
  if (!p) return <div className="mt-1">(path not loaded)</div>;
  return (
    <div className="flex flex-wrap items-center gap-1 mt-1">
      {(p.path as any[]).map((step, i) => (
        <span key={i} className="flex items-center gap-1">
          {step.relation_in && <span>—[{step.relation_in}]→</span>}
          <span className="font-mono">{step.node_type}:{step.label?.slice(0, 24) ?? step.node_id}</span>
        </span>
      ))}
    </div>
  );
}