import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useUserTier } from "@/hooks/useUserTier";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Lightbulb, Loader2, Send, Search } from "lucide-react";
import { format } from "date-fns";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-alpine.css";
import "@/styles/ag-grid-theme.css";

interface Suggestion {
  id: string;
  title: string;
  description: string | null;
  submitter_name: string | null;
  github_username: string | null;
  github_issue_number: number | null;
  github_issue_url: string | null;
  status: string;
  qa_status: string | null;
  target_version: string | null;
  created_at: string;
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
        .limit(200);
      if (error) throw error;
      return (data || []) as unknown as Suggestion[];
    },
  });

  const submitMutation = useMutation({
    mutationFn: async () => {
      const { data: ghData, error: ghError } = await supabase.functions.invoke("create-github-issue", {
        body: {
          title: `[Feature Request] ${title.trim()}`,
          description: `**User Request**\n\n${description.trim() || "No description provided."}\n\n---\n_Submitted via BBQS Suggest a Feature_`,
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
      toast.success("Suggestion submitted!");
      setTitle("");
      setDescription("");
      queryClient.invalidateQueries({ queryKey: ["feature-suggestions"] });
    },
    onError: (err: any) => toast.error(err.message || "Failed to submit suggestion"),
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
    return suggestions.filter((s) =>
      qaFilter === "all" ? true : (s.qa_status || "submitted") === qaFilter,
    );
  }, [suggestions, qaFilter]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) { toast.error("Please enter a title"); return; }
    if (title.length > 200) { toast.error("Title must be under 200 characters"); return; }
    if (description.length > 2000) { toast.error("Description must be under 2000 characters"); return; }
    submitMutation.mutate();
  };

  const columnDefs = useMemo<ColDef<Suggestion>[]>(() => [
    { headerName: "Suggestion", field: "title", flex: 2, minWidth: 220, wrapText: true, autoHeight: true },
    {
      headerName: "Submitted by",
      field: "submitter_name",
      flex: 1,
      minWidth: 150,
      valueGetter: (p) => p.data?.submitter_name || (p.data?.github_username ? `@${p.data.github_username}` : "—"),
    },
    {
      headerName: "GitHub ID",
      field: "github_username",
      width: 130,
      cellRenderer: (p: ICellRendererParams) =>
        p.value ? (
          <a href={`https://github.com/${p.value}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
            @{p.value}
          </a>
        ) : <span className="text-muted-foreground">—</span>,
    },
    {
      headerName: "Issue",
      field: "github_issue_number",
      width: 100,
      cellRenderer: (p: ICellRendererParams) => {
        const s = p.data as Suggestion;
        if (!s.github_issue_url) return <span className="text-muted-foreground">—</span>;
        return (
          <a href={s.github_issue_url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline font-medium">
            #{s.github_issue_number}
          </a>
        );
      },
    },
    {
      headerName: "Status",
      field: "status",
      width: 110,
      cellRenderer: (p: ICellRendererParams) => (
        <Badge variant={p.value === "open" ? "secondary" : "outline"} className="text-[10px]">{p.value}</Badge>
      ),
    },
    {
      headerName: "QA stage",
      field: "qa_status",
      width: 130,
      editable: isCurator,
      cellEditor: "agSelectCellEditor",
      cellEditorParams: { values: QA_STAGES },
      cellRenderer: (p: ICellRendererParams) => {
        const v = (p.value as string) || "submitted";
        return <Badge variant={QA_VARIANT[v] || "outline"} className="text-[10px]">{v}</Badge>;
      },
    },
    {
      headerName: "Version",
      field: "target_version",
      width: 110,
      editable: isCurator,
      valueFormatter: (p) => p.value || "—",
    },
    {
      headerName: "Submitted",
      field: "created_at",
      width: 130,
      sort: "desc",
      valueFormatter: (p) => (p.value ? format(new Date(p.value), "MMM d, yyyy") : "—"),
    },
  ], [isCurator]);

  const defaultColDef = useMemo<ColDef>(() => ({
    sortable: true,
    resizable: true,
    unSortIcon: true,
    filter: false,
  }), []);

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center">
          <Lightbulb className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-foreground">Suggest a Feature</h1>
          <p className="text-sm text-muted-foreground">
            Suggest an improvement — each suggestion becomes a tracked GitHub issue with a QA stage and target version
          </p>
        </div>
      </div>

      {/* Search first */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Search suggestions, person, GitHub ID, issue #, version..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select value={qaFilter} onValueChange={setQaFilter}>
          <SelectTrigger className="w-[170px]"><SelectValue placeholder="QA stage" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All QA stages</SelectItem>
            {QA_STAGES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-10">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="ag-theme-alpine rounded-lg border border-border overflow-hidden" style={{ width: "100%" }}>
          <AgGridReact<Suggestion>
            rowData={filtered}
            columnDefs={columnDefs}
            defaultColDef={defaultColDef}
            quickFilterText={search}
            animateRows={true}
            domLayout="autoHeight"
            suppressCellFocus={true}
            enableCellTextSelection={true}
            headerHeight={40}
            pagination={true}
            paginationPageSize={25}
            onCellValueChanged={(e) => {
              const field = e.colDef.field;
              if (!isCurator || (field !== "qa_status" && field !== "target_version")) return;
              trackingMutation.mutate({
                id: (e.data as Suggestion).id,
                patch: { [field]: (e.newValue as string)?.trim() || null },
              });
            }}
          />
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Suggest an improvement</CardTitle>
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
              {submitMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Send className="h-4 w-4 mr-2" />}
              Submit suggestion
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
