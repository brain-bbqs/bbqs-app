import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MessageSquare, Send, Trash2 } from "lucide-react";
import { format } from "date-fns";
import { recordCurationAudit, showUndoableToast } from "@/lib/curation-audit";

interface Comment {
  id: string;
  content: string;
  user_id?: string;      // only when signed in
  created_at: string;
  profile?: { full_name: string | null; email: string };
}

export function EntityComments({ resourceId }: { resourceId: string }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [newComment, setNewComment] = useState("");

  // A visitor may not read who wrote a comment (user_id, an auth user id: 20261117190000), so it is
  // asked for only when signed in. A visitor could never read the authors' profiles anyway, so the
  // comments read the same to them as before: text, date, no author.
  const signedIn = !!user;
  const { data: comments = [], isLoading } = useQuery({
    queryKey: ["entity-comments", resourceId, signedIn],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("entity_comments")
        .select(signedIn ? "id, content, user_id, created_at" : "id, content, created_at")
        .eq("resource_id", resourceId)
        .order("created_at", { ascending: true });
      if (error) throw error;
      const rows = (data || []) as unknown as { id: string; content: string; user_id?: string; created_at: string }[];

      // Fetch profiles for comment authors
      const userIds = [...new Set(rows.map((c) => c.user_id).filter((u): u is string => !!u))];
      const { data: profiles } = userIds.length
        ? await supabase.from("profiles").select("id, full_name, email").in("id", userIds)
        : { data: [] as { id: string; full_name: string | null; email: string }[] };

      const profileMap = new Map(profiles?.map((p) => [p.id, p]) || []);
      return rows.map((c) => ({
        ...c,
        profile: c.user_id ? profileMap.get(c.user_id) : undefined,
      })) as Comment[];
    },
    enabled: !!resourceId,
  });

  const addComment = useMutation({
    mutationFn: async (content: string) => {
      const { data, error } = await supabase
        .from("entity_comments")
        .insert({ resource_id: resourceId, user_id: user!.id, content })
        .select("id")
        .single();
      if (error) throw error;
      const auditId = await recordCurationAudit({
        entity_type: "entity_comment",
        action: "create",
        entity_id: data.id,
        resource_id: resourceId,
        before_value: null,
        after_value: { resource_id: resourceId, user_id: user!.id, content },
        source: "entity_comments",
      });
      return auditId;
    },
    onSuccess: (auditId) => {
      queryClient.invalidateQueries({ queryKey: ["entity-comments", resourceId] });
      setNewComment("");
      showUndoableToast({
        title: "Comment added",
        auditId,
        onReverted: () => queryClient.invalidateQueries({ queryKey: ["entity-comments", resourceId] }),
      });
    },
  });

  const deleteComment = useMutation({
    mutationFn: async (commentId: string) => {
      // Snapshot before deletion so revert can restore
      const { data: prev } = await supabase
        .from("entity_comments")
        // signed-in only: deleting is for the comment's author, so user_id is readable here
        .select("id, resource_id, user_id, parent_id, content, created_at")
        .eq("id", commentId)
        .maybeSingle();
      const { error } = await supabase.from("entity_comments").delete().eq("id", commentId);
      if (error) throw error;
      const auditId = await recordCurationAudit({
        entity_type: "entity_comment",
        action: "delete",
        entity_id: commentId,
        resource_id: resourceId,
        before_value: prev ?? null,
        after_value: null,
        source: "entity_comments",
      });
      return auditId;
    },
    onSuccess: (auditId) => {
      queryClient.invalidateQueries({ queryKey: ["entity-comments", resourceId] });
      showUndoableToast({
        title: "Comment deleted",
        auditId,
        onReverted: () => queryClient.invalidateQueries({ queryKey: ["entity-comments", resourceId] }),
      });
    },
  });

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
        <MessageSquare className="h-4 w-4" />
        Comments ({comments.length})
      </h3>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading comments…</p>
      ) : comments.length === 0 ? (
        <p className="text-sm text-muted-foreground italic">No comments yet.</p>
      ) : (
        <div className="space-y-3">
          {comments.map((c) => (
            <div key={c.id} className="rounded-lg border border-border bg-card p-3 space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-foreground">
                  {c.profile?.full_name || c.profile?.email || "Unknown"}
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {format(new Date(c.created_at), "MMM d, yyyy 'at' h:mm a")}
                  </span>
                  {/* Both sides must be set: a visitor has neither, and undefined === undefined. */}
                  {!!user && !!c.user_id && user.id === c.user_id && (
                    <button
                      onClick={() => deleteComment.mutate(c.id)}
                      className="text-muted-foreground hover:text-destructive transition-colors"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </div>
              <p className="text-sm text-foreground whitespace-pre-wrap">{c.content}</p>
            </div>
          ))}
        </div>
      )}

      {user ? (
        <div className="flex gap-2">
          <Textarea
            value={newComment}
            onChange={(e) => setNewComment(e.target.value)}
            placeholder="Add a comment…"
            className="min-h-[60px] text-sm"
          />
          <Button
            size="sm"
            onClick={() => newComment.trim() && addComment.mutate(newComment.trim())}
            disabled={!newComment.trim() || addComment.isPending}
            className="shrink-0"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground italic">Sign in to leave a comment.</p>
      )}
    </div>
  );
}
