import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Lock, Shield, ShieldCheck, User as UserIcon, Loader2, Search, UserPlus, Mail, Plus, X, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useUserTier } from "@/hooks/useUserTier";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { PageMeta } from "@/components/PageMeta";

type AssignableRole = "admin" | "curator" | "member";

interface SignedInUserRow {
  kind: "signed_in";
  id: string; // auth user id
  email: string;
  full_name: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  role: AssignableRole;
  is_linked_investigator: boolean;
  investigator_id: string | null;
  investigator_primary_email: string | null;
  investigator_secondary_emails: string[];
  investigator_working_groups: string[];
}

interface InvitedInvestigatorRow {
  kind: "invited";
  id: string; // investigator id
  email: string | null;
  full_name: string;
  research_areas: string[] | null;
  secondary_emails: string[];
  working_groups: string[];
}

/** The four canonical tokens. Must match canonical_working_group() and the WG_GROUPS map in
 *  group-audit / sync-member-groups — a fifth spelling here would write a token nothing subscribes. */
const WORKING_GROUPS = ["WG-Analytics", "WG-Devices", "WG-ELSI", "WG-Standards"] as const;

const TIER_META: Record<AssignableRole, { label: string; tier: number; color: string; icon: any }> = {
  admin:   { label: "Admin",   tier: 1, color: "bg-destructive/10 text-destructive border-destructive/30", icon: ShieldCheck },
  curator: { label: "Curator", tier: 2, color: "bg-primary/10 text-primary border-primary/30",             icon: Shield },
  member:  { label: "Member",  tier: 3, color: "bg-muted text-muted-foreground border-border",             icon: UserIcon },
};

interface AdminUsersProps {
  embedded?: boolean;
}

export default function AdminUsers({ embedded = false }: AdminUsersProps = {}) {
  const tierInfo = useUserTier();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [tierFilter, setTierFilter] = useState<AssignableRole | "invited" | null>(null);
  const [activeTab, setActiveTab] = useState<"signed_in" | "invited">("signed_in");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addEmail, setAddEmail] = useState("");
  const [addName, setAddName] = useState("");
  const [addRole, setAddRole] = useState<AssignableRole>("member");
  const [addSubmitting, setAddSubmitting] = useState(false);

  // Email management dialog state
  const [emailEditTarget, setEmailEditTarget] = useState<{
    investigator_id: string;
    name: string;
    primary: string | null;
    secondaries: string[];
    workingGroups: string[];
  } | null>(null);
  const [emailDraftPrimary, setEmailDraftPrimary] = useState("");
  const [emailDraftSecondaries, setEmailDraftSecondaries] = useState<string[]>([]);
  const [emailDraftNew, setEmailDraftNew] = useState("");
  const [nameDraft, setNameDraft] = useState("");
  const [wgDraft, setWgDraft] = useState<string[]>([]);
  const [emailSaving, setEmailSaving] = useState(false);

  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<
    | { kind: "signed_in"; row: SignedInUserRow }
    | { kind: "invited"; row: InvitedInvestigatorRow }
    | null
  >(null);

  const canManage = tierInfo.isCurator; // tier 1 and 2
  const canGrantAdmin = tierInfo.isAdmin; // tier 1 only

  const { data, isLoading } = useQuery({
    queryKey: ["admin-users-list-v2"],
    enabled: canManage,
    queryFn: async () => {
      const [profilesRes, rolesRes, investigatorsRes] = await Promise.all([
        supabase.from("profiles").select("id, email, full_name, created_at"),
        supabase.from("user_roles").select("user_id, role"),
        supabase
          .from("investigators")
          .select("id, name, email, user_id, research_areas, secondary_emails, working_groups"),
      ]);
      if (profilesRes.error) throw profilesRes.error;
      if (investigatorsRes.error) throw investigatorsRes.error;

      const roleMap = new Map<string, AssignableRole>();
      (rolesRes.data ?? []).forEach((r: any) => {
        const existing = roleMap.get(r.user_id);
        if (!existing || r.role === "admin" || (r.role === "curator" && existing === "member")) {
          roleMap.set(r.user_id, r.role);
        }
      });

      const investigatorByUserId = new Map<string, any>();
      (investigatorsRes.data ?? []).forEach((i: any) => {
        if (i.user_id) investigatorByUserId.set(i.user_id, i);
      });

      const lastLoginMap = new Map<string, string | null>();
      const { data: lastLogins } = await supabase.rpc("admin_get_last_logins");
      (lastLogins ?? []).forEach((r: any) => {
        lastLoginMap.set(r.user_id, r.last_sign_in_at);
      });

      const signedIn: SignedInUserRow[] = (profilesRes.data ?? []).map((p: any) => {
        const inv = investigatorByUserId.get(p.id);
        return {
          kind: "signed_in",
          id: p.id,
          email: p.email,
          full_name: p.full_name,
          created_at: p.created_at,
          last_sign_in_at: lastLoginMap.get(p.id) ?? null,
          role: roleMap.get(p.id) ?? "member",
          is_linked_investigator: !!inv,
          investigator_id: inv?.id ?? null,
          investigator_primary_email: inv?.email ?? null,
          investigator_secondary_emails: inv?.secondary_emails ?? [],
          investigator_working_groups: inv?.working_groups ?? [],
        };
      });

      const invited: InvitedInvestigatorRow[] = (investigatorsRes.data ?? [])
        .filter((i: any) => !i.user_id)
        .map((i: any) => ({
          kind: "invited",
          id: i.id,
          email: i.email,
          full_name: i.name,
          research_areas: i.research_areas,
          secondary_emails: i.secondary_emails ?? [],
          working_groups: i.working_groups ?? [],
        }));

      return { signedIn, invited };
    },
  });

  const signedIn = data?.signedIn ?? [];
  const invited = data?.invited ?? [];

  const filteredSignedIn = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = signedIn;
    if (tierFilter && tierFilter !== "invited") {
      rows = rows.filter((u) => u.role === tierFilter);
    }
    if (!q) return rows;
    return rows.filter(
      (u) =>
        u.email.toLowerCase().includes(q) ||
        (u.full_name ?? "").toLowerCase().includes(q),
    );
  }, [signedIn, search, tierFilter]);

  const filteredInvited = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return invited;
    return invited.filter(
      (u) =>
        (u.email ?? "").toLowerCase().includes(q) ||
        u.full_name.toLowerCase().includes(q),
    );
  }, [invited, search]);

  const handleRoleChange = async (userId: string, newRole: AssignableRole) => {
    setSavingId(userId);
    try {
      // Remove existing admin/curator rows for this user
      await supabase
        .from("user_roles")
        .delete()
        .eq("user_id", userId)
        .in("role", ["admin", "curator"]);

      // Always ensure a 'member' row exists (Tier 3 baseline)
      await supabase
        .from("user_roles")
        .upsert({ user_id: userId, role: "member" }, { onConflict: "user_id,role" });

      // Add elevated role if needed
      if (newRole !== "member") {
        const { error } = await supabase
          .from("user_roles")
          .insert({ user_id: userId, role: newRole });
        if (error) throw error;
      }

      toast.success(`Role updated to ${TIER_META[newRole].label}`);
      queryClient.invalidateQueries({ queryKey: ["admin-users-list-v2"] });
      queryClient.invalidateQueries({ queryKey: ["user-tier"] });
    } catch (err: any) {
      console.error(err);
      toast.error(err.message ?? "Failed to update role");
    } finally {
      setSavingId(null);
    }
  };

  const resetAddForm = () => {
    setAddEmail("");
    setAddName("");
    setAddRole("member");
  };

  const handleAddUser = async () => {
    const email = addEmail.trim().toLowerCase();
    const name = addName.trim();
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      toast.error("Please enter a valid email address.");
      return;
    }
    if (!name) {
      toast.error("Please enter the person's name.");
      return;
    }
    if (addRole === "admin" && !canGrantAdmin) {
      toast.error("Only Tier 1 admins can assign the Admin tier.");
      return;
    }

    setAddSubmitting(true);
    try {
      // 1) Check if user already signed in (profile exists for this email)
      const { data: existingProfile, error: profileErr } = await supabase
        .from("profiles")
        .select("id, email")
        .ilike("email", email)
        .maybeSingle();
      if (profileErr && profileErr.code !== "PGRST116") throw profileErr;

      if (existingProfile?.id) {
        // Assign role immediately to existing user
        await supabase
          .from("user_roles")
          .delete()
          .eq("user_id", existingProfile.id)
          .in("role", ["admin", "curator"]);

        await supabase
          .from("user_roles")
          .upsert(
            { user_id: existingProfile.id, role: "member" },
            { onConflict: "user_id,role" },
          );

        if (addRole !== "member") {
          const { error } = await supabase
            .from("user_roles")
            .insert({ user_id: existingProfile.id, role: addRole });
          if (error) throw error;
        }
        toast.success(`Assigned ${TIER_META[addRole].label} to ${email}.`);
      } else {
        // 2) Otherwise create an invited investigator with pending role
        const { error } = await supabase.from("investigators").insert({
          name,
          email,
          pending_role: addRole === "member" ? null : addRole,
        });
        if (error) throw error;
        toast.success(
          `Invited ${email}. Tier ${TIER_META[addRole].tier} will be applied on their first sign-in.`,
        );
      }

      queryClient.invalidateQueries({ queryKey: ["admin-users-list-v2"] });
      setAddOpen(false);
      resetAddForm();
    } catch (err: any) {
      console.error(err);
      toast.error(err.message ?? "Failed to add user.");
    } finally {
      setAddSubmitting(false);
    }
  };

  const openEmailEditor = (target: {
    investigator_id: string;
    name: string;
    primary: string | null;
    secondaries: string[];
    workingGroups: string[];
  }) => {
    setEmailEditTarget(target);
    setEmailDraftPrimary(target.primary ?? "");
    setEmailDraftSecondaries([...(target.secondaries ?? [])]);
    setEmailDraftNew("");
    setNameDraft(target.name ?? "");
    setWgDraft([...(target.workingGroups ?? [])]);
  };

  const addSecondaryDraft = () => {
    const e = emailDraftNew.trim().toLowerCase();
    if (!e) return;
    if (!/^\S+@\S+\.\S+$/.test(e)) {
      toast.error("Please enter a valid email address.");
      return;
    }
    if (e === emailDraftPrimary.trim().toLowerCase()) {
      toast.error("That's already the primary email.");
      return;
    }
    if (emailDraftSecondaries.map((s) => s.toLowerCase()).includes(e)) {
      toast.error("Email already in the list.");
      return;
    }
    setEmailDraftSecondaries((prev) => [...prev, e]);
    setEmailDraftNew("");
  };

  const removeSecondaryDraft = (email: string) => {
    setEmailDraftSecondaries((prev) => prev.filter((e) => e !== email));
  };

  const saveEmails = async () => {
    if (!emailEditTarget) return;
    const primary = emailDraftPrimary.trim().toLowerCase();
    if (primary && !/^\S+@\S+\.\S+$/.test(primary)) {
      toast.error("Primary email is not a valid address.");
      return;
    }
    const trimmedName = nameDraft.trim();
    if (!trimmedName) {
      toast.error("Name cannot be empty.");
      return;
    }
    const cleanedSecondaries = Array.from(
      new Set(
        emailDraftSecondaries
          .map((e) => e.trim().toLowerCase())
          .filter((e) => e && e !== primary),
      ),
    );

    setEmailSaving(true);
    try {
      const { error } = await supabase
        .from("investigators")
        .update({
          name: trimmedName,
          email: primary || null,
          secondary_emails: cleanedSecondaries,
        })
        .eq("id", emailEditTarget.investigator_id);
      if (error) throw error;

      // Also sync full_name on the linked auth profile, if any.
      const { data: linkedInv } = await supabase
        .from("investigators")
        .select("user_id")
        .eq("id", emailEditTarget.investigator_id)
        .maybeSingle();
      if (linkedInv?.user_id) {
        await supabase
          .from("profiles")
          .update({ full_name: trimmedName })
          .eq("id", linkedInv.user_id);
      }

      // Working groups LAST, and only when they changed. Two reasons for the order:
      //
      //  1. Updating working_groups fires trg_sync_member_groups, which posts to sync-member-groups
      //     — and that function re-reads the member and subscribes whatever the DATABASE says the
      //     primary email is. Saving the address first means the person is added to the group under
      //     the corrected address instead of the stale one.
      //  2. approve_working_groups REPLACES the array (and clears requested_working_groups, which is
      //     what approving a request means), so it must be given the complete intended set.
      const before = [...(emailEditTarget.workingGroups ?? [])].sort().join(",");
      const after = [...wgDraft].sort().join(",");
      if (before !== after) {
        const { error: wgError } = await supabase.rpc("approve_working_groups", {
          _investigator_id: emailEditTarget.investigator_id,
          _groups: wgDraft,
        });
        if (wgError) throw wgError;
      }

      toast.success(
        before !== after
          ? "User updated. Group membership syncs in the background — check /admin → Group Audit."
          : "User updated.",
      );
      queryClient.invalidateQueries({ queryKey: ["admin-users-list-v2"] });
      setEmailEditTarget(null);
    } catch (err: any) {
      console.error(err);
      toast.error(err.message ?? "Failed to update user.");
    } finally {
      setEmailSaving(false);
    }
  };

  // ---- Delete + undo ----
  const restoreSignedInRoles = async (userId: string, roles: AssignableRole[]) => {
    if (roles.length === 0) return;
    const rows = roles.map((role) => ({ user_id: userId, role }));
    const { error } = await supabase
      .from("user_roles")
      .upsert(rows, { onConflict: "user_id,role" });
    if (error) throw error;
  };

  const handleDeleteSignedInUser = async (u: SignedInUserRow) => {
    setDeletingId(u.id);
    try {
      // Snapshot existing roles
      const { data: existing, error: fetchErr } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", u.id);
      if (fetchErr) throw fetchErr;
      const snapshotRoles: AssignableRole[] = (existing ?? []).map((r: any) => r.role);

      // Remove all roles
      const { error: delErr } = await supabase
        .from("user_roles")
        .delete()
        .eq("user_id", u.id);
      if (delErr) throw delErr;

      queryClient.invalidateQueries({ queryKey: ["admin-users-list-v2"] });
      queryClient.invalidateQueries({ queryKey: ["user-tier"] });

      toast.success(`Revoked all access for ${u.email}`, {
        duration: 30_000,
        className: "border-2 border-primary",
        action: {
          label: "Undo",
          onClick: async () => {
            try {
              await restoreSignedInRoles(u.id, snapshotRoles.length ? snapshotRoles : ["member"]);
              toast.success("Access restored");
              queryClient.invalidateQueries({ queryKey: ["admin-users-list-v2"] });
              queryClient.invalidateQueries({ queryKey: ["user-tier"] });
            } catch (e: any) {
              toast.error(e.message ?? "Failed to restore access");
            }
          },
        },
      });
    } catch (err: any) {
      console.error(err);
      toast.error(err.message ?? "Failed to delete user");
    } finally {
      setDeletingId(null);
    }
  };

  const handleDeleteInvited = async (u: InvitedInvestigatorRow) => {
    setDeletingId(u.id);
    try {
      // Snapshot full row before delete
      const { data: existing, error: fetchErr } = await supabase
        .from("investigators")
        .select("*")
        .eq("id", u.id)
        .maybeSingle();
      if (fetchErr) throw fetchErr;
      if (!existing) throw new Error("Investigator not found");

      const { error: delErr } = await supabase
        .from("investigators")
        .delete()
        .eq("id", u.id);
      if (delErr) throw delErr;

      queryClient.invalidateQueries({ queryKey: ["admin-users-list-v2"] });

      toast.success(`Removed ${u.full_name}`, {
        duration: 30_000,
        className: "border-2 border-primary",
        action: {
          label: "Undo",
          onClick: async () => {
            try {
              const { error } = await supabase.from("investigators").insert(existing as any);
              if (error) throw error;
              toast.success("Investigator restored");
              queryClient.invalidateQueries({ queryKey: ["admin-users-list-v2"] });
            } catch (e: any) {
              toast.error(e.message ?? "Failed to restore");
            }
          },
        },
      });
    } catch (err: any) {
      console.error(err);
      toast.error(err.message ?? "Failed to delete investigator");
    } finally {
      setDeletingId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    if (target.kind === "signed_in") {
      await handleDeleteSignedInUser(target.row);
    } else {
      await handleDeleteInvited(target.row);
    }
  };

  // ---- Access gate ----
  if (tierInfo.isLoading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (!canManage) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-16">
        <Card>
          <CardContent className="p-8 text-center">
            <div className="mx-auto w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mb-5">
              <Lock className="h-6 w-6 text-primary" />
            </div>
            <h1 className="text-2xl font-bold mb-2">Admin access required</h1>
            <p className="text-sm text-muted-foreground mb-6">
              This page is restricted to Tier 1 administrators and Tier 2 curators.
            </p>
            <Button asChild variant="outline">
              <Link to="/">Back to home</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ---- Counts ----
  const counts = signedIn.reduce(
    (acc, u) => ({ ...acc, [u.role]: (acc[u.role] ?? 0) + 1 }),
    {} as Record<AssignableRole, number>,
  );

  return (
    <div className={embedded ? "" : "max-w-6xl mx-auto px-4 py-8"}>
      {!embedded && <PageMeta title="User Roles — Admin" description="Manage user access tiers" />}

      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          {!embedded && (
            <h1 className="text-3xl font-bold text-foreground mb-1">User Roles</h1>
          )}
          <p className="text-sm text-muted-foreground">
            Assign access tiers across the consortium. Changes take effect immediately.
          </p>
        </div>
        <Button onClick={() => setAddOpen(true)} className="shrink-0">
          <UserPlus className="h-4 w-4 mr-2" />
          Add user
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        {(["admin", "curator", "member"] as AssignableRole[]).map((r) => {
          const meta = TIER_META[r];
          const Icon = meta.icon;
          const active = tierFilter === r;
          return (
            <Card
              key={r}
              role="button"
              tabIndex={0}
              aria-pressed={active}
              onClick={() => {
                setTierFilter(active ? null : r);
                setActiveTab("signed_in");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setTierFilter(active ? null : r);
                  setActiveTab("signed_in");
                }
              }}
              className={`cursor-pointer transition-all hover:border-primary/50 hover:shadow-sm ${
                active ? "border-primary ring-2 ring-primary/30" : ""
              }`}
            >
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2">
                  <Icon className="h-4 w-4 text-muted-foreground" />
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Tier {meta.tier} — {meta.label}
                  </CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{counts[r] ?? 0}</div>
              </CardContent>
            </Card>
          );
        })}
        <Card
          role="button"
          tabIndex={0}
          aria-pressed={tierFilter === "invited"}
          onClick={() => {
            const next = tierFilter === "invited" ? null : "invited";
            setTierFilter(next);
            setActiveTab(next === "invited" ? "invited" : "signed_in");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              const next = tierFilter === "invited" ? null : "invited";
              setTierFilter(next);
              setActiveTab(next === "invited" ? "invited" : "signed_in");
            }
          }}
          className={`cursor-pointer transition-all hover:border-primary/50 hover:shadow-sm ${
            tierFilter === "invited" ? "border-primary ring-2 ring-primary/30" : ""
          }`}
        >
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <UserPlus className="h-4 w-4 text-muted-foreground" />
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Invited (not signed in)
              </CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{invited.length}</div>
          </CardContent>
        </Card>
      </div>

      {tierFilter && (
        <div className="mb-4 flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Filtered by:</span>
          <Badge variant="secondary" className="gap-1">
            {tierFilter === "invited"
              ? "Invited (not signed in)"
              : `Tier ${TIER_META[tierFilter].tier} — ${TIER_META[tierFilter].label}`}
            <button
              onClick={() => setTierFilter(null)}
              className="ml-1 hover:text-foreground"
              aria-label="Clear filter"
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        </div>
      )}

      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search by name or email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9 max-w-md"
        />
      </div>

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "signed_in" | "invited")}>
        <TabsList>
          <TabsTrigger value="signed_in">
            Signed-in users ({filteredSignedIn.length})
          </TabsTrigger>
          <TabsTrigger value="invited">
            Invited investigators ({filteredInvited.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="signed_in">
          <Card>
            <CardHeader>
              <CardTitle>Signed-in users</CardTitle>
              <CardDescription>
                Anyone who has logged in via Globus. Every user is granted Tier 3 (Member) by default.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="py-12 flex justify-center">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>User</TableHead>
                        <TableHead>Emails</TableHead>
                        <TableHead>Investigator linked</TableHead>
                        <TableHead>Current tier</TableHead>
                        <TableHead>Last login</TableHead>
                        <TableHead className="text-right">Change role</TableHead>
                        <TableHead className="text-right w-[80px]">Delete</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredSignedIn.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                            No users found.
                          </TableCell>
                        </TableRow>
                      )}
                      {filteredSignedIn.map((u) => {
                        const meta = TIER_META[u.role];
                        return (
                          <TableRow key={u.id}>
                            <TableCell>
                              <div className="font-medium text-foreground">
                                {u.full_name || "—"}
                              </div>
                              <div className="text-xs text-muted-foreground">{u.email}</div>
                            </TableCell>
                            <TableCell>
                              {u.is_linked_investigator && u.investigator_id ? (
                                <div className="space-y-1">
                                  <div className="text-xs text-foreground">
                                    {u.investigator_primary_email || "(no primary)"}
                                  </div>
                                  {u.investigator_secondary_emails.length > 0 && (
                                    <div className="text-xs text-muted-foreground">
                                      +{u.investigator_secondary_emails.length} secondary
                                    </div>
                                  )}
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-6 px-2 text-xs"
                                    onClick={() =>
                                      openEmailEditor({
                                        investigator_id: u.investigator_id!,
                                        name: u.full_name || u.email,
                                        primary: u.investigator_primary_email,
                                        secondaries: u.investigator_secondary_emails,
                                        workingGroups: u.investigator_working_groups,
                                      })
                                    }
                                  >
                                    <Mail className="h-3 w-3 mr-1" />
                                    Manage
                                  </Button>
                                </div>
                              ) : (
                                <span className="text-xs text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            <TableCell>
                              {u.is_linked_investigator ? (
                                <Badge variant="secondary">Linked</Badge>
                              ) : (
                                <Badge variant="outline" className="text-muted-foreground">
                                  Unlinked
                                </Badge>
                              )}
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline" className={meta.color}>
                                T{meta.tier} · {meta.label}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                              {u.last_sign_in_at
                                ? new Date(u.last_sign_in_at).toLocaleString(undefined, {
                                    year: "numeric",
                                    month: "short",
                                    day: "numeric",
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })
                                : "Never"}
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="inline-flex items-center gap-2">
                                {savingId === u.id && (
                                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                                )}
                                <Select
                                  value={u.role}
                                  onValueChange={(v) => handleRoleChange(u.id, v as AssignableRole)}
                                  disabled={savingId === u.id}
                                >
                                  <SelectTrigger className="w-[160px]">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {canGrantAdmin && (
                                      <SelectItem value="admin">Tier 1 — Admin</SelectItem>
                                    )}
                                    <SelectItem value="curator">Tier 2 — Curator</SelectItem>
                                    <SelectItem value="member">Tier 3 — Member</SelectItem>
                                  </SelectContent>
                                </Select>
                              </div>
                            </TableCell>
                            <TableCell className="text-right">
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-8 w-8 p-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                                onClick={() => setDeleteTarget({ kind: "signed_in", row: u })}
                                disabled={deletingId === u.id}
                                title="Revoke all access"
                              >
                                {deletingId === u.id ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <Trash2 className="h-4 w-4" />
                                )}
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="invited">
          <Card>
            <CardHeader>
              <CardTitle>Invited investigators</CardTitle>
              <CardDescription>
                Consortium members in the investigators directory who haven't yet signed in via Globus.
                They will be auto-linked the first time they log in with a matching email.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="py-12 flex justify-center">
                  <Loader2 className="h-6 w-6 animate-spin text-primary" />
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Emails</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredInvited.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                            No invited investigators found.
                          </TableCell>
                        </TableRow>
                      )}
                      {filteredInvited.map((u) => (
                        <TableRow key={u.id}>
                          <TableCell className="font-medium text-foreground">
                            {u.full_name}
                          </TableCell>
                          <TableCell className="text-sm">
                            <div className="text-foreground text-xs">{u.email || "(no primary)"}</div>
                            {u.secondary_emails.length > 0 && (
                              <div className="text-xs text-muted-foreground">
                                +{u.secondary_emails.length} secondary
                              </div>
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-muted-foreground">
                              Awaiting first sign-in
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="inline-flex items-center gap-1 justify-end">
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-xs"
                                onClick={() =>
                                  openEmailEditor({
                                    investigator_id: u.id,
                                    name: u.full_name,
                                    primary: u.email,
                                    secondaries: u.secondary_emails,
                                    workingGroups: u.working_groups,
                                  })
                                }
                              >
                                <Mail className="h-3 w-3 mr-1" />
                                Manage
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 w-7 p-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                                onClick={() => setDeleteTarget({ kind: "invited", row: u })}
                                disabled={deletingId === u.id}
                                title="Remove invited investigator"
                              >
                                {deletingId === u.id ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Trash2 className="h-3.5 w-3.5" />
                                )}
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <p className="text-xs text-muted-foreground mt-6">
        Every authenticated user is automatically granted Tier 3 (Member) on first sign-in. Invited
        investigators appear here once added to the <code className="font-mono">investigators</code>{" "}
        directory and will be auto-linked to their auth account on their first Globus login.
      </p>

      <Dialog
        open={addOpen}
        onOpenChange={(open) => {
          setAddOpen(open);
          if (!open) resetAddForm();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add user</DialogTitle>
            <DialogDescription>
              If this email already belongs to a signed-in user, the tier is applied immediately.
              Otherwise, they're added to the investigators directory and the tier is granted the
              first time they sign in via Globus.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="add-name">Full name</Label>
              <Input
                id="add-name"
                placeholder="Jane Doe"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
                maxLength={120}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="add-email">Email</Label>
              <Input
                id="add-email"
                type="email"
                placeholder="jane@institution.edu"
                value={addEmail}
                onChange={(e) => setAddEmail(e.target.value)}
                maxLength={255}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="add-tier">Tier</Label>
              <Select value={addRole} onValueChange={(v) => setAddRole(v as AssignableRole)}>
                <SelectTrigger id="add-tier">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {canGrantAdmin && (
                    <SelectItem value="admin">Tier 1 — Admin</SelectItem>
                  )}
                  <SelectItem value="curator">Tier 2 — Curator</SelectItem>
                  <SelectItem value="member">Tier 3 — Member</SelectItem>
                </SelectContent>
              </Select>
              {!canGrantAdmin && (
                <p className="text-xs text-muted-foreground">
                  Only Tier 1 admins can grant the Admin tier.
                </p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)} disabled={addSubmitting}>
              Cancel
            </Button>
            <Button onClick={handleAddUser} disabled={addSubmitting}>
              {addSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Add user
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!emailEditTarget}
        onOpenChange={(open) => !open && setEmailEditTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Manage user</DialogTitle>
            <DialogDescription>
              {emailEditTarget?.name
                ? `Update name and linked sign-in emails for "${emailEditTarget.name}".`
                : "Update name and linked sign-in emails."}{" "}
              Any listed email can be used to sign in via Globus and will be auto-linked to this
              investigator profile.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="user-name">Name</Label>
              <Input
                id="user-name"
                type="text"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                placeholder="Jane Doe"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="primary-email">Primary email</Label>
              <Input
                id="primary-email"
                type="email"
                value={emailDraftPrimary}
                onChange={(e) => setEmailDraftPrimary(e.target.value)}
                placeholder="jane@institution.edu"
              />
            </div>

            <div className="space-y-2">
              <Label>Secondary emails</Label>
              {emailDraftSecondaries.length === 0 && (
                <p className="text-xs text-muted-foreground">No secondary emails.</p>
              )}
              <div className="space-y-1">
                {emailDraftSecondaries.map((e) => (
                  <div
                    key={e}
                    className="flex items-center justify-between rounded-md border border-border bg-muted/40 px-3 py-1.5 text-sm"
                  >
                    <span className="font-mono text-xs text-foreground">{e}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 w-6 p-0"
                      onClick={() => removeSecondaryDraft(e)}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-2 pt-1">
                <Input
                  type="email"
                  placeholder="add another email…"
                  value={emailDraftNew}
                  onChange={(e) => setEmailDraftNew(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addSecondaryDraft();
                    }
                  }}
                />
                <Button type="button" variant="outline" size="sm" onClick={addSecondaryDraft}>
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  Add
                </Button>
              </div>
            </div>

            {/* Working groups, settable by a curator. Previously the ONLY way in was the member
                doing it themselves: member_self_update writes requested_working_groups and an admin
                approves. Someone awaiting first sign-in therefore could not be put in a group at all
                without a hand-written UPDATE — which is how "add me to Analytics, my PI asked" became
                a database task. The directory at /investigators also hides anyone with no grant and
                no working group, so there was no profile page to do it from either. */}
            <div className="space-y-2">
              <Label>Working groups</Label>
              <div className="grid grid-cols-2 gap-2">
                {WORKING_GROUPS.map((wg) => {
                  const on = wgDraft.includes(wg);
                  return (
                    <label
                      key={wg}
                      className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm cursor-pointer hover:bg-muted/40 select-none"
                    >
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-primary"
                        checked={on}
                        onChange={(e) =>
                          setWgDraft((prev) =>
                            e.target.checked ? [...prev, wg] : prev.filter((w) => w !== wg),
                          )
                        }
                      />
                      <span className={on ? "text-foreground" : "text-muted-foreground"}>{wg}</span>
                    </label>
                  );
                })}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Saving a change here subscribes or unsubscribes them from the matching Google Group.
                The address used is the primary email above, so fix that first if it is wrong.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEmailEditTarget(null)}
              disabled={emailSaving}
            >
              Cancel
            </Button>
            <Button onClick={saveEmails} disabled={emailSaving}>
              {emailSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="h-5 w-5" />
              {deleteTarget?.kind === "signed_in"
                ? "Revoke all access?"
                : "Remove invited investigator?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.kind === "signed_in" ? (
                <>
                  This will revoke <strong>all roles</strong> (including Member) for{" "}
                  <strong>{deleteTarget.row.full_name || deleteTarget.row.email}</strong>.
                  Their Globus account is not deleted, but they will lose all access on this site.
                  <br />
                  <br />
                  You'll have <strong>30 seconds</strong> to undo this action from the toast notification.
                </>
              ) : deleteTarget?.kind === "invited" ? (
                <>
                  This will remove <strong>{deleteTarget.row.full_name}</strong> from the invited
                  investigators directory. If they later sign in via Globus, they will not be
                  auto-linked.
                  <br />
                  <br />
                  You'll have <strong>30 seconds</strong> to undo this action from the toast notification.
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteTarget?.kind === "signed_in" ? "Revoke access" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
