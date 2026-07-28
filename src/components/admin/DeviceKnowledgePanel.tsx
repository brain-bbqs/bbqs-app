import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Loader2, Sparkles } from "lucide-react";

type Coverage = { category_key: string; label: string; params: number; ml_specs: number; refs: number; pitfalls: number };

export function DeviceKnowledgePanel() {
  const [rows, setRows] = useState<Coverage[]>([]);
  const [loading, setLoading] = useState(true);
  const [seeding, setSeeding] = useState(false);

  const load = async () => {
    setLoading(true);
    const { data: cats } = await supabase.from("device_categories").select("key,label").order("label");
    const [p, m, r, i] = await Promise.all([
      supabase.from("device_category_parameters").select("category_key"),
      supabase.from("device_category_ml_specs").select("category_key"),
      supabase.from("device_category_references").select("category_key"),
      supabase.from("device_category_pitfalls").select("category_key"),
    ]);
    const count = (arr: any[] | null, k: string) => (arr ?? []).filter((x) => x.category_key === k).length;
    setRows(
      (cats ?? []).map((c: any) => ({
        category_key: c.key,
        label: c.label,
        params: count(p.data, c.key),
        ml_specs: count(m.data, c.key),
        refs: count(r.data, c.key),
        pitfalls: count(i.data, c.key),
      })),
    );
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const runSeed = async () => {
    setSeeding(true);
    const { data, error } = await supabase.functions.invoke("device-knowledge-seed", { body: {} });
    setSeeding(false);
    if (error) return toast.error(`Seed failed: ${error.message}`);
    toast.success(`Seeded: ${JSON.stringify((data as any)?.stats ?? {})}`);
    load();
  };

  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground mb-1">Device knowledge coverage</h2>
          <p className="text-sm text-muted-foreground">
            Curated parameters, ML specs, pitfalls, and references per BBQS device category — powers agent probes like HRV.
          </p>
        </div>
        <Button onClick={runSeed} disabled={seeding}>
          {seeding ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
          Reseed
        </Button>
      </div>
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No categories yet — click Reseed to populate.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-muted-foreground border-b border-border">
            <tr><th className="py-2">Category</th><th>Params</th><th>ML specs</th><th>Pitfalls</th><th>Refs</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.category_key} className="border-b border-border/50">
                <td className="py-2 pr-4">{r.label}</td>
                <td>{r.params}</td>
                <td>{r.ml_specs}</td>
                <td>{r.pitfalls}</td>
                <td>{r.refs}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}