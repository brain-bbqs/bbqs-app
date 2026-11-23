import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Link } from "react-router-dom";
import { Megaphone, Plus, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";

interface AnnouncementForm {
  title: string;
  content: string;
  link: string;
  link_text: string;
  is_external_link: boolean;
}

const INITIAL_FORM: AnnouncementForm = {
  title: "",
  content: "",
  link: "",
  link_text: "",
  is_external_link: false,
};

const Announcements = () => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<AnnouncementForm>(INITIAL_FORM);

  const { data: announcements, isLoading } = useQuery({
    queryKey: ["announcements"],
    queryFn: async () => {
      // Named columns: a visitor may not read posted_by (20261117190000), and select("*") asks for it.
      const { data, error } = await (supabase as any)
        .from("announcements")
        .select("id, title, content, link, link_text, is_external_link, organization_id, resource_id, created_at, updated_at")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as any[];
    },
  });

  const postAnnouncement = useMutation({
    mutationFn: async (data: AnnouncementForm) => {
      if (!user) throw new Error("Must be signed in");
      const { error } = await (supabase as any).from("announcements").insert({
        title: data.title,
        content: data.content,
        link: data.link || null,
        link_text: data.link_text || null,
        is_external_link: data.is_external_link,
        posted_by: user.id,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["announcements"] });
      setDialogOpen(false);
      setForm(INITIAL_FORM);
      toast.success("Announcement posted!");
    },
    onError: (err: any) => toast.error(err.message || "Failed to post"),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim() || !form.content.trim()) {
      toast.error("Title and content are required");
      return;
    }
    postAnnouncement.mutate(form);
  };

  const formatMonth = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="relative overflow-hidden border-b border-border">
        <div className="absolute inset-0 bg-gradient-to-br from-primary/8 via-transparent to-accent/5" />
        <div className="relative max-w-5xl mx-auto px-6 py-10">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="h-14 w-14 rounded-2xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center shadow-lg shadow-primary/10 border border-primary/10">
                <Megaphone className="h-7 w-7 text-primary" />
              </div>
              <div>
                <h1 className="text-3xl font-bold text-foreground tracking-tight">Announcements</h1>
                <p className="text-muted-foreground mt-1">
                  New hires, publications, awards, conferences, etc.
                  {announcements?.length ? <span className="text-foreground font-medium"> · {announcements.length} posts</span> : ""}
                </p>
              </div>
            </div>

            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
              <DialogTrigger asChild>
                <Button
                  size="lg"
                  className="gap-2 shadow-lg shadow-primary/20"
                  onClick={(e) => {
                    if (!user) {
                      e.preventDefault();
                      toast.info("Please sign in to post an announcement.");
                      window.location.href = `/auth?redirect=${encodeURIComponent("/announcements")}`;
                    }
                  }}
                >
                  <Plus className="h-4 w-4" />
                  Post Announcement
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>Post an Announcement</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="a-title">Title *</Label>
                    <Input id="a-title" value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="e.g. New Publication in Nature" required />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="a-content">Content *</Label>
                    <Textarea id="a-content" value={form.content} onChange={e => setForm(f => ({ ...f, content: e.target.value }))} placeholder="Describe the announcement..." rows={4} required />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="a-link">Link (optional)</Label>
                    <Input id="a-link" value={form.link} onChange={e => setForm(f => ({ ...f, link: e.target.value }))} placeholder="https://... or /page-path" />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label htmlFor="a-link-text">Link Text</Label>
                      <Input id="a-link-text" value={form.link_text} onChange={e => setForm(f => ({ ...f, link_text: e.target.value }))} placeholder="e.g. Read more" />
                    </div>
                    <div className="flex items-center gap-2 pt-7">
                      <Switch checked={form.is_external_link} onCheckedChange={v => setForm(f => ({ ...f, is_external_link: v }))} />
                      <Label className="text-sm">External link</Label>
                    </div>
                  </div>
                  <Button type="submit" className="w-full" disabled={postAnnouncement.isPending}>
                    {postAnnouncement.isPending ? "Posting..." : "Post Announcement"}
                  </Button>
                </form>
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        {!user && (
          <div className="rounded-xl border border-primary/20 bg-gradient-to-r from-primary/5 to-transparent px-5 py-3.5 text-sm text-muted-foreground flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary shrink-0" />
            <a href="/auth" className="text-primary hover:underline font-medium">Sign in</a> to post an announcement.
          </div>
        )}

        {isLoading ? (
          <div className="space-y-4">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-32 rounded-xl bg-secondary/30 animate-pulse" />
            ))}
          </div>
        ) : announcements?.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <Megaphone className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="text-lg font-medium">No announcements yet</p>
          </div>
        ) : (
          <div className="space-y-4">
            {announcements?.map((a: any) => (
              <Card key={a.id} className="hover:border-primary/20 transition-colors">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-primary font-medium">{formatMonth(a.created_at)}</p>
                    <p className="text-xs text-muted-foreground">{formatDistanceToNow(new Date(a.created_at), { addSuffix: true })}</p>
                  </div>
                  <CardTitle className="text-xl">{a.title}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-muted-foreground">
                    {a.content}
                    {a.link && a.is_external_link ? (
                      <>{" "}<a href={a.link} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{a.link_text || "Learn more"} ↗</a></>
                    ) : a.link ? (
                      <>{" "}<Link to={a.link} className="text-primary hover:underline">{a.link_text || "More details"}</Link></>
                    ) : null}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default Announcements;
