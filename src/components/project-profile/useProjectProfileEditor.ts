// The editable project profile, as state — so the full-page view and the card tab are the same
// thing rather than one being a link to the other.
//
// WHY THIS EXISTS. The profile is the richest view of a project on the site: every questionnaire
// answer, each with the grade of the source that supplied it. It lived only at
// /projects/:grantNumber/profile, so the card's "Manage" tab was a tab containing one button whose
// job was to leave. A tab that holds a button to the content is not a tab, and the user said so.
//
// Splitting the editor out of the page means the tab shows the real fields, edits them in place,
// and saves through exactly the same code path. The page keeps its own layout (wider, with the
// grant header and EMBER panel); only the state and the write are shared.
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "@/hooks/use-toast";
import { useFieldProvenance } from "@/hooks/useFieldProvenance";
import { TOP_LEVEL_FIELDS, COMPLETENESS_FIELDS } from "@/data/questionnaire-fields";

export function useProjectProfileEditor(grantNumber: string | null, canEdit: boolean) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [changes, setChanges] = useState<Record<string, any>>({});
  const [isCommitting, setIsCommitting] = useState(false);

  const { data, isLoading } = useQuery({
    // Same key as the page used, so opening the tab after the page (or the reverse) is a cache hit
    // and the two never show different values for the same project.
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
      // The card's summary and the projects grid read the same project row, so they must not keep
      // showing the value that was just replaced.
      queryClient.invalidateQueries({ queryKey: ["kg-projects"] });
    } catch (e: any) {
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    } finally {
      setIsCommitting(false);
    }
  };

  return {
    data, isLoading, provenance, pendingKeys,
    getValue, setFieldValue, changedKeys, hasChanges,
    completeness, commit, isCommitting,
    discard: () => setChanges({}),
  };
}

export type ProjectProfileEditor = ReturnType<typeof useProjectProfileEditor>;
