import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, RefreshCw, Link2, GitCompare, Download, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { edgeError } from "@/lib/edgeError";

type Action = "snapshot" | "truth" | "link" | "drift" | "reconcile";

interface Result {
  ok?: boolean;
  action?: Action;
  dry_run?: boolean;
  error?: string;
  // snapshot
  grants?: number;
  project_years?: number;
  observations?: number;
  changed_over_time?: { grant_number: string; years: { fiscal_year: number; contact: string | null; pis: string[] }[] }[];
  errors?: string[];
  // truth
  projects?: unknown[] | number;
  generated_at?: string;
  // link
  linked?: number;
  linked_detail?: string[];
  ambiguous?: string[];
  unmatched?: string[];
  // drift
  rows?: number;
  drift?: { grant_number: string; person: string; kg_role: string | null; reporter_role: string | null; drift: string }[];
  // reconcile
  applied?: Record<string, unknown>;
  unlinked_reporter_pis?: string[];
  on_our_roster_but_not_in_reporter?: unknown[];
  note?: string;
}

/** Drive reporter-pi-sync from the console.
 *
 *  WHY A PANEL AND NOT JUST THE CLI. The function is gated to admin/curator, and the two
 *  command-line ways of calling an edge function send the anon key or the service role key — neither
 *  carries a user. More to the point, `link` and `reconcile` both write, and their dry-run output is
 *  the thing a human is supposed to read BEFORE committing: a reconcile that moves the roster moves
 *  pi@ entitlement with it. A pair of buttons that show you the diff first is the right surface for
 *  that; a shell command that either did it or didn't is not.
 *
 *  Order matters and the copy says so: snapshot populates the temporal record, link anchors people to
 *  their RePORTER profile_id, drift reads the disagreement, reconcile applies it. */
export function ReporterPiSyncPanel() {
  const [busy, setBusy] = useState<Action | null>(null);
  const [res, setRes] = useState<Result | null>(null);

  const run = async (action: Action, dry_run = true) => {
    setBusy(action);
    try {
      const { data, error } = await supabase.functions.invoke("reporter-pi-sync", {
        body: { action, dry_run },
      });
      if (error) throw new Error(await edgeError(error, data));
      const r = (data ?? {}) as Result;
      setRes(r);
      if (r.error) { toast.error(r.error); return; }
      if (action === "snapshot") {
        const drifted = r.changed_over_time?.length ?? 0;
        toast[r.errors?.length ? "warning" : "success"](
          `${r.observations ?? 0} observations across ${r.project_years ?? 0} project-years` +
            (drifted ? ` · ${drifted} project(s) changed over time` : ""),
        );
      } else if (action === "link") {
        toast.success(
          dry_run
            ? `${r.linked ?? 0} would be linked · ${r.ambiguous?.length ?? 0} ambiguous · ${r.unmatched?.length ?? 0} unmatched`
            : `${r.linked ?? 0} investigator(s) anchored to a RePORTER profile`,
        );
      } else if (action === "drift") {
        toast[(r.rows ?? 0) ? "warning" : "success"]((r.rows ?? 0) ? `${r.rows} disagreement(s)` : "KG agrees with RePORTER");
      } else if (action === "reconcile") {
        toast[dry_run ? "info" : "success"](
          dry_run ? "Dry run — nothing written. Read the result, then Apply." : "Roster reconciled",
        );
      } else {
        toast.success(`Ground truth for ${Array.isArray(r.projects) ? r.projects.length : 0} projects`);
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "reporter-pi-sync failed");
    } finally {
      setBusy(null);
    }
  };

  const btn = (action: Action, label: string, Icon: typeof RefreshCw, dry = true) => (
    <Button variant="outline" size="sm" disabled={!!busy} onClick={() => run(action, dry)}>
      {busy === action ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Icon className="mr-2 h-3.5 w-3.5" />}
      {label}
    </Button>
  );

  return (
    <div className="rounded-lg border border-border bg-card p-6 space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-foreground mb-1">RePORTER PI sync</h2>
        <p className="text-sm text-muted-foreground">
          Determines the PI roster from NIH RePORTER, reading <strong>every fiscal year</strong> of each
          award in temporal order rather than whichever budget year a query happened to return. Grant
          numbers come from the <code className="text-xs">grants</code> table, not a hardcoded list.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {btn("snapshot", "1 · Snapshot RePORTER", RefreshCw)}
        {btn("link", "2 · Link profiles (dry run)", Link2)}
        {btn("drift", "3 · Show drift", GitCompare)}
        {btn("truth", "Ground truth JSON", Download)}
      </div>

      <p className="text-[11px] text-muted-foreground">
        Snapshot only writes to <code>reporter_pi_observations</code>. Link and Reconcile are dry-run
        from these buttons; each has its own Apply below once you have read the result. Reconcile never
        deletes — a person dropping off a RePORTER record revokes pi@ entitlement, so that stays a
        human decision.
      </p>

      {res && (
        <div className="space-y-3 border-t border-border pt-4">
          <div className="flex items-center gap-2 text-xs">
            <Badge variant="secondary">{res.action}</Badge>
            {res.dry_run && <Badge variant="outline" className="text-amber-600 border-amber-500/40">dry run</Badge>}
          </div>

          {!!res.changed_over_time?.length && (
            <div className="text-xs space-y-2">
              <div className="flex items-center gap-1.5 font-medium text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-3.5 w-3.5" />
                {res.changed_over_time.length} project(s) whose PIs changed between fiscal years
              </div>
              {res.changed_over_time.map((p) => (
                <div key={p.grant_number} className="rounded border border-border p-2">
                  <div className="font-mono text-[11px] text-foreground">{p.grant_number}</div>
                  {p.years.map((y) => (
                    <div key={y.fiscal_year} className="text-muted-foreground">
                      FY{y.fiscal_year} · contact {y.contact ?? "—"} · {y.pis.length} PI(s)
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}

          {!!res.drift?.length && (
            <div className="text-xs space-y-1">
              {res.drift.map((d, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2 rounded border border-border px-2 py-1">
                  <span className="font-mono text-[11px]">{d.grant_number}</span>
                  <span className="text-foreground">{d.person}</span>
                  <Badge variant="outline" className="text-[10px]">{d.drift}</Badge>
                  <span className="text-muted-foreground">
                    KG {d.kg_role ?? "—"} · RePORTER {d.reporter_role ?? "—"}
                  </span>
                </div>
              ))}
            </div>
          )}

          {(!!res.ambiguous?.length || !!res.unmatched?.length) && (
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                {(res.ambiguous?.length ?? 0) + (res.unmatched?.length ?? 0)} needing a human
              </summary>
              <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-muted-foreground">
                {[...(res.ambiguous ?? []), ...(res.unmatched ?? [])].map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </details>
          )}

          {res.action === "link" && res.dry_run && (res.linked ?? 0) > 0 && (
            <Button size="sm" disabled={!!busy} onClick={() => run("link", false)}>
              Apply {res.linked} profile link(s)
            </Button>
          )}

          {res.action === "drift" && (
            <Button variant="outline" size="sm" disabled={!!busy} onClick={() => run("reconcile", true)}>
              Preview reconcile
            </Button>
          )}

          {res.action === "reconcile" && res.dry_run && (
            <div className="space-y-2">
              {!!res.unlinked_reporter_pis?.length && (
                <p className="text-[11px] text-amber-600 dark:text-amber-400">
                  {res.unlinked_reporter_pis.length} RePORTER PI(s) have no investigator anchored to
                  their profile_id and will be skipped — run Link first.
                </p>
              )}
              <Button size="sm" disabled={!!busy} onClick={() => run("reconcile", false)}>
                Apply to grant_investigators
              </Button>
              <p className="text-[11px] text-muted-foreground">
                The roster drives pi@ entitlement. Run Group Audit after applying.
              </p>
            </div>
          )}

          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">Raw result</summary>
            <pre className="mt-1 max-h-72 overflow-auto rounded bg-muted/40 p-2 text-[10px] leading-tight">
              {JSON.stringify(res, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}
