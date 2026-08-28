import { useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useProfile } from "@/hooks/useProfile";
import { useDashboardConfig } from "@/hooks/useDashboardConfig";
import { useUserTier } from "@/hooks/useUserTier";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download, Database, RotateCcw, Loader2, LayoutDashboard } from "lucide-react";
import { toast } from "sonner";

function downloadFile(name: string, contents: string, mime: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function toCsv(rows: Record<string, unknown>[]) {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}

const stamp = () => new Date().toISOString().slice(0, 10);

/** Settings: self-serve data export (provenance, account bundle) and dashboard configuration. */
export function DataAndConfigCard() {
  const { user } = useAuth();
  const { profile } = useProfile();
  const { widgets, workingGroups, investigatorId, reset } = useDashboardConfig();
  useUserTier();
  const [busy, setBusy] = useState<string | null>(null);


  const fetchProvenance = async () => {
    const { data, error } = await supabase
      .from("data_audit_log")
      .select("id, table_name, record_id, operation, changed_fields, occurred_at, actor_label, client_source")
      .eq("actor_id", user!.id)
      .order("occurred_at", { ascending: false })
      .limit(1000);
    if (error) throw error;
    return data ?? [];
  };

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch {
      toast.error("Export failed — please try again");
    } finally {
      setBusy(null);
    }
  };

  const exportProvenance = (format: "csv" | "json") =>
    run(`prov-${format}`, async () => {
      const rows = await fetchProvenance();
      if (!rows.length) {
        toast.info("No provenance records recorded for your account yet");
        return;
      }
      if (format === "csv") {
        downloadFile(`bbqs-data-provenance-${stamp()}.csv`, toCsv(rows as Record<string, unknown>[]), "text/csv");
      } else {
        downloadFile(`bbqs-data-provenance-${stamp()}.json`, JSON.stringify(rows, null, 2), "application/json");
      }
      toast.success(`Exported ${rows.length} provenance records`);
    });

  const exportAccount = () =>
    run("account", async () => {
      const [{ data: investigator }, provenance] = await Promise.all([
        investigatorId
          ? supabase.from("investigators").select("*").eq("id", investigatorId).maybeSingle()
          : Promise.resolve({ data: null }),
        fetchProvenance(),
      ]);
      const bundle = {
        exported_at: new Date().toISOString(),
        account: { id: user?.id, email: profile?.email ?? user?.email, full_name: profile?.full_name },
        investigator,
        dashboard: { widgets, working_groups: workingGroups },
        data_provenance: provenance,
      };
      downloadFile(`bbqs-my-data-${stamp()}.json`, JSON.stringify(bundle, null, 2), "application/json");
      toast.success("Account data exported");
    });

  const exportConfig = () =>
    run("config", async () => {
      downloadFile(
        `bbqs-dashboard-config-${stamp()}.json`,
        JSON.stringify({ widgets, working_groups: workingGroups }, null, 2),
        "application/json",
      );
      toast.success("Dashboard configuration exported");
    });

  const onReset = async () => {
    try {
      await reset.mutateAsync();
      toast.success("Dashboard configuration reset to default");
    } catch {
      toast.error("Could not reset your configuration");
    }
  };

  const Spin = ({ k }: { k: string }) =>
    busy === k ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />;

  return (
    <Card id="data" className="scroll-mt-20">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Database className="h-4 w-4" />
          Data & Configuration
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div>
          <p className="text-sm font-medium text-foreground mb-1">Download your data provenance</p>
          <p className="text-xs text-muted-foreground mb-3">
            Every change recorded against your account in the audit log (up to the 1,000 most recent).
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => exportProvenance("csv")} disabled={!!busy}>
              <Spin k="prov-csv" /> Provenance (CSV)
            </Button>
            <Button variant="outline" size="sm" onClick={() => exportProvenance("json")} disabled={!!busy}>
              <Spin k="prov-json" /> Provenance (JSON)
            </Button>
          </div>
        </div>

        <div>
          <p className="text-sm font-medium text-foreground mb-1">Download everything</p>
          <p className="text-xs text-muted-foreground mb-3">
            One JSON bundle: your account, investigator record, dashboard configuration and provenance.
          </p>
          <Button variant="outline" size="sm" onClick={exportAccount} disabled={!!busy}>
            <Spin k="account" /> My data (JSON)
          </Button>
        </div>

        <div>
          <p className="text-sm font-medium text-foreground mb-1">Dashboard configuration</p>
          <p className="text-xs text-muted-foreground mb-3">
            {widgets.filter((w) => w.visible).length} of {widgets.length} widgets visible
            {workingGroups.length > 0 && ` · groups: ${workingGroups.map((g) => g.replace("WG-", "")).join(", ")}`}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link to="/dashboard">
                <LayoutDashboard className="mr-2 h-4 w-4" /> Customize on dashboard
              </Link>
            </Button>
            <Button variant="outline" size="sm" onClick={exportConfig} disabled={!!busy}>
              <Spin k="config" /> Export config
            </Button>
            <Button variant="ghost" size="sm" onClick={onReset} disabled={reset.isPending}>
              <RotateCcw className="mr-2 h-4 w-4" /> Reset to default
            </Button>
          </div>
        </div>

      </CardContent>
    </Card>
  );
}
