import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Check, X, ExternalLink, RefreshCw, Newspaper } from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";

type Candidate = {
  id: string;
  source: string;
  title: string;
  url: string;
  summary: string | null;
  author: string | null;
  published_at: string | null;
  matched_keywords: string[];
  score: number;
  status: string;
  created_at: string;
};

export function NewsRadarPanel() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<"pending" | "approved" | "rejected" | "posted">("pending");
  const [notes, setNotes] = useState<Record<string, string>>({});

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["news_candidates", filter],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("news_candidates")
        .select("*")
        .eq("status", filter)
        .order("published_at", { ascending: false, nullsFirst: false })
        .limit(100);
      if (error) throw error;
      return data as Candidate[];
    },
  });

  const pollNow = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke("news-radar-poll", { body: {} });
      if (error) throw error;
      return data;
    },
    onSuccess: (d: any) => {
      toast.success(`Polled feeds — ${d?.totalInserted ?? 0} new candidates`);
      qc.invalidateQueries({ queryKey: ["news_candidates"] });
    },
    onError: (e: any) => toast.error(e.message || "Poll failed"),
  });

  const approve = useMutation({
    mutationFn: async (c: Candidate) => {
      if (!user) throw new Error("Sign in required");
      const { data: ann, error: annErr } = await (supabase as any)
        .from("announcements")
        .insert({
          title: c.title,
          content: c.summary || c.title,
          link: c.url,
          link_text: `Read on ${c.source}`,
          is_external_link: true,
          posted_by: user.id,
        })
        .select("id")
        .single();
      if (annErr) throw annErr;
      const { error } = await (supabase as any)
        .from("news_candidates")
        .update({
          status: "posted",
          announcement_id: ann.id,
          reviewed_by: user.id,
          reviewed_at: new Date().toISOString(),
          review_notes: notes[c.id] || null,
        })
        .eq("id", c.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Posted to Announcements");
      qc.invalidateQueries({ queryKey: ["news_candidates"] });
      qc.invalidateQueries({ queryKey: ["announcements"] });
    },
    onError: (e: any) => toast.error(e.message || "Approve failed"),
  });

  const reject = useMutation({
    mutationFn: async (c: Candidate) => {
      if (!user) throw new Error("Sign in required");
      const { error } = await (supabase as any)
        .from("news_candidates")
        .update({
          status: "rejected",
          reviewed_by: user.id,
          reviewed_at: new Date().toISOString(),
          review_notes: notes[c.id] || null,
        })
        .eq("id", c.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Rejected");
      qc.invalidateQueries({ queryKey: ["news_candidates"] });
    },
    onError: (e: any) => toast.error(e.message || "Reject failed"),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Newspaper className="h-5 w-5 text-primary" />
            News Radar
          </h2>
          <p className="text-sm text-muted-foreground">
            Curated science-news candidates. Approve to post directly to the Announcements page.
            Feeds are polled automatically each night.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border border-border overflow-hidden text-sm">
            {(["pending", "approved", "rejected", "posted"] as const).map((s) => (
              <button
                key={s}
                onClick={() => setFilter(s)}
                className={`px-3 py-1.5 capitalize ${
                  filter === s ? "bg-primary text-primary-foreground" : "bg-background hover:bg-muted"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          <Button variant="outline" size="sm" onClick={() => pollNow.mutate()} disabled={pollNow.isPending}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${pollNow.isPending ? "animate-spin" : ""}`} />
            Poll now
          </Button>
          <Button variant="ghost" size="sm" onClick={() => refetch()}>Refresh</Button>
        </div>
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : !data?.length ? (
        <div className="text-center py-12 text-muted-foreground border border-dashed border-border rounded-lg">
          <Newspaper className="h-8 w-8 mx-auto mb-2 opacity-40" />
          <p>No {filter} candidates.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {data.map((c) => (
            <Card key={c.id}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle className="text-base leading-snug">
                      <a href={c.url} target="_blank" rel="noopener noreferrer" className="hover:underline inline-flex items-start gap-1.5">
                        {c.title}
                        <ExternalLink className="h-3.5 w-3.5 mt-1 shrink-0 opacity-60" />
                      </a>
                    </CardTitle>
                    <div className="text-xs text-muted-foreground mt-1 flex flex-wrap items-center gap-2">
                      <span className="font-medium">{c.source}</span>
                      {c.author && <span>· {c.author}</span>}
                      {c.published_at && (
                        <span>· {formatDistanceToNow(new Date(c.published_at), { addSuffix: true })}</span>
                      )}
                      <span>· score {c.score}</span>
                    </div>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {c.summary && <p className="text-sm text-muted-foreground line-clamp-3">{c.summary}</p>}
                <div className="flex flex-wrap gap-1.5">
                  {c.matched_keywords.slice(0, 8).map((k) => (
                    <Badge key={k} variant="secondary" className="text-[10px]">{k}</Badge>
                  ))}
                </div>
                {filter === "pending" && (
                  <div className="space-y-2">
                    <Textarea
                      placeholder="Optional review note…"
                      value={notes[c.id] || ""}
                      onChange={(e) => setNotes((n) => ({ ...n, [c.id]: e.target.value }))}
                      rows={2}
                      className="text-sm"
                    />
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => approve.mutate(c)} disabled={approve.isPending}>
                        <Check className="h-4 w-4 mr-1" /> Approve & post
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => reject.mutate(c)} disabled={reject.isPending}>
                        <X className="h-4 w-4 mr-1" /> Reject
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}