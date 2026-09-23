import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, Activity, Users, UserX, AlertTriangle, Database } from "lucide-react";

interface Stats {
  window_days: number;
  total_calls: number;
  unique_users: number;
  anonymous_calls: number;
  error_calls: number;
  by_tier: Record<string, number>;
  by_tool: { tool: string; calls: number }[];
  by_day: { day: string; calls: number }[];
  top_users: { email: string; calls: number }[];
  historical_writes: number;
  historical_write_users: number;
}

const WINDOWS = [7, 30, 90];

function Stat({ icon: Icon, label, value }: { icon: any; label: string; value: number }) {
  return (
    <Card>
      <CardContent className="py-3">
        <div className="flex items-center gap-2 text-muted-foreground text-xs">
          <Icon className="h-3.5 w-3.5" /> {label}
        </div>
        <div className="text-2xl font-bold tabular-nums mt-1">{value ?? 0}</div>
      </CardContent>
    </Card>
  );
}

export function McpUsagePanel() {
  const [days, setDays] = useState(30);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (d: number) => {
    setLoading(true);
    setError(null);
    // RPC not in generated types yet (new migration) — cast is deliberate.
    const { data, error } = await supabase.rpc("mcp_usage_stats" as any, { _days: d });
    if (error) {
      setError(error.message);
      setStats(null);
    } else {
      setStats(data as unknown as Stats);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(days); }, [days, load]);

  const maxTool = stats?.by_tool?.[0]?.calls || 1;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex gap-1.5">
          {WINDOWS.map((w) => (
            <Button key={w} size="sm" variant={days === w ? "default" : "outline"} onClick={() => setDays(w)}>
              {w}d
            </Button>
          ))}
        </div>
        <Button size="sm" variant="ghost" onClick={() => load(days)} disabled={loading} className="gap-1.5">
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {error && (
        <Card>
          <CardContent className="py-4 text-sm text-muted-foreground">
            Usage stats unavailable: {error}. If this reports a missing function, the{" "}
            <code>mcp_usage_log</code> migration has not been applied yet.
          </CardContent>
        </Card>
      )}

      {stats && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Stat icon={Activity} label={`Calls (${stats.window_days}d)`} value={stats.total_calls} />
            <Stat icon={Users} label="Unique users" value={stats.unique_users} />
            <Stat icon={UserX} label="Anonymous calls" value={stats.anonymous_calls} />
            <Stat icon={AlertTriangle} label="Errors" value={stats.error_calls} />
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-1.5">
                <Database className="h-4 w-4" /> Write reach (all-time, from the audit log)
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              {stats.historical_writes} KG writes through the MCP by {stats.historical_write_users} distinct
              users, since before this call counter existed (stamped <code>bbqs-mcp:&lt;email&gt;</code>).
              <span className="ml-1">Calls by tier ({stats.window_days}d):</span>
              {Object.entries(stats.by_tier || {}).map(([t, n]) => (
                <Badge key={t} variant="outline" className="ml-1">{t}: {n as number}</Badge>
              ))}
            </CardContent>
          </Card>

          <div className="grid md:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">By tool</CardTitle></CardHeader>
              <CardContent className="space-y-1.5">
                {(stats.by_tool || []).length === 0 && (
                  <p className="text-sm text-muted-foreground">No calls yet in this window.</p>
                )}
                {(stats.by_tool || []).map((t) => (
                  <div key={t.tool} className="flex items-center gap-2 text-sm">
                    <span className="w-40 truncate font-mono text-xs">{t.tool}</span>
                    <div className="flex-1 h-2 bg-muted rounded">
                      <div className="h-2 bg-primary rounded" style={{ width: `${(t.calls / maxTool) * 100}%` }} />
                    </div>
                    <span className="w-10 text-right tabular-nums">{t.calls}</span>
                  </div>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Top users</CardTitle></CardHeader>
              <CardContent className="space-y-1">
                {(stats.top_users || []).length === 0 && (
                  <p className="text-sm text-muted-foreground">No calls yet in this window.</p>
                )}
                {(stats.top_users || []).map((u) => (
                  <div key={u.email} className="flex justify-between text-sm">
                    <span className="truncate">{u.email}</span>
                    <span className="tabular-nums text-muted-foreground">{u.calls}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
