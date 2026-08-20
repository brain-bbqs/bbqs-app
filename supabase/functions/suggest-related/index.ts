import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Computes Jaccard similarity between two string arrays.
 */
function jaccard(a: string[], b: string[]): number {
  if (!a?.length || !b?.length) return 0;
  const setA = new Set(a.map(s => s.toLowerCase().trim()));
  const setB = new Set(b.map(s => s.toLowerCase().trim()));
  const intersection = [...setA].filter(x => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    // Declare what kind of source this is (Constitution XI). Without it, a service-role write
    // resolves to 'unknown' and the provenance guard refuses it against any human-authored cell --
    // correctly, but silently, since supabase-js returns errors rather than throwing.
    //
    // Set on THIS server-side client only. A global header on the browser client once broke every
    // edge function's CORS allow-list; server-to-PostgREST calls have no preflight, so this is safe.
    //
    // 'algorithmic' (G5), not 'llm_extract' (G6): this is field-overlap similarity scoring with no
    // model in it, and a provenance record naming a model that never ran would send whoever reads it
    // looking for something that does not exist. x-bbqs-client names the specific rule, so the
    // recorded claim says WHICH script produced the value and not merely that a machine did.
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      global: {
        headers: {
          "x-bbqs-source-class": "algorithmic",
          "x-bbqs-client": "suggest-related",
        },
      },
    });

    const body = await req.json().catch(() => ({}));
    const targetGrantNumber = body.grant_number as string | undefined;
    const threshold = body.threshold ?? 0.15;
    const maxSuggestions = body.max ?? 5;

    // Fetch all projects
    const { data: projects, error } = await sb
      .from("projects")
      .select("id, grant_number, study_species, keywords, metadata");
    if (error) throw error;
    if (!projects?.length) {
      return new Response(JSON.stringify({ suggestions: [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Helper: get field value from top-level or metadata JSONB
    const TOP_LEVEL = new Set(["study_species", "keywords"]);
    function getField(p: any, field: string): string[] {
      if (TOP_LEVEL.has(field)) return p[field] || [];
      return (p.metadata || {})[field] || [];
    }

    // Build comparison fields for each project
    const fields = ["study_species", "use_approaches", "use_sensors", "produce_data_modality", "use_analysis_method", "keywords"] as const;

    const projectsToProcess = targetGrantNumber
      ? projects.filter(p => p.grant_number === targetGrantNumber)
      : projects;

    const results: { grant_number: string; suggestions: { grant_number: string; score: number; shared_fields: Record<string, string[]> }[]; updated: boolean }[] = [];

    for (const project of projectsToProcess) {
      const scores: { other: typeof projects[0]; score: number; shared: Record<string, string[]> }[] = [];

      for (const other of projects) {
        if (other.grant_number === project.grant_number) continue;

        let totalScore = 0;
        const shared: Record<string, string[]> = {};

        for (const field of fields) {
          const a = getField(project, field);
          const b = getField(other, field);
          const sim = jaccard(a, b);
          totalScore += sim;

          if (sim > 0) {
            const setA = new Set((a as string[]).map(s => s.toLowerCase().trim()));
            shared[field] = (b as string[]).filter(s => setA.has(s.toLowerCase().trim()));
          }
        }

        const avgScore = totalScore / fields.length;
        if (avgScore >= threshold) {
          scores.push({ other, score: Math.round(avgScore * 100) / 100, shared });
        }
      }

      scores.sort((a, b) => b.score - a.score);
      const topSuggestions = scores.slice(0, maxSuggestions);

      const suggestedIds = topSuggestions.map(s => s.other.id);
      const existingIds = (project.metadata || {}).related_project_ids || [];
      const newIds = [...new Set([...existingIds, ...suggestedIds])];

      let updated = false;
      let skipped: string | null = null;
      if (newIds.length > existingIds.length) {
        const meta = { ...(project.metadata || {}), related_project_ids: newIds };
        const { error: writeErr } = await sb
          .from("projects").update({ metadata: meta }).eq("grant_number", project.grant_number);
        if (writeErr) {
          // The provenance guard raises check_violation when a machine write would overwrite a
          // human-authored value. That is the intended outcome, not a fault: related_project_ids was
          // written by a person working with a model (G4), and a computed suggestion (G5) does not
          // get to silently replace it. Report it and carry on to the next project instead of failing the
          // whole batch -- and never claim updated:true, which is what this code did before, because
          // the error was not read at all.
          if (writeErr.code === "23514" || /Refusing to overwrite/.test(writeErr.message ?? "")) {
            skipped = "held by a human-authored source; suggestions not applied";
            console.log(`suggest-related: ${project.grant_number} ${skipped}`);
          } else {
            throw writeErr;
          }
        } else {
          updated = true;
        }
      }

      results.push({
        grant_number: project.grant_number,
        suggestions: topSuggestions.map(s => ({
          grant_number: s.other.grant_number,
          score: s.score,
          shared_fields: s.shared,
        })),
        updated,
        skipped,
      });
    }

    return new Response(JSON.stringify({ processed: results.length, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("suggest-related error:", e);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
