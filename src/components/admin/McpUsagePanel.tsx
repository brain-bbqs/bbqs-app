import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, Activity, Users, UserX, AlertTriangle, Database, ShieldX } from "lucide-react";
import { format } from "date-fns";

interface UserTool { email: string; tool: string; calls: number; errors: number; refused: number; last: string }
interface ClientRow { client: string; email: string; sessions: number; last: string }
interface RecentCall {
  occurred_at: string; email: string; method: string; tool: string; tier: string | null;
  outcome: string | null; args: unknown; error: string | null; client_name: string | null; duration_ms: number | null;
}

interface Stats {
  window_days: number;
  total_calls: number;
  unique_users: number;
  anonymous_calls: number;
  error_calls: number;
  refused_calls?: number;
  by_tier: Record<string, number>;
  by_tool: { tool: string; calls: number }[];
  by_day: { day: string; calls: number }[];
  top_users: { email: string; calls: number }[];
  // Present once migration 20261104120000 (mcp_call_log) is applied.
  by_user_tool?: UserTool[];
  clients?: ClientRow[];
  recent?: RecentCall[];
  historical_writes: number;
  historical_write_users: number;
}

const WINDOWS = [7, 30, 90];

const OUTCOME_VARIANT: Record<string, "secondary" | "destructive" | "outline"> = {
  ok: "secondary",
  error: "destructive",
  refused: "outline",
};

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

const when = (iso: string) => (iso ? format(new Date(iso), "MMM d, HH:mm") : "—");
const argsText = (a: unknown) => (a == null ? "" : JSON.stringify(a));

export function McpUsagePanel() {
  const [days, setDays] = useState(30);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [outcomeFilter, setOutcomeFilter] = useState<"all" | "refused" | "error">("all");

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

  const byUser = useMemo(() => {
    const m = new Map<string, UserTool[]>();
    for (const r of stats?.by_user_tool ?? []) m.set(r.email, [...(m.get(r.email) ?? []), r]);
    return [...m.entries()]
      .map(([email, tools]) => ({ email, tools, total: tools.reduce((n, t) => n + t.calls, 0) }))
      .sort((a, b) => b.total - a.total);
  }, [stats]);

  const recent = (stats?.recent ?? []).filter((r) => outcomeFilter === "all" || r.outcome === outcomeFilter);

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
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Stat icon={Activity} label={`Calls (${stats.window_days}d)`} value={stats.total_calls} />
            <Stat icon={Users} label="Unique users" value={stats.unique_users} />
            <Stat icon={UserX} label="Anonymous calls" value={stats.anonymous_calls} />
            <Stat icon={AlertTriangle} label="Errors" value={stats.error_calls} />
            <Stat icon={ShieldX} label="Refused (above tier)" value={stats.refused_calls ?? 0} />
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

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Who uses which tools</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {!stats.by_user_tool && (
                <p className="text-sm text-muted-foreground">
                  Needs migration <code>20261104120000_mcp_call_log</code>.
                </p>
              )}
              {stats.by_user_tool && byUser.length === 0 && (
                <p className="text-sm text-muted-foreground">No calls yet in this window.</p>
              )}
              {byUser.map((u) => (
                <div key={u.email} className="text-sm">
                  <div className="flex justify-between">
                    <span className="font-medium truncate">{u.email}</span>
                    <span className="tabular-nums text-muted-foreground">{u.total}</span>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {u.tools.map((t) => (
                      <Badge
                        key={t.tool}
                        variant={t.refused ? "destructive" : "secondary"}
                        className="font-mono text-[10px]"
                        title={`last ${when(t.last)}${t.errors ? ` · ${t.errors} errors` : ""}${t.refused ? ` · ${t.refused} refused` : ""}`}
                      >
                        {t.tool} {t.calls}{t.refused ? ` (${t.refused} refused)` : ""}
                      </Badge>
                    ))}
                  </div>
                </div>
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
              <CardHeader className="pb-2"><CardTitle className="text-sm">Clients connecting</CardTitle></CardHeader>
              <CardContent className="space-y-1">
                {(stats.clients ?? []).length === 0 && (
                  <p className="text-sm text-muted-foreground">No sessions recorded in this window.</p>
                )}
                {(stats.clients ?? []).map((cl) => (
                  <div key={`${cl.client}-${cl.email}`} className="flex justify-between gap-2 text-sm">
                    <span className="truncate"><span className="font-mono text-xs">{cl.client}</span> · {cl.email}</span>
                    <span className="tabular-nums text-muted-foreground whitespace-nowrap">
                      {cl.sessions} · {when(cl.last)}
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-sm">Recent calls</CardTitle>
              <div className="flex gap-1">
                {(["all", "refused", "error"] as const).map((o) => (
                  <Button key={o} size="sm" variant={outcomeFilter === o ? "default" : "outline"} onClick={() => setOutcomeFilter(o)}>
                    {o}
                  </Button>
                ))}
              </div>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              {recent.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing to show.</p>
              ) : (
                <table className="w-full text-xs">
                  <thead className="text-muted-foreground text-left">
                    <tr>
                      <th className="py-1 pr-3 font-medium">When</th>
                      <th className="py-1 pr-3 font-medium">Who</th>
                      <th className="py-1 pr-3 font-medium">Tool</th>
                      <th className="py-1 pr-3 font-medium">Outcome</th>
                      <th className="py-1 font-medium">Arguments</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((r, i) => (
                      <tr key={`${r.occurred_at}-${i}`} className="border-t border-border align-top">
                        <td className="py-1 pr-3 whitespace-nowrap tabular-nums">{when(r.occurred_at)}</td>
                        <td className="py-1 pr-3 whitespace-nowrap">{r.email}</td>
                        <td className="py-1 pr-3 font-mono whitespace-nowrap">
                          {r.method === "initialize" ? `connect${r.client_name ? ` · ${r.client_name}` : ""}` : r.tool}
                        </td>
                        <td className="py-1 pr-3">
                          <Badge variant={OUTCOME_VARIANT[r.outcome ?? "ok"] ?? "secondary"} className="text-[10px]" title={r.error ?? undefined}>
                            {r.outcome ?? "ok"}
                          </Badge>
                        </td>
                        <td className="py-1 font-mono text-muted-foreground max-w-[28rem] truncate" title={argsText(r.args)}>
                          {argsText(r.args)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
