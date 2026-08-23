import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { SummaryField } from "../SummaryField";
import { SummaryTabs } from "../SummaryTabs";
import { useEntitySummary } from "@/contexts/EntitySummaryContext";
import { useAuth } from "@/contexts/AuthContext";
import { useInvestigatorOwnership } from "@/hooks/useInvestigatorOwnership";
import { useUserTier } from "@/hooks/useUserTier";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { ExternalLink, FileText, User, Pencil, Check, X, UserCheck, UserPlus, Plus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { ProvenanceScope } from "@/components/provenance/ProvenanceScope";

// Editable inline field
function EditableText({ value, onSave, placeholder, type = "text", href }: {
  value: string;
  onSave: (val: string) => void;
  placeholder: string;
  type?: string;
  href?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  if (!editing) {
    return (
      <div className="group flex items-center gap-1.5 min-h-[28px]">
        {value ? (
          type === "url" ? (
            <a href={href ?? value} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">
              {value} <ExternalLink className="h-3 w-3" />
            </a>
          ) : type === "email" ? (
            <a href={`mailto:${value}`} className="text-primary hover:underline">{value}</a>
          ) : (
            <span>{value}</span>
          )
        ) : (
          <span className="text-muted-foreground italic text-xs">{placeholder}</span>
        )}
        <button
          onClick={() => { setDraft(value); setEditing(true); }}
          className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
        >
          <Pencil className="h-3 w-3" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1.5">
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={placeholder}
        className="h-7 text-sm"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Enter") { onSave(draft); setEditing(false); }
          if (e.key === "Escape") setEditing(false);
        }}
      />
      <button onClick={() => { onSave(draft); setEditing(false); }} className="text-primary hover:text-primary/80">
        <Check className="h-4 w-4" />
      </button>
      <button onClick={() => setEditing(false)} className="text-muted-foreground hover:text-foreground">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

// Editable list of string tags (skills / research areas)
function EditableTagList({ items, onChange, placeholder }: {
  items: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const add = () => {
    const v = draft.trim();
    if (!v || items.includes(v)) { setDraft(""); setAdding(false); return; }
    onChange([...items, v]);
    setDraft("");
    setAdding(false);
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {items.map((it) => (
        <Badge key={it} variant="secondary" className="gap-1 pr-1">
          {it}
          <button onClick={() => onChange(items.filter((x) => x !== it))} className="hover:text-destructive">
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
      {adding ? (
        <div className="flex items-center gap-1">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={placeholder}
            className="h-7 text-xs w-40"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
              if (e.key === "Escape") { setAdding(false); setDraft(""); }
            }}
          />
          <button onClick={add} className="text-primary hover:text-primary/80"><Check className="h-4 w-4" /></button>
          <button onClick={() => { setAdding(false); setDraft(""); }} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
        </div>
      ) : (
        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setAdding(true)}>
          <Plus className="h-3 w-3 mr-1" /> Add
        </Button>
      )}
      {items.length === 0 && !adding && (
        <span className="text-muted-foreground italic text-xs">{placeholder}</span>
      )}
    </div>
  );
}

// The four canonical BBQS working groups. These MUST match the wg-*@brain-bbqs.org
// Google Groups (the sync-member-groups edge function maps on these). Free-text entry
// produced drift ("Analytics" vs "WG-Analytics"), so working groups are now picked from
// this fixed list only.
const CANONICAL_WORKING_GROUPS = ["WG-Analytics", "WG-Devices", "WG-ELSI", "WG-Standards"] as const;

// Standardized working-group picker — choose from the canonical list, no free text.
function EditableWorkingGroups({ items, onChange }: {
  items: string[];
  onChange: (next: string[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const selected = new Set(items);
  const available = CANONICAL_WORKING_GROUPS.filter((w) => !selected.has(w));
  const add = (wg: string) => {
    if (!selected.has(wg)) onChange([...items, wg]);
    setAdding(false);
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {items.map((it) => (
        <Badge key={it} variant="secondary" className="gap-1 pr-1">
          {it}
          <button onClick={() => onChange(items.filter((x) => x !== it))} className="hover:text-destructive">
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
      {adding ? (
        <div className="inline-flex flex-wrap items-center gap-1">
          {available.map((w) => (
            <button
              key={w}
              onClick={() => add(w)}
              className="px-2 py-1 text-xs rounded border border-border hover:bg-accent"
            >
              {w}
            </button>
          ))}
          {available.length === 0 && (
            <span className="text-muted-foreground italic text-xs">All working groups added</span>
          )}
          <button onClick={() => setAdding(false)} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        available.length > 0 && (
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setAdding(true)}>
            <Plus className="h-3 w-3 mr-1" /> Add
          </Button>
        )
      )}
      {items.length === 0 && !adding && (
        <span className="text-muted-foreground italic text-xs">No working groups</span>
      )}
    </div>
  );
}

// Editable institution picker (links/unlinks rows in investigator_organizations)
function EditableInstitutions({ investigatorId, current, onChanged, openEntity }: {
  investigatorId: string;
  current: { id: string; name: string; resource_id?: string | null }[];
  onChanged: () => void;
  openEntity: (org: { id: string; name: string; resource_id?: string | null }) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");
  const { toast } = useToast();

  const { data: options = [] } = useQuery({
    queryKey: ["org-search", search],
    enabled: adding,
    queryFn: async () => {
      let q = supabase.from("organizations").select("id, name, resource_id").order("name").limit(30);
      if (search.trim()) q = q.ilike("name", `%${search.trim()}%`);
      const { data } = await q;
      return data || [];
    },
  });

  // The pane links organizations (investigator_organizations), but the agent and the
  // investigator_directory read the scalar investigators.institution — so an org link
  // alone was invisible to the agent (bug 2026-07-24: Nima's MIT link, institution=null).
  // Keep the scalar in sync with the linked org name(s) so both agree.
  const syncInstitutionScalar = async (names: string[]) => {
    const value = names.filter(Boolean).join(", ") || null;
    await supabase.from("investigators").update({ institution: value } as any).eq("id", investigatorId);
  };

  const addOrg = async (orgId: string, orgName: string) => {
    const { error } = await supabase
      .from("investigator_organizations")
      .insert({ investigator_id: investigatorId, organization_id: orgId });
    if (error) {
      toast({ title: "Could not add", description: error.message, variant: "destructive" });
    } else {
      await syncInstitutionScalar([...current.map((c) => c.name), orgName]);
      onChanged();
      setAdding(false);
      setSearch("");
    }
  };

  const removeOrg = async (orgId: string) => {
    const { error } = await supabase
      .from("investigator_organizations")
      .delete()
      .eq("investigator_id", investigatorId)
      .eq("organization_id", orgId);
    if (error) {
      toast({ title: "Could not remove", description: error.message, variant: "destructive" });
    } else {
      await syncInstitutionScalar(current.filter((c) => c.id !== orgId).map((c) => c.name));
      onChanged();
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {current.map((org) => (
          <Badge key={org.id} variant="outline" className="gap-1 pr-1">
            <span className="cursor-pointer hover:underline" onClick={() => openEntity(org)}>{org.name}</span>
            <button onClick={() => removeOrg(org.id)} className="hover:text-destructive">
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
        {!adding && (
          <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setAdding(true)}>
            <Plus className="h-3 w-3 mr-1" /> Add
          </Button>
        )}
        {current.length === 0 && !adding && (
          <span className="text-muted-foreground italic text-xs">No institutions linked</span>
        )}
      </div>
      {adding && (
        <div className="border border-border rounded-md p-2 space-y-2 bg-muted/20">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search institutions…"
            className="h-7 text-xs"
            autoFocus
          />
          <div className="max-h-40 overflow-y-auto space-y-0.5">
            {options
              .filter((o) => !current.some((c) => c.id === o.id))
              .map((o) => (
                <button
                  key={o.id}
                  onClick={() => addOrg(o.id, o.name)}
                  className="w-full text-left px-2 py-1 text-xs rounded hover:bg-accent"
                >
                  {o.name}
                </button>
              ))}
            {options.length === 0 && (
              <p className="text-xs text-muted-foreground italic px-2 py-1">No matches.</p>
            )}
          </div>
          <div className="flex justify-end">
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => { setAdding(false); setSearch(""); }}>
              Done
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

const PROFILE_FIELDS = [
  { key: "name", label: "Name" },
  { key: "email", label: "Email" },
  { key: "orcid", label: "ORCID" },
  { key: "scholar_id", label: "Google Scholar" },
  { key: "organizations", label: "University/Institution" },
  { key: "skills", label: "Skills" },
  { key: "research_areas", label: "Research Areas" },
] as const;

function calcCompleteness(data: any): number {
  const checks = [
    !!data.name,
    !!data.email,
    !!data.orcid,
    !!data.scholar_id,
    data.organizations?.length > 0,
    data.skills?.length > 0,
    data.research_areas?.length > 0,
  ];
  return Math.round((checks.filter(Boolean).length / checks.length) * 100);
}

// Editable role select for a single grant_investigators row
function EditableGrantRole({
  grantId,
  investigatorId,
  role,
  onChanged,
}: {
  grantId: string;
  investigatorId: string;
  role: string;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);

  const update = async (next: string) => {
    if (next === role) return;
    setSaving(true);
    const { error } = await supabase
      .from("grant_investigators")
      .update({ role: next })
      .eq("grant_id", grantId)
      .eq("investigator_id", investigatorId);
    setSaving(false);
    if (error) {
      toast({ title: "Could not update role", description: error.message, variant: "destructive" });
    } else {
      onChanged();
      toast({ title: "Role updated" });
    }
  };

  return (
    <select
      value={role}
      disabled={saving}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => { e.stopPropagation(); update(e.target.value); }}
      className="text-[11px] bg-background border border-border rounded px-1.5 py-0.5 outline-none focus:border-primary/50"
    >
      <option value="pi">PI</option>
      <option value="co_pi">Co-PI</option>
      <option value="collaborator">Collaborator</option>
      <option value="trainee">Trainee</option>
      <option value="staff">Staff</option>
    </select>
  );
}

export function InvestigatorSummary({ id }: { id: string }) {
  const { open } = useEntitySummary();
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { isOwner, isClaimed, claim, isClaiming } = useInvestigatorOwnership(id);
  const { isCurator } = useUserTier(); // true for curator OR admin

  const { data, isLoading } = useQuery({
    queryKey: ["entity-investigator", id],
    queryFn: async () => {
      const { data: inv, error } = await supabase
        .from("investigators_public" as any)
        .select("*")
        .eq("id", id)
        .single() as { data: any; error: any };
      if (error) throw error;

      // Get organizations
      const { data: orgLinks } = await supabase
        .from("investigator_organizations")
        .select("organization_id")
        .eq("investigator_id", id);
      const orgIds = orgLinks?.map((o) => o.organization_id) || [];
      const { data: orgs } = orgIds.length
        ? await supabase.from("organizations").select("id, name, resource_id").in("id", orgIds)
        : { data: [] };

      // Get grants
      const { data: grantLinks } = await supabase
        .from("grant_investigators")
        .select("grant_id, role")
        .eq("investigator_id", id);
      const grantIds = grantLinks?.map((g) => g.grant_id).filter(Boolean) || [];
      const { data: grants } = grantIds.length
        ? await supabase.from("grants").select("id, grant_number, title, award_amount, resource_id").in("id", grantIds)
        : { data: [] };

      // Get species from projects linked to these grants
      const { data: projects } = grantIds.length
        ? await supabase.from("projects").select("study_species, grant_id").in("grant_id", grantIds)
        : { data: [] };
      const speciesSet = new Set<string>();
      projects?.forEach((p) => p.study_species?.forEach((s: string) => speciesSet.add(s)));

      return {
        ...inv,
        organizations: orgs || [],
        grantLinks: grantLinks || [],
        grants: grants || [],
        species: Array.from(speciesSet),
      };
    },
  });

  // Detect whether the signed-in user shares any grant with this investigator
  const { data: sharesGrant } = useQuery({
    queryKey: ["investigator-shared-grant", id, user?.id],
    enabled: !!user?.id && !!id,
    queryFn: async () => {
      // Find the editor's investigator record
      const { data: editorInv } = await supabase
        .from("investigators")
        .select("id")
        .eq("user_id", user!.id)
        .maybeSingle();
      if (!editorInv?.id) return false;
      // Get grants for both
      const { data: editorGrants } = await supabase
        .from("grant_investigators")
        .select("grant_id")
        .eq("investigator_id", editorInv.id);
      const { data: targetGrants } = await supabase
        .from("grant_investigators")
        .select("grant_id")
        .eq("investigator_id", id);
      const editorSet = new Set((editorGrants || []).map((g) => g.grant_id));
      return (targetGrants || []).some((g) => editorSet.has(g.grant_id));
    },
  });

  // email AND secondary_emails are deliberately EXCLUDED from investigators_public
  // (email is kept off the public summary; secondary_emails is access-granting — the
  // Globus sign-in gate matches on it). Because the pane reads investigators_public,
  // the Email field bound to data.email showed blank and edits appeared not to save
  // (the write landed, but the read-back view had no email to show). Fetch both from
  // the base table for the OWNER or a curator/admin (RLS permits those), so a member
  // can see and manage their own primary + alternate emails.
  const canSeeSecondary = isOwner || isCurator;
  const { data: priv } = useQuery({
    queryKey: ["investigator-private", id],
    enabled: !!id && canSeeSecondary,
    queryFn: async () => {
      const { data } = await supabase
        .from("investigators")
        .select("email, secondary_emails")
        .eq("id", id)
        .maybeSingle();
      return (data as { email?: string | null; secondary_emails?: string[] } | null) ?? null;
    },
  });

  // Can edit if: user owns this investigator (user_id link), email matches (legacy),
  // user is a curator/admin (Tier 1 or Tier 2), OR user shares a grant with this investigator
  // Editability is determined by ownership / role / shared-grant — email-match
  // is no longer used (email is no longer fetched into the public summary).
  const canEdit = isOwner || isCurator || sharesGrant === true;
  // Show claim button if: user is logged in, investigator is unclaimed, and user doesn't own it
  const canClaim = user && !isClaimed && !isOwner && !canEdit;

  const handleClaim = async () => {
    try {
      await claim();
      toast({ title: "Profile claimed!", description: "You can now edit this investigator profile." });
      queryClient.invalidateQueries({ queryKey: ["entity-investigator", id] });
    } catch (e: any) {
      toast({ title: "Claim failed", description: e.message || "Could not claim this profile.", variant: "destructive" });
    }
  };

  const updateField = useMutation({
    mutationFn: async ({ field, value }: { field: string; value: any }) => {
      const { error } = await supabase
        .from("investigators")
        .update({ [field]: value } as any)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["entity-investigator", id] });
      queryClient.invalidateQueries({ queryKey: ["investigator-private", id] });
      toast({ title: "Updated", description: "Profile field saved." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to save. Try again.", variant: "destructive" });
    },
  });

  const handleSave = useCallback((field: string, value: string) => {
    updateField.mutate({ field, value });
  }, [updateField]);

  if (isLoading) return <SummaryLoading />;
  if (!data) return <p className="p-6 text-muted-foreground">Investigator not found.</p>;

  // Email lives on the base table (investigators_public omits it). Owner/curator get it
  // from `priv`; other viewers don't see an email here (it's kept off the public view).
  const emailValue = (canSeeSecondary ? priv?.email : data.email) || "";

  const completeness = calcCompleteness({ ...data, email: emailValue });

  const summaryContent = (
    <div className="space-y-1">
      {/* Completeness bar */}
      <div className="mb-4 p-3 rounded-lg border border-border bg-muted/20">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs font-medium text-muted-foreground">Profile Completeness</span>
          <span className={`text-xs font-bold ${completeness === 100 ? "text-primary" : completeness >= 70 ? "text-yellow-500" : "text-destructive"}`}>
            {completeness}%
          </span>
        </div>
        <Progress value={completeness} className="h-2" />
        {completeness < 100 && canEdit && (
          <p className="text-[11px] text-muted-foreground mt-1.5">
            Fill in the missing fields below to complete your profile.
          </p>
        )}
      </div>

      {/* Name */}
      <SummaryField label="Name" field="name">
        {canEdit ? (
          <EditableText value={data.name} onSave={(v) => handleSave("name", v)} placeholder="Enter full name" />
        ) : (
          <span className="font-medium">{data.name}</span>
        )}
      </SummaryField>

      {/* Email — sourced from the base table (investigators_public omits it) so the
          owner/curator sees the real value and edits persist visibly. */}
      <SummaryField label="Email" field="email">
        {canEdit ? (
          <EditableText value={emailValue} onSave={(v) => handleSave("email", v)} placeholder="Enter email address" type="email" />
        ) : emailValue ? (
          <a href={`mailto:${emailValue}`} className="text-primary hover:underline">{emailValue}</a>
        ) : (
          <span className="text-muted-foreground italic text-xs">Not provided</span>
        )}
      </SummaryField>

      {/* ORCID */}
      <SummaryField label="ORCID" field="orcid">
        {canEdit ? (
          <EditableText value={data.orcid || ""} onSave={(v) => handleSave("orcid", v)} placeholder="e.g. 0000-0002-1234-5678" type="url" href={data.orcid ? `https://orcid.org/${data.orcid}` : undefined} />
        ) : data.orcid ? (
          <a href={`https://orcid.org/${data.orcid}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">
            {data.orcid} <ExternalLink className="h-3 w-3" />
          </a>
        ) : (
          <span className="text-muted-foreground italic text-xs">Not provided</span>
        )}
      </SummaryField>

      {/* Google Scholar */}
      <SummaryField label="Google Scholar" field="scholar_id">
        {canEdit ? (
          <EditableText value={data.scholar_id || ""} onSave={(v) => handleSave("scholar_id", v)} placeholder="Enter Google Scholar user ID" type="url" href={data.scholar_id ? `https://scholar.google.com/citations?user=${data.scholar_id}` : undefined} />
        ) : data.scholar_id ? (
          <a href={`https://scholar.google.com/citations?user=${data.scholar_id}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">
            View Profile <ExternalLink className="h-3 w-3" />
          </a>
        ) : (
          <span className="text-muted-foreground italic text-xs">Not provided</span>
        )}
      </SummaryField>

      {/* Profile URL */}
      <SummaryField label="Profile URL" field="profile_url">
        {canEdit ? (
          <EditableText
            value={data.profile_url || ""}
            onSave={(v) => handleSave("profile_url", v)}
            placeholder="https://lab.example.edu/your-page"
            type="url"
          />
        ) : data.profile_url ? (
          <a href={data.profile_url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">
            {data.profile_url} <ExternalLink className="h-3 w-3" />
          </a>
        ) : (
          <span className="text-muted-foreground italic text-xs">Not provided</span>
        )}
      </SummaryField>

      {/* Consortium Role */}
      <SummaryField label="Consortium Role" field="role">
        {canEdit ? (
          <EditableText
            value={data.role || ""}
            onSave={(v) => handleSave("role", v)}
            placeholder="e.g. Working Group Chair, Trainee, Steering Committee"
          />
        ) : data.role ? (
          <span>{data.role}</span>
        ) : (
          <span className="text-muted-foreground italic text-xs">Not specified</span>
        )}
      </SummaryField>

      {/* Working Groups */}
      <SummaryField label="Working Groups" field="working_groups">
        {canEdit ? (
          <EditableWorkingGroups
            items={data.working_groups || []}
            onChange={(next) => updateField.mutate({ field: "working_groups", value: next })}
          />
        ) : data.working_groups && data.working_groups.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {data.working_groups.map((wg: string) => <Badge key={wg} variant="secondary">{wg}</Badge>)}
          </div>
        ) : (
          <span className="text-muted-foreground italic text-xs">No working groups</span>
        )}
      </SummaryField>

      {/* Secondary Emails — only the owner or a curator/admin can see/manage these
          (access-granting; not exposed on the public summary). */}
      {canSeeSecondary && (
        <SummaryField label="Secondary Emails" field="secondary_emails">
          {canEdit ? (
            <EditableTagList
              items={priv?.secondary_emails || []}
              onChange={(next) => updateField.mutate({ field: "secondary_emails", value: next })}
              placeholder="Add an alternate email"
            />
          ) : priv?.secondary_emails && priv.secondary_emails.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {priv.secondary_emails.map((e: string) => <Badge key={e} variant="secondary">{e}</Badge>)}
            </div>
          ) : (
            <span className="text-muted-foreground italic text-xs">None</span>
          )}
        </SummaryField>
      )}

      {/* Institutions */}
      <SummaryField label="University/Institution">
        {canEdit ? (
          <EditableInstitutions
            investigatorId={id}
            current={data.organizations}
            onChanged={() => queryClient.invalidateQueries({ queryKey: ["entity-investigator", id] })}
            openEntity={(org) => open({ type: "organization", id: org.id, resourceId: org.resource_id || undefined, label: org.name })}
          />
        ) : data.organizations.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {data.organizations.map((org) => (
              <Badge
                key={org.id}
                variant="outline"
                className="cursor-pointer hover:bg-accent"
                onClick={() => open({ type: "organization", id: org.id, resourceId: org.resource_id || undefined, label: org.name })}
              >
                {org.name}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground italic text-xs">No institutions linked</span>
        )}
      </SummaryField>

      {/* Species — a read-only rollup of this person's projects' study_species. It is
          edited on each project's profile page (Metadata → Species), not here, so the
          value stays a single source of truth on the project. */}
      <SummaryField label="Species">
        {data.species.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {data.species.map((s: string) => <Badge key={s} variant="secondary">{s}</Badge>)}
          </div>
        ) : (
          <span className="text-muted-foreground italic text-xs">No species data</span>
        )}
        <p className="mt-1 text-[11px] text-muted-foreground/80 italic">
          Drawn from this person's projects — edit it on the project's profile page (Metadata → Species).
        </p>
      </SummaryField>

      {/* Skills */}
      <SummaryField label="Skills" field="skills">
        {canEdit ? (
          <EditableTagList
            items={data.skills || []}
            onChange={(next) => updateField.mutate({ field: "skills", value: next })}
            placeholder="Add a skill"
          />
        ) : data.skills && data.skills.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {data.skills.map((s: string) => <Badge key={s} variant="secondary">{s}</Badge>)}
          </div>
        ) : (
          <span className="text-muted-foreground italic text-xs">No skills listed</span>
        )}
      </SummaryField>

      {/* Research Areas */}
      <SummaryField label="Research Areas" field="research_areas">
        {canEdit ? (
          <EditableTagList
            items={data.research_areas || []}
            onChange={(next) => updateField.mutate({ field: "research_areas", value: next })}
            placeholder="Add a research area"
          />
        ) : data.research_areas && data.research_areas.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {data.research_areas.map((a: string) => <Badge key={a} variant="secondary">{a}</Badge>)}
          </div>
        ) : (
          <span className="text-muted-foreground italic text-xs">No research areas listed</span>
        )}
      </SummaryField>

      {/* Grants */}
      {data.grants.length > 0 && (
        <div className="pt-4">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Grants ({data.grants.length})</h3>
          <div className="space-y-2">
            {data.grants.map((g) => {
              const link = data.grantLinks.find((gl: any) => gl.grant_id === g.id);
              return (
                <div
                  key={g.id}
                  className="rounded-lg border border-border p-3 cursor-pointer hover:bg-accent/50 transition-colors"
                  onClick={() => open({ type: "grant", id: g.id, resourceId: g.resource_id || undefined, label: g.grant_number })}
                >
                  <div className="flex items-center gap-2">
                    {canEdit ? (
                      <EditableGrantRole
                        grantId={g.id}
                        investigatorId={id}
                        role={link?.role || "co_pi"}
                        onChanged={() => queryClient.invalidateQueries({ queryKey: ["entity-investigator", id] })}
                      />
                    ) : (
                      <Badge variant="outline" className="text-xs">
                        {link?.role === "pi" ? "PI" : link?.role === "co_pi" ? "Co-PI" : (link?.role || "Co-PI")}
                      </Badge>
                    )}
                    <span className="font-mono text-xs text-muted-foreground">{g.grant_number}</span>
                  </div>
                  <p className="text-sm font-medium mt-1 line-clamp-2">{g.title}</p>
                  {g.award_amount && (
                    <p className="text-xs text-muted-foreground mt-1">${Number(g.award_amount).toLocaleString()}</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {canEdit && (
        <p className="text-xs text-muted-foreground border-t border-border pt-3 mt-4">
          ✏️ You can edit fields above by hovering and clicking the pencil icon.
        </p>
      )}
    </div>
  );

  return (
    <ProvenanceScope table="investigators" id={id}>
    <div>
      <div className="px-6 pt-6 pb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
            <User className="h-5 w-5 text-primary" />
          </div>
          <div className="flex-1">
            <h2 className="text-xl font-bold text-foreground">{data.name}</h2>
            <p className="text-sm text-muted-foreground">
              Investigator
              {data.organizations.length > 0 && ` · ${data.organizations.map((o) => o.name).join(", ")}`}
            </p>
          </div>
          {isOwner && (
            <Badge variant="outline" className="gap-1 text-xs bg-primary/10 text-primary border-primary/30">
              <UserCheck className="h-3 w-3" /> Your Profile
            </Badge>
          )}
          {canClaim && (
            <Button size="sm" variant="outline" className="gap-1.5 text-xs" onClick={handleClaim} disabled={isClaiming}>
              <UserPlus className="h-3.5 w-3.5" />
              {isClaiming ? "Claiming..." : "This is me"}
            </Button>
          )}
          <div className="text-right">
            <span className={`text-lg font-bold ${completeness === 100 ? "text-primary" : completeness >= 70 ? "text-yellow-500" : "text-destructive"}`}>
              {completeness}%
            </span>
            <p className="text-[10px] text-muted-foreground">Complete</p>
          </div>
        </div>
      </div>
      <SummaryTabs tabs={[
        { id: "summary", label: "Summary", icon: <FileText className="h-3.5 w-3.5" />, content: summaryContent },
      ]} />
    </div>
    </ProvenanceScope>
  );
}

function SummaryLoading() {
  return (
    <div className="p-6 space-y-4">
      <Skeleton className="h-10 w-48" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}
