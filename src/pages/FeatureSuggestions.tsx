import { useState, useMemo, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useUserTier } from "@/hooks/useUserTier";
import { toast } from "sonner";
import { Lightbulb, Star, Loader2, Send, Search } from "lucide-react";
import { Link } from "react-router-dom";
import { format } from "date-fns";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import "ag-grid-community/styles/ag-grid.css";

interface Suggestion {
  id: string;
  title: string;
  description: string | null;
  submitter_name: string | null;
  github_issue_number: number | null;
  github_issue_url: string | null;
  status: string;
  votes: number;
  created_at: string;
  github_username: string | null;
  qa_status: string | null;
  target_version: string | null;
}

const QA_STAGES = ["submitted", "triage", "in-qa", "approved", "merged", "declined"] as const;

const QA_VARIANT: Record<string, "secondary" | "outline" | "default" | "destructive"> = {
  submitted: "secondary",
  triage: "secondary",
  "in-qa": "outline",
  approved: "default",
  merged: "default",
  declined: "destructive",
};

interface Vote {
  suggestion_id: string;
}

export default function FeatureSuggestions() {
  const { user } = useAuth();
  const { isCurator } = useUserTier();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [githubUsername, setGithubUsername] = useState("");
  const [search, setSearch] = useState("");
  const [qaFilter, setQaFilter] = useState<string>("all");

  const { data: suggestions = [], isLoading } = useQuery<Suggestion[]>({
    queryKey: ["feature-suggestions"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("feature_suggestions_public" as any)
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return ((data || []) as any[]).map((r) => ({
        ...r,
        submitter_name: null,
      })) as Suggestion[];
    },
  });

  const { data: userVotes = [] } = useQuery<Vote[]>({
    queryKey: ["user-votes", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("feature_votes")
        .select("suggestion_id")
        .eq("user_id", user!.id);
      if (error) throw error;
      return (data || []) as Vote[];
    },
  });

  const votedIds = useMemo(() => new Set(userVotes.map((v) => v.suggestion_id)), [userVotes]);

  const submitMutation = useMutation({
    mutationFn: async () => {
      const { data: ghData, error: ghError } = await supabase.functions.invoke("create-github-issue", {
        body: {
          title: `[Feature Request] ${title.trim()}`,
          description: `**User Request**\n\n${description.trim() || "No description provided."}\n\n---\n_Submitted via BBQS Feature Suggestions_`,
          labels: ["enhancement", "user-request", "claude"],
        },
      });
      if (ghError) throw ghError;

      const { error: dbError } = await supabase.from("feature_suggestions").insert({
        title: title.trim(),
        description: description.trim() || null,
        submitted_by: user?.id || null,
        github_username: githubUsername.trim().replace(/^@/, "") || null,
        submitter_name:
          (user?.user_metadata?.full_name as string | undefined)?.trim() ||
          user?.email?.split("@")[0] ||
          null,
        github_issue_number: ghData?.issue?.number || null,
        github_issue_url: ghData?.issue?.url || null,
      });
      if (dbError) throw dbError;
    },
    onSuccess: () => {
      toast.success("Feature suggestion submitted!");
      setTitle("");
      setDescription("");
      queryClient.invalidateQueries({ queryKey: ["feature-suggestions"] });
    },
    onError: (err: any) => {
      toast.error(err.message || "Failed to submit suggestion");
    },
  });

  const trackingMutation = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Record<string, string | null> }) => {
      const { error } = await supabase.from("feature_suggestions").update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Tracking updated");
      queryClient.invalidateQueries({ queryKey: ["feature-suggestions"] });
    },
    onError: (err: any) => toast.error(err.message || "Could not update tracking"),
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return suggestions.filter((s) => {
      if (qaFilter !== "all" && (s.qa_status || "submitted") !== qaFilter) return false;
      if (!q) return true;
      return [s.title, s.description, s.github_username, s.target_version, String(s.github_issue_number ?? "")]
        .filter(Boolean)
        .some((v) => (v as string).toLowerCase().includes(q));
    });
  }, [suggestions, search, qaFilter]);

  const voteMutation = useMutation({
    mutationFn: async (suggestionId: string) => {
      const hasVoted = votedIds.has(suggestionId);
      if (hasVoted) {
        await supabase.from("feature_votes").delete().eq("user_id", user!.id).eq("suggestion_id", suggestionId);
        await supabase.rpc("decrement_vote_count", { _suggestion_id: suggestionId });
      } else {
        await supabase.from("feature_votes").insert({ user_id: user!.id, suggestion_id: suggestionId });
        await supabase.rpc("increment_vote_count", { _suggestion_id: suggestionId });
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["feature-suggestions"] });
      queryClient.invalidateQueries({ queryKey: ["user-votes"] });
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) { toast.error("Please enter a title"); return; }
    if (title.length > 200) { toast.error("Title must be under 200 characters"); return; }
    if (description.length > 2000) { toast.error("Description must be under 2000 characters"); return; }
    submitMutation.mutate();
  };

  const VoteCellRenderer = useCallback((params: ICellRendererParams) => {
    const s = params.data as Suggestion;
    const hasVoted = votedIds.has(s.id);
    return (
      <button
        onClick={() => user ? voteMutation.mutate(s.id) : toast.error("Sign in to vote")}
        className={`flex items-center gap-1 transition-colors ${hasVoted ? "text-primary" : "text-muted-foreground hover:text-foreground"}`}
        title={hasVoted ? "Remove vote" : "Vote for this"}
      >
        <Star className={`h-4 w-4 ${hasVoted ? "fill-primary" : ""}`} />
        <span className="text-xs font-semibold">{s.votes}</span>
      </button>
    );
  }, [user, votedIds, voteMutation]);

  const colDefs = useMemo<ColDef[]>(() => [
    {
      headerName: "Votes",
      field: "votes",
      width: 90,
      cellRenderer: VoteCellRenderer,
      sortable: true,
      unSortIcon: true,
    },
    {
      headerName: "Title",
      field: "title",
      flex: 2,
      sortable: true,
      unSortIcon: true,
      wrapText: true,
      autoHeight: true,
    },
    {
      headerName: "Status",
      field: "status",
      width: 110,
      sortable: true,
      unSortIcon: true,
      cellRenderer: (params: ICellRendererParams) => (
        <Badge variant={params.value === "open" ? "secondary" : "outline"} className="text-[10px]">
          {params.value}
        </Badge>
      ),
    },
    {
      headerName: "QA stage",
      field: "qa_status",
      width: 130,
      sortable: true,
      unSortIcon: true,
      editable: isCurator,
      cellEditor: "agSelectCellEditor",
      cellEditorParams: { values: QA_STAGES },
      cellRenderer: (params: ICellRendererParams) => {
        const v = (params.value as string) || "submitted";
        return <Badge variant={QA_VARIANT[v] || "outline"} className="text-[10px]">{v}</Badge>;
      },
    },
    {
      headerName: "Version",
      field: "target_version",
      width: 110,
      sortable: true,
      unSortIcon: true,
      editable: isCurator,
      valueFormatter: (p) => p.value || "—",
    },
    {
      headerName: "GitHub ID",
      field: "github_username",
      width: 130,
      sortable: true,
      unSortIcon: true,
      cellRenderer: (params: ICellRendererParams) =>
        params.value ? (
          <a href={`https://github.com/${params.value}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
            @{params.value}
          </a>
        ) : null,
    },
    {
      headerName: "Submitted",
      field: "created_at",
      width: 130,
      sortable: true,
      sort: "desc",
      unSortIcon: true,
      valueFormatter: (params) => format(new Date(params.value), "MMM d, yyyy"),
    },
    {
      headerName: "By",
      field: "submitter_name",
      flex: 1,
      sortable: true,
      unSortIcon: true,
    },
    {
      headerName: "GitHub",
      field: "github_issue_url",
      width: 100,
      suppressCellFocus: true,
      cellRenderer: (params: ICellRendererParams) => {
        const s = params.data as Suggestion;
        if (!s.github_issue_url) return null;
        return (
          <a
            href={s.github_issue_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline font-medium"
          >
            #{s.github_issue_number}
          </a>
        );
      },
    },
  ], [VoteCellRenderer, isCurator]);

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-8">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center">
          <Lightbulb className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-foreground">Give Feedback</h1>
          <p className="text-sm text-muted-foreground">Help improve the BBQS platform — your suggestions become tracked GitHub issues</p>
        </div>
      </div>

      {/* Submit form */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Submit Feedback</CardTitle>
        </CardHeader>
        <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="suggestion-title">Title</Label>
                <Input
                  id="suggestion-title"
                  placeholder="e.g. Add dark mode toggle, Improve search filters..."
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={200}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="suggestion-desc">Description (optional)</Label>
                <Textarea
                  id="suggestion-desc"
                  placeholder="Describe the feature, why it would be useful, and any ideas for how it could work..."
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={2000}
                  rows={4}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="suggestion-gh">Your GitHub ID (optional)</Label>
                <Input
                  id="suggestion-gh"
                  placeholder="e.g. octocat"
                  value={githubUsername}
                  onChange={(e) => setGithubUsername(e.target.value)}
                  maxLength={64}
                />
              </div>
              <Button type="submit" disabled={submitMutation.isPending}>
                {submitMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Send className="h-4 w-4 mr-2" />
                )}
                Submit Feedback
              </Button>
            </form>
        </CardContent>
      </Card>

      {/* Suggestions AG Grid table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">All Suggestions</CardTitle>
          <div className="flex flex-wrap items-center gap-2 pt-3">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                className="pl-8"
                placeholder="Search suggestions, GitHub ID, issue #, version..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Select value={qaFilter} onValueChange={setQaFilter}>
              <SelectTrigger className="w-[160px]"><SelectValue placeholder="QA stage" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All QA stages</SelectItem>
                {QA_STAGES.map((s) => (
                  <SelectItem key={s} value={s}>{s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-xs text-muted-foreground">{filtered.length} shown</span>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="ag-grid-mobile-wrapper">
            <div className="ag-theme-custom">
              <AgGridReact
                rowData={filtered}
                columnDefs={colDefs}
                domLayout="autoHeight"
                suppressCellFocus={true}
                pagination={true}
                paginationPageSize={25}
                defaultColDef={{ resizable: true, sortable: true, unSortIcon: true }}
                onCellValueChanged={(e) => {
                  const field = e.colDef.field;
                  if (!field || !isCurator) return;
                  if (field !== "qa_status" && field !== "target_version") return;
                  trackingMutation.mutate({
                    id: (e.data as Suggestion).id,
                    patch: { [field]: (e.newValue as string)?.trim() || null },
                  });
                }}
              />
            </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
