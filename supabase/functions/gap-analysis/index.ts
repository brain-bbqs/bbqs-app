import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.93.3";
import { requireService } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const METADATA_FIELDS = [
  "study_species", "use_approaches", "use_sensors", "produce_data_modality",
  "produce_data_type", "use_analysis_types", "use_analysis_method",
  "develope_software_type", "develope_hardware_type", "keywords", "website",
];

/** Read a metadata field — some are top-level columns, others in metadata JSONB */
function getField(project: Record<string, any>, field: string): any {
  const TOP_LEVEL = new Set(["study_species", "study_human", "keywords", "website"]);
  if (TOP_LEVEL.has(field)) return project[field];
  const meta = project.metadata || {};
  return meta[field] ?? null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const denied = await requireService(req, corsHeaders);
  if (denied) return denied;

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: projects, error } = await sb.from("projects").select("*");
    if (error) throw error;

    const totalProjects = projects?.length || 0;

    // Per-field analysis
    const fieldStats: Record<string, { filled: number; empty: number; percentage: number; topValues: { value: string; count: number }[] }> = {};

    for (const field of METADATA_FIELDS) {
      const valueCounts = new Map<string, number>();
      let filled = 0;
      let empty = 0;

      for (const project of (projects || [])) {
        const val = getField(project, field);
        const isFilled = Array.isArray(val) ? val.length > 0 : (typeof val === "string" ? val.trim().length > 0 : val !== null && val !== undefined);
        
        if (isFilled) {
          filled++;
          if (Array.isArray(val)) {
            for (const v of val) {
              const key = String(v).toLowerCase().trim();
              valueCounts.set(key, (valueCounts.get(key) || 0) + 1);
            }
          }
        } else {
          empty++;
        }
      }

      const topValues = [...valueCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([value, count]) => ({ value, count }));

      fieldStats[field] = {
        filled,
        empty,
        percentage: totalProjects > 0 ? Math.round((filled / totalProjects) * 100) : 0,
        topValues,
      };
    }

    // Completeness distribution
    const completenessDistribution = { low: 0, medium: 0, high: 0, complete: 0 };
    const lowCompletenessProjects: { grant_number: string; completeness: number; missing_fields: string[] }[] = [];

    for (const project of (projects || [])) {
      const comp = (project as any).metadata_completeness || 0;
      if (comp < 25) completenessDistribution.low++;
      else if (comp < 50) completenessDistribution.medium++;
      else if (comp < 75) completenessDistribution.high++;
      else completenessDistribution.complete++;

      if (comp < 50) {
        const missing = METADATA_FIELDS.filter(f => {
          const val = getField(project, f);
          if (Array.isArray(val)) return val.length === 0;
          if (typeof val === "string") return val.trim().length === 0;
          return val === null || val === undefined;
        });
        lowCompletenessProjects.push({
          grant_number: project.grant_number,
          completeness: comp,
          missing_fields: missing,
        });
      }
    }

    lowCompletenessProjects.sort((a, b) => a.completeness - b.completeness);

    const mostMissing = METADATA_FIELDS
      .map(f => ({ field: f, empty: fieldStats[f].empty, percentage: fieldStats[f].percentage }))
      .sort((a, b) => b.empty - a.empty);

    return new Response(JSON.stringify({
      total_projects: totalProjects,
      average_completeness: totalProjects > 0
        ? Math.round((projects || []).reduce((sum, p) => sum + ((p as any).metadata_completeness || 0), 0) / totalProjects)
        : 0,
      completeness_distribution: completenessDistribution,
      most_missing_fields: mostMissing,
      field_stats: fieldStats,
      low_completeness_projects: lowCompletenessProjects.slice(0, 20),
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("gap-analysis error:", e);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});