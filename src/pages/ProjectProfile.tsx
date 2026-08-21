import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Save, RotateCcw, Loader2, FileText } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { useCanEditProject } from "@/hooks/useCanEditProject";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/hooks/use-toast";
import { PageMeta } from "@/components/PageMeta";
import { useFieldProvenance } from "@/hooks/useFieldProvenance";
import { useUserTier } from "@/hooks/useUserTier";
import { AccessGate } from "@/components/project-profile/AccessGate";
import { TeamRosterEditor } from "@/components/project-profile/TeamRosterEditor";
import { QuestionnaireSection } from "@/components/project-profile/QuestionnaireSection";
import { EmberDandisetsPanel } from "@/components/project-profile/EmberDandisetsPanel";
import {
  QUESTIONNAIRE_SECTIONS, TOP_LEVEL_FIELDS, COMPLETENESS_FIELDS,
} from "@/data/questionnaire-fields";

export default function ProjectProfile() {
  const { grantNumber } = useParams<{ grantNumber: string }>();
  const { user, loading: authLoading } = useAuth();
  const { canEdit, isLoading: permLoading } = useCanEditProject(grantNumber || null);
  // READING and EDITING are different permissions. They were the same one, so a consortium member
  // who is not on a grant got an access wall instead of the richest page on the site — and the only
  // route in was a "Manage" button that was itself hidden from them.
  const { isMember, isLoading: tierLoading } = useUserTier();
  const queryClient = useQueryClient();
  const [changes, setChanges] = useState<Record<string, any>>({});
  const [isCommitting, setIsCommitting] = useState(false);

  // Read URL hash for deep-linking to a specific questionnaire section
  const [hashSection, setHashSection] = useState<string>(() =>
    typeof window !== "undefined" ? window.location.hash.replace(/^#/, "") : ""
  );
  useEffect(() => {
    const onHash = () => setHashSection(window.location.hash.replace(/^#/, ""));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  // After data renders, scroll to the targeted section once
  useEffect(() => {
    if (!hashSection) return;
    const t = setTimeout(() => {
      const el = document.getElementById(hashSection);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 150);
    return () => clearTimeout(t);
  }, [hashSection]);

  const { data, isLoading } = useQuery({
    queryKey: ["project-profile", grantNumber],
    enabled: !!grantNumber,
    queryFn: async () => {
      const { data: grant, error: gErr } = await supabase
        .from("grants").select("*").eq("grant_number", grantNumber!).maybeSingle();
      if (gErr) throw gErr;
      if (!grant) return null;
      const { data: project } = await supabase
        .from("projects").select("*").eq("grant_number", grantNumber!).maybeSingle();
      return { grant, project };
    },
  });

  // One query for the whole project rather than one per field. Comes back empty for non-staff
  // viewers (provenance is RLS-restricted), and ProvenanceChip renders nothing in that case.
  const provenance = useFieldProvenance("projects", (data?.project as any)?.id);

  const pendingKeys = useMemo(() => new Set<string>(), []);

  const original = useMemo(() => {
    if (!data?.project) return {} as Record<string, any>;
    const p: any = data.project;
    const meta = p.metadata || {};
    return {
      study_species: p.study_species,
      study_human: p.study_human,
      keywords: p.keywords,
      website: p.website,
      ...meta,
    };
  }, [data?.project]);

  const getValue = (key: string) => (key in changes ? changes[key] : original[key]);

  const setFieldValue = (key: string, value: any) => {
    if (!canEdit) return;   // belt as well as braces: the fields render read-only, and this refuses anyway
    const eq = JSON.stringify(value) === JSON.stringify(original[key]);
    setChanges((prev) => {
      const next = { ...prev };
      if (eq) delete next[key];
      else next[key] = value;
      return next;
    });
  };

  const changedKeys = useMemo(() => new Set(Object.keys(changes)), [changes]);
  const hasChanges = changedKeys.size > 0;

  const completeness = useMemo(() => {
    const merged = { ...original, ...changes };
    const filled = COMPLETENESS_FIELDS.filter((f) => {
      const v = merged[f];
      if (Array.isArray(v)) return v.length > 0;
      if (typeof v === "string") return v.trim().length > 0;
      return v !== null && v !== undefined;
    });
    return Math.round((filled.length / COMPLETENESS_FIELDS.length) * 100);
  }, [original, changes]);

  const commit = async () => {
    if (!hasChanges || !data?.grant) return;
    setIsCommitting(true);
    try {
      const topLevel: Record<string, any> = {};
      const metaChanges: Record<string, any> = {};
      for (const [k, v] of Object.entries(changes)) {
        if (TOP_LEVEL_FIELDS.has(k)) topLevel[k] = v;
        else metaChanges[k] = v;
      }
      const row: Record<string, any> = {
        grant_number: data.grant.grant_number,
        grant_id: data.grant.id,
        last_edited_by: user?.id ?? null,
        metadata_completeness: completeness,
        ...topLevel,
      };
      if (Object.keys(metaChanges).length > 0) {
        row.metadata = { ...((data.project as any)?.metadata || {}), ...metaChanges };
      }
      const { error } = await (supabase.from("projects" as any) as any)
        .upsert(row, { onConflict: "grant_number" });
      if (error) throw error;

      // Audit log
      const historyRows = Object.entries(changes).map(([field, newValue]) => ({
        grant_number: data.grant.grant_number,
        project_id: (data.project as any)?.id ?? null,
        field_name: field,
        old_value: original[field] ?? null,
        new_value: newValue,
        edited_by: user?.email || "unknown",
        validation_status: "user_edit",
      }));
      if (historyRows.length > 0) {
        await supabase.from("edit_history").insert(historyRows);
      }

      toast({ title: "Saved", description: `${changedKeys.size} field(s) updated.` });
      setChanges({});
      queryClient.invalidateQueries({ queryKey: ["project-profile", grantNumber] });
    } catch (e: any) {
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    } finally {
      setIsCommitting(false);
    }
  };

  // ── Render gates ────────────────────────────────────────────────
  if (!grantNumber) return <div className="p-8">Missing grant number.</div>;
  if (authLoading) return <div className="p-8"><Skeleton className="h-8 w-64" /></div>;
  if (!user) return <AccessGate reason="unauthenticated" grantNumber={grantNumber} />;
  if (permLoading || tierLoading) return <div className="p-8"><Skeleton className="h-8 w-64" /></div>;
  // Any consortium member (tier 3 and up) may READ a project profile. Editing still needs canEdit.
  if (!isMember) return <AccessGate reason="insufficient-tier" grantNumber={grantNumber} />;
  if (isLoading) return <div className="p-8 space-y-3"><Skeleton className="h-8 w-64" /><Skeleton className="h-32 w-full" /></div>;
  if (!data?.grant) return <div className="p-8 text-muted-foreground">Grant not found.</div>;

  return (
    <>
      <PageMeta
        title={`${data.grant.grant_number} · BBQS`}
        description={`Project profile for ${data.grant.title}`}
      />
      <div className="max-w-5xl mx-auto px-4 py-6 space-y-4">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="sm">
            <Link to="/projects"><ArrowLeft className="h-4 w-4 mr-1.5" /> Projects</Link>
          </Button>
          <div className="text-xs text-muted-foreground">/</div>
          <span className="text-xs text-muted-foreground">
            {canEdit ? "Manage Project Profile" : "Project Profile"}
          </span>
          {!canEdit && (
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground border border-border rounded px-1.5 py-0.5">
              read only
            </span>
          )}
        </div>

        {/* Grant card */}
        <div className="bg-card border border-border rounded-xl p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs font-mono text-muted-foreground mb-1">{data.grant.grant_number}</p>
              <h1 className="text-xl font-bold text-foreground leading-snug">{data.grant.title}</h1>
              {data.grant.fiscal_year && (
                <p className="text-sm text-muted-foreground mt-1">
                  FY{data.grant.fiscal_year}
                  {data.grant.award_amount ? ` · $${Number(data.grant.award_amount).toLocaleString()}` : ""}
                </p>
              )}
            </div>
            <div className="text-right shrink-0">
              <p className="text-xs text-muted-foreground mb-1">Metadata complete</p>
              <p className="text-2xl font-bold text-foreground tabular-nums">{completeness}%</p>
            </div>
          </div>
        </div>

        {/* Sticky action bar */}
        {canEdit && hasChanges && (
          <div className="sticky top-0 z-30 bg-card/95 backdrop-blur-sm border border-amber-500/30 rounded-xl px-4 py-3 flex items-center justify-between shadow-sm">
            <p className="text-sm text-foreground">
              <span className="font-medium text-amber-600 dark:text-amber-400">{changedKeys.size}</span>{" "}
              field{changedKeys.size !== 1 ? "s" : ""} modified
            </p>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setChanges({})} disabled={isCommitting}>
                <RotateCcw className="h-3.5 w-3.5 mr-1.5" /> Discard
              </Button>
              <Button size="sm" onClick={commit} disabled={isCommitting}>
                {isCommitting ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
                Save changes
              </Button>
            </div>
          </div>
        )}

        {/* Team roster */}
        <TeamRosterEditor grantId={data.grant.id} canEdit={canEdit} />

        {/* EMBER datasets linked by award number */}
        <EmberDandisetsPanel grantId={data.grant.id} canSync={canEdit} />

        {/* Questionnaire sections */}
        <div className="space-y-3">
          <div className="flex items-center gap-2 px-1">
            <FileText className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
              Project Questionnaire
            </h2>
          </div>
          {QUESTIONNAIRE_SECTIONS.map((section, idx) => (
            <QuestionnaireSection
              key={section.id}
              section={section}
              getValue={getValue}
              onSave={setFieldValue}
              changedKeys={changedKeys}
              pendingKeys={pendingKeys}
              provenance={provenance}
              readOnly={!canEdit}
              defaultOpen={hashSection === section.id || idx < 2}
            />
          ))}
        </div>

      </div>
    </>
  );
}

