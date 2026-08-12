import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Copy, Check, RefreshCw, ExternalLink, AlertTriangle, Hash } from "lucide-react";
import { toast } from "sonner";
import { edgeError } from "@/lib/edgeError";

type BacklogRow = {
  channel_id: string;
  channel_name: string;
  waiting: number;
  oldest_pending: string | null;
  last_surveyed: string | null;
  emails_to_paste: string;
  emails: string[];
  open_channel_url: string;
};

/** Slack channel backlog — the detection is automatic, the click is not.
 *
 *  Slack will not let a BOT add a guest to a channel (admin-only, no scope fixes it), while working-group
 *  choices arrive later from the member on the site. So the add cannot be automated. What CAN be
 *  automated is noticing, continuously, and reducing the human part to its floor.
 *
 *  That floor is ONE PASTE PER CHANNEL. Slack's "Add people to #channel" dialog accepts a list of
 *  addresses, so a channel with nine people waiting costs the same as one with one. Bucketing by person
 *  instead would mean a separate member-management visit each — which is why this panel is organised by
 *  channel even though the underlying records are per (channel, member).
 */
export function SlackBacklogPanel() {
  const queryClient = useQueryClient();
  const [surveying, setSurveying] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const { data: backlog = [], isLoading } = useQuery({
    queryKey: ["slack-backlog"],
    queryFn: async () => {
      const { data, error } = await supabase.from("slack_channel_backlog").select("*");
      if (error) throw error;
      return (data ?? []) as BacklogRow[];
    },
    refetchInterval: 120_000,
  });

  const runSurvey = async () => {
    setSurveying(true);
    try {
      const { data, error } = await supabase.functions.invoke("slack-survey", { body: { action: "survey" } });
      if (error) throw new Error(await edgeError(error, data));
      const r = data as {
        ok?: boolean; error?: string; failures?: string[];
        surveyed?: Array<{ channel: string; missing: number }>;
        guests?: { single_channel: number; multi_channel: number; members: number };
      };
      if (r.error) throw new Error(r.error);
      const missing = (r.surveyed ?? []).reduce((a, s) => a + s.missing, 0);
      toast[missing ? "warning" : "success"](
        missing ? `${missing} membership(s) waiting across ${(r.surveyed ?? []).filter((s) => s.missing).length} channel(s)`
                : "Every channel matches the knowledge graph",
      );
      // Guest counts answer the strategic question: guests need an admin click forever, Members never do.
      if (r.guests) {
        toast.info(
          `Slack accounts: ${r.guests.members} member(s), ${r.guests.multi_channel} multi-channel guest(s), ` +
          `${r.guests.single_channel} single-channel guest(s). Only Members can be added by automation.`,
          { duration: 12000 },
        );
      }
      (r.failures ?? []).forEach((f) => toast.error(f, { duration: 12000 }));
      queryClient.invalidateQueries({ queryKey: ["slack-backlog"] });
    } catch (e: any) {
      toast.error(e?.message ?? "Survey failed");
    } finally {
      setSurveying(false);
    }
  };

  const copy = async (row: BacklogRow) => {
    try {
      await navigator.clipboard.writeText(row.emails_to_paste);
      setCopied(row.channel_id);
      setTimeout(() => setCopied((c) => (c === row.channel_id ? null : c)), 2500);
      toast.success(`${row.waiting} address(es) copied — paste into ${row.channel_name} → Add people`);
    } catch {
      toast.error("Could not copy. Select the addresses below and copy manually.");
    }
  };

  const totalWaiting = backlog.reduce((a, r) => a + r.waiting, 0);
  const lastSurveyed = backlog.map((r) => r.last_surveyed).filter(Boolean).sort().at(-1);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="text-base flex items-center gap-1.5">
            <Hash className="h-4 w-4" />Slack channel backlog
          </CardTitle>
          <CardDescription>
            Who the knowledge graph says belongs in each channel but Slack does not have yet. Detection
            runs automatically; the add itself needs an admin, because Slack refuses to let a bot put a
            guest into a channel. One paste clears a channel however many are waiting.
            {lastSurveyed && (
              <> Last surveyed {new Date(lastSurveyed).toLocaleString()}.</>
            )}
          </CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={runSurvey} disabled={surveying}>
          {surveying ? <Loader2 className="h-4 w-4 animate-spin" />
                     : <><RefreshCw className="mr-1.5 h-4 w-4" />Survey now</>}
        </Button>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
        ) : backlog.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing waiting. Note that an empty list also means "not surveyed yet" if you have never run
            a survey — the backlog is only populated by one.
          </p>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {totalWaiting} membership(s) across {backlog.length} channel(s).
            </p>
            {backlog.map((r) => {
              const days = r.oldest_pending
                ? Math.floor((Date.now() - new Date(r.oldest_pending).getTime()) / 86_400_000)
                : 0;
              return (
                <div key={r.channel_id} className="rounded-md border border-border p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="font-mono text-sm text-foreground">
                      {r.channel_name}
                      <span className="ml-2 font-sans text-xs text-muted-foreground">
                        {r.waiting} waiting
                        {days > 13 && (
                          <span className="ml-1.5 text-amber-600 dark:text-amber-400">
                            <AlertTriangle className="inline h-3 w-3 mr-0.5" />oldest {days} days
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="flex gap-1.5">
                      <Button size="sm" variant="secondary" className="h-7 text-[11px]" onClick={() => copy(r)}>
                        {copied === r.channel_id
                          ? <><Check className="mr-1 h-3 w-3" />Copied</>
                          : <><Copy className="mr-1 h-3 w-3" />Copy {r.waiting} address{r.waiting === 1 ? "" : "es"}</>}
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 text-[11px]" asChild>
                        <a href={r.open_channel_url} target="_blank" rel="noopener noreferrer">
                          <ExternalLink className="mr-1 h-3 w-3" />Open channel
                        </a>
                      </Button>
                    </div>
                  </div>
                  {/* Shown as selectable text as well, so a clipboard failure is never a dead end. */}
                  <div className="text-[11px] text-muted-foreground break-all select-all">{r.emails_to_paste}</div>
                </div>
              );
            })}
            <p className="text-[11px] text-muted-foreground pt-1">
              In Slack: open the channel → <strong>Members</strong> → <strong>Add people</strong> → paste.
              Entries clear themselves on the next survey once the people appear — including ones you add
              by hand, which is the point.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
