import { useState, useEffect } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useProfile } from "@/hooks/useProfile";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { User, Building2, FolderOpen, History, LogOut, LogIn, Pencil, Check, X, Sun, Moon, Monitor } from "lucide-react";
import { useTheme } from "@/contexts/ThemeContext";
import { useNavigate } from "react-router-dom";
import { useEntitySummary } from "@/contexts/EntitySummaryContext";
import { MemberProfileEditor } from "@/components/profile/MemberProfileEditor";
import { InvestigatorSummary } from "@/components/entity-summary/summaries/InvestigatorSummary";
import { format } from "date-fns";
import { toast } from "sonner";

export default function Profile() {
  const { user, signOut, loading: authLoading } = useAuth();
  const { profile, isLoading: profileLoading, refetch } = useProfile();
  const navigate = useNavigate();
  const { open } = useEntitySummary();
  const queryClient = useQueryClient();
  const { theme, setTheme } = useTheme();
  const [editing, setEditing] = useState(false);
  const [nameValue, setNameValue] = useState("");
  const [saving, setSaving] = useState(false);

  const startEditing = () => {
    setNameValue(profile?.full_name || "");
    setEditing(true);
  };

  const saveName = async () => {
    if (!user) return;
    setSaving(true);
    const trimmed = nameValue.trim();
    const { error } = await supabase
      .from("profiles")
      .update({ full_name: trimmed || null })
      .eq("id", user.id);
    if (error) {
      setSaving(false);
      toast.error("Failed to update name");
      return;
    }
    if (linkedInvestigator?.id && trimmed) {
      await supabase
        .from("investigators")
        .update({ name: trimmed })
        .eq("id", linkedInvestigator.id);
    }
    await queryClient.invalidateQueries({ queryKey: ["profile", user.id] });
    await refetch();
    setSaving(false);
    setEditing(false);
    toast.success("Name updated");
  };

  // Resolve THIS user's investigator record. Prefer the robust user_id link (how the
  // agent and the entity pane resolve it); fall back to email match only for legacy
  // rows not yet linked. Resolving the same record — and rendering the same
  // InvestigatorSummary below — is what keeps the profile page and the pane in exact sync.
  const { data: linkedInvestigator } = useQuery({
    queryKey: ["profile-investigator", user?.id, user?.email],
    enabled: !!user?.id || !!user?.email,
    queryFn: async () => {
      let { data } = await supabase
        .from("investigators")
        .select("id, name, resource_id")
        .eq("user_id", user!.id)
        .maybeSingle();
      if (!data && user?.email) {
        ({ data } = await supabase
          .from("investigators")
          .select("id, name, resource_id")
          .ilike("email", user.email)
          .maybeSingle());
      }
      return data;
    },
  });

  // Fetch user's organization name
  const { data: orgName } = useQuery({
    queryKey: ["org-name", profile?.organization_id],
    enabled: !!profile?.organization_id,
    queryFn: async () => {
      const { data } = await supabase
        .from("organizations")
        .select("name")
        .eq("id", profile!.organization_id!)
        .maybeSingle();
      return data?.name || "Unknown";
    },
  });

  // Fetch the user's own grants (via their linked investigator record)
  const { data: editableProjects = [] } = useQuery({
    queryKey: ["my-grants", linkedInvestigator?.id],
    enabled: !!linkedInvestigator?.id,
    queryFn: async () => {
      const { data: grantInvs } = await supabase
        .from("grant_investigators")
        .select("grant_id, role")
        .eq("investigator_id", linkedInvestigator!.id);
      if (!grantInvs?.length) return [];

      const grantIds = [...new Set(grantInvs.map((gi) => gi.grant_id).filter(Boolean))];
      if (!grantIds.length) return [];
      const { data: grants } = await supabase
        .from("grants")
        .select("id, grant_number, title, resource_id")
        .in("id", grantIds);
      const roleByGrant = new Map(grantInvs.map((gi) => [gi.grant_id, gi.role]));
      return (grants || []).map((g) => ({ ...g, role: roleByGrant.get(g.id) }));
    },
  });

  // Your edit history from the universal provenance store (data_audit_log), which
  // captures EVERY change keyed on auth.uid() — including direct profile edits. (The
  // old edit_history table only logged some paths, so it looked empty.) Reading your
  // own rows requires the "actors read own data audit" RLS policy on data_audit_log.
  const { data: editHistory = [] } = useQuery({
    queryKey: ["user-edit-history", user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const { data } = await supabase
        .from("data_audit_log")
        .select("id, table_name, operation, changed_fields, occurred_at")
        .eq("actor_id", user!.id)
        .order("occurred_at", { ascending: false })
        .limit(20);
      return data || [];
    },
  });

  // Deep-link: scroll to #section once the page is rendered
  useEffect(() => {
    if (!user) return;
    const id = window.location.hash.replace(/^#/, "");
    if (!id) return;
    const t = setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 200);
    return () => clearTimeout(t);
  }, [user, editableProjects.length, editHistory.length]);

  // Loading state
  if (authLoading) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
        <Card>
          <CardContent className="p-8">
            <div className="flex items-center gap-4">
              <Skeleton className="h-14 w-14 rounded-full" />
              <div className="space-y-2">
                <Skeleton className="h-6 w-48" />
                <Skeleton className="h-4 w-32" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Signed-out state
  if (!user) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <Card>
          <CardContent className="p-12 flex flex-col items-center text-center gap-4">
            <div className="h-16 w-16 rounded-full bg-muted flex items-center justify-center">
              <User className="h-8 w-8 text-muted-foreground" />
            </div>
            <div>
              <h2 className="text-xl font-semibold text-foreground mb-1">Sign in to view your profile</h2>
              <p className="text-sm text-muted-foreground max-w-sm">
                Log in with your university email to access your projects, chat history, and metadata edits.
              </p>
            </div>
            <Button onClick={() => navigate("/auth")} className="mt-2">
              <LogIn className="h-4 w-4 mr-2" />
              Sign In
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const openInvestigatorCard = async () => {
    const displayName = profile?.full_name || linkedInvestigator?.name;
    // Prefer the investigator we've already linked by email (we have its id) over a
    // fragile last-name match — and fall back to the investigator name when the
    // profiles.full_name is unset, so the card opens even when full_name is empty.
    if (linkedInvestigator?.id) {
      const { data: inv } = await supabase
        .from("investigators")
        .select("id, resource_id")
        .eq("id", linkedInvestigator.id)
        .maybeSingle();
      if (inv) open({ type: "investigator", id: inv.id, resourceId: inv.resource_id || undefined, label: displayName || "Investigator" });
      return;
    }
    if (!displayName) return;
    const lastName = displayName.split(" ").pop() || "";
    const { data: inv } = await supabase
      .from("investigators")
      .select("id, resource_id")
      .ilike("name", `%${lastName}%`)
      .maybeSingle();
    if (inv) open({ type: "investigator", id: inv.id, resourceId: inv.resource_id || undefined, label: displayName });
  };

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 space-y-6">
      {/* Self-serve profile editing (benign fields direct; working groups = request for admin approval) */}
      <MemberProfileEditor />

      {/* Profile header */}
      <Card id="overview" className="scroll-mt-20">
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <button
                onClick={openInvestigatorCard}
                className="h-14 w-14 rounded-full bg-primary/10 flex items-center justify-center hover:bg-primary/20 transition-colors cursor-pointer"
                title="View your investigator entity card"
              >
                <User className="h-7 w-7 text-primary" />
              </button>
              <div>
                {profileLoading ? (
                  <Skeleton className="h-6 w-48" />
                ) : editing ? (
                  <div className="flex items-center gap-2">
                    <Input
                      value={nameValue}
                      onChange={(e) => setNameValue(e.target.value)}
                      placeholder="Enter your name"
                      className="h-8 w-56 text-sm"
                      autoFocus
                      onKeyDown={(e) => e.key === "Enter" && saveName()}
                    />
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={saveName} disabled={saving}>
                      <Check className="h-4 w-4" />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setEditing(false)}>
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={openInvestigatorCard}
                        className="text-xl font-semibold text-primary hover:underline cursor-pointer"
                      >
                        {profile?.full_name || linkedInvestigator?.name || "No name set"}
                      </button>
                      <Button size="icon" variant="ghost" className="h-7 w-7" onClick={startEditing}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <p className="text-sm text-muted-foreground">{profile?.email}</p>
                  </>
                )}
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => signOut().then(() => navigate("/auth"))}>
              <LogOut className="h-4 w-4 mr-2" />
              Sign Out
            </Button>
          </div>
        </CardHeader>
        {orgName && (
          <CardContent className="pt-0">
            <button
              onClick={async () => {
                if (!profile?.organization_id) return;
                const { data: org } = await supabase
                  .from("organizations")
                  .select("id, resource_id")
                  .eq("id", profile.organization_id)
                  .maybeSingle();
                if (org) {
                  open({ type: "organization", id: org.id, resourceId: org.resource_id || undefined, label: orgName });
                }
              }}
              className="flex items-center gap-2 text-primary hover:underline cursor-pointer"
            >
              <Building2 className="h-4 w-4" />
              <span className="text-sm">{orgName}</span>
            </button>
          </CardContent>
        )}
      </Card>

      {/* Skills & Research Areas */}
      {/* Appearance */}
      <Card id="appearance" className="scroll-mt-20">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Sun className="h-4 w-4" />
            Appearance
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-3">
            Choose your preferred color theme. Your choice is saved to your account and applied on every device.
          </p>
          <div className="grid grid-cols-3 gap-2 max-w-md">
            {([
              { key: "light", label: "Light", icon: Sun },
              { key: "dark", label: "Dark", icon: Moon },
              { key: "system", label: "System", icon: Monitor },
            ] as const).map(({ key, label, icon: Icon }) => (
              <Button
                key={key}
                variant={theme === key ? "default" : "outline"}
                size="sm"
                onClick={() => setTheme(key)}
                className="justify-start gap-2"
              >
                <Icon className="h-4 w-4" />
                {label}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Investigator record — rendered from the SAME component as the entity pane, so
          the profile page and the pane always reflect exactly the same fields, values,
          and editors (skills, research areas, working groups, secondary emails, ORCID,
          institution, species, role, grants). Single source of truth; cannot drift. */}
      {linkedInvestigator && (
        <Card id="record" className="scroll-mt-20">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <User className="h-4 w-4" />
              Investigator Record
            </CardTitle>
          </CardHeader>
          <CardContent>
            <InvestigatorSummary id={linkedInvestigator.id} />
          </CardContent>
        </Card>
      )}

      {/* Editable projects */}
      <Card id="projects" className="scroll-mt-20">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <FolderOpen className="h-4 w-4" />
            Your Projects
          </CardTitle>
        </CardHeader>
        <CardContent>
          {editableProjects.length === 0 ? (
            <p className="text-sm text-muted-foreground">You're not listed on any grants yet.</p>
          ) : (
            <div className="space-y-2">
              {editableProjects.map((p: any) => (
                <button
                  key={p.id || p.grant_number}
                  onClick={() =>
                    open({ type: "grant", id: p.id, resourceId: p.resource_id || undefined, label: p.title || p.grant_number })
                  }
                  className="w-full flex items-center justify-between py-2 border-b border-border last:border-0 text-left hover:bg-accent/50 rounded px-2 transition-colors"
                >
                  <div>
                    <p className="text-sm font-medium text-primary hover:underline">{p.title}</p>
                    <p className="text-xs text-muted-foreground">{p.grant_number}</p>
                  </div>
                  <Badge variant="secondary" className="text-xs">
                    {(() => {
                      switch (p.role) {
                        case "pi":
                        case "contact_pi": return "PI";
                        case "co_pi": return "Co-PI";
                        case "mpi": return "MPI";
                        case "collaborator": return "Collaborator";
                        case "trainee": return "Trainee";
                        case "staff": return "Staff";
                        default: return p.role || "Member";
                      }
                    })()}
                  </Badge>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Edit history / data provenance */}
      <Card id="edits" className="scroll-mt-20">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <History className="h-4 w-4" />
            Data Provenance (Your Edits)
          </CardTitle>
        </CardHeader>
        <CardContent>
          {editHistory.length === 0 ? (
            <p className="text-sm text-muted-foreground">No edits recorded yet.</p>
          ) : (
            <div className="space-y-2">
              {editHistory.map((e: any) => {
                const fields = e.changed_fields ? Object.keys(e.changed_fields) : [];
                const verb = e.operation === "INSERT" ? "Created" : e.operation === "DELETE" ? "Deleted" : "Updated";
                return (
                  <div key={e.id} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                    <div>
                      <p className="text-sm text-foreground">
                        <span className="font-medium">{verb}</span> {e.table_name}
                        {fields.length > 0 && <span className="text-muted-foreground"> — {fields.join(", ")}</span>}
                      </p>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {format(new Date(e.occurred_at), "MMM d, yyyy HH:mm")}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}