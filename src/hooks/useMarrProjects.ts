/** Marr-layer project data, read from the KNOWLEDGE GRAPH.
 *
 *  Replaces useMarrYaml, which fetched /bbqs_marr.yaml — a checked-in copy of KG content that
 *  Constitution v1.8.1 Principle XI prohibits as a source for rendered fields. That file disagreed
 *  with the KG on 25 of 30 projects and could not be corrected by the people who own the data.
 *
 *  The transformation logic below is lifted UNCHANGED from the YAML hook, so every consumer
 *  (5 diagrams, Species.tsx, SpeciesSummary) receives the same shape it always did. Only the source
 *  changed: KG `projects.metadata` for the Marr levels and synergy prose, and the already-cached
 *  `nih-grants` response for titles, institutions and PI names.
 *
 *  WHERE EACH FIELD COMES FROM now that it is the KG:
 *    computational / algorithmic / implementation  metadata.marr_l1/l2/l3_*
 *    dataModalities                               metadata.produce_data_modality
 *    experimentalApproaches                       metadata.use_approaches
 *    species                                      projects.study_species, then target_species_domain
 *    keywords                                     projects.keywords
 *    synergy links                                metadata.cross_project_synergy
 *  Those metadata keys are the ones recorded as `curated_with_ai` — authored by a named person with
 *  Gemini 3 Pro — so the diagram surfaces are rendering AI-assisted content. That is now visible in
 *  the provenance store rather than implied by a static file claiming to be "strictly audited".
 *
 *  ORDER, therefore COLOUR, is by grant number. The YAML had a hand-arranged order, so a project's
 *  palette colour may differ from before; a deterministic order is worth more than matching an
 *  arbitrary one, since DB row order is not stable across queries.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { coreGrantNumber } from "@/lib/grantNumber";
import type { MarrProject } from "@/data/marr-projects";
import type { SynergyNode, SynergyLink } from "@/data/marr-synergies";

// Color palette for assigning stable colors to projects
const PROJECT_COLORS = [
  "#4fc3f7", "#81c784", "#ffb74d", "#ce93d8", "#f06292",
  "#a1887f", "#90a4ae", "#4db6ac", "#dce775", "#fff176",
  "#80deea", "#c5e1a5", "#b39ddb", "#ffcc80", "#e0e0e0",
  "#ef9a9a", "#ffab91", "#b0bec5", "#e57373", "#f48fb1",
  "#bcaaa4", "#80cbc4", "#ffab40", "#ffe082", "#42a5f5",
  "#66bb6a",
];

function getGrantType(grantNumber: string): "R34" | "R61" | "U01" | "U24" | "R24" {
  if (grantNumber.includes("R34")) return "R34";
  if (grantNumber.includes("R61")) return "R61";
  if (grantNumber.includes("U01")) return "U01";
  if (grantNumber.includes("U24")) return "U24";
  if (grantNumber.includes("R24")) return "R24";
  return "R34";
}

function parseShortName(p: any): string {
  const leads = p.project_leads || [];
  const firstLead = leads[0] || "";
  const lastName = firstLead.split(",")[0]?.trim() || "Unknown";
  // Use a short project descriptor
  const title = p.project_title || "";
  const species = p.target_species_domain || p.species || "";
  
  // Try to create a meaningful short name
  if (title.toLowerCase().includes("bard") || title.toLowerCase().includes("bbqs ai")) return "BARD.CC";
  if (title.toLowerCase().includes("ember") || title.toLowerCase().includes("ecosystem for multi-modal")) return "EMBER";
  
  // Otherwise use PI last name + species/key concept
  const keywords = [
    species,
    ...(p.keywords || []).slice(0, 1),
  ].filter(Boolean);
  
  const descriptor = keywords[0] || title.split(/\s+/).slice(0, 2).join(" ");
  return `${lastName} – ${descriptor}`;
}

function parseProject(p: any, index: number): MarrProject {
  const leads = p.project_leads || [];
  const firstLead = leads[0] || "";
  const piName = firstLead.includes(",")
    ? firstLead.split(",").map((s: string) => s.trim()).reverse().join(" ")
    : firstLead;

  // Parse common names from target_species_domain
  // Formats: "Mus musculus (house mouse)", "Mustela furo; Rodentia (ferret; rodents)",
  //          "Genetic Species (Drosophila / Zebrafish)"
  const tsd = p.target_species_domain || "";
  const commonMatch = tsd.match(/\(([^)]+)\)/);
  const commonName = commonMatch ? commonMatch[1] : "";

  // species field may be a string or array in YAML; normalize to list
  const rawSpecies = p.species || p.target_species_domain || "";
  const speciesList: string[] = Array.isArray(rawSpecies)
    ? rawSpecies.flatMap((s: string) => s.split(/\s*\/\s*/).map((sp: string) => sp.trim())).filter(Boolean)
    : rawSpecies.split(/\s*\/\s*/).map((s: string) => s.trim()).filter(Boolean);
  const speciesStr = speciesList[0] || "";

  // Build a common name map: try to match each species in the list to a common name
  // from the parenthetical in target_species_domain
  const commonNames = commonName.split(/[;\/]/).map((s: string) => s.trim()).filter(Boolean);
  const speciesCommonNames: Record<string, string> = {};
  speciesList.forEach((sp, i) => {
    if (commonNames[i]) {
      speciesCommonNames[sp] = commonNames[i];
    } else if (commonNames.length === 1) {
      speciesCommonNames[sp] = commonNames[0];
    }
  });

  return {
    id: p.grant_number,
    shortName: parseShortName(p),
    title: p.project_title || "",
    pi: piName,
    allPIs: leads,
    species: speciesStr,
    speciesList,
    speciesCommonName: commonName,
    speciesCommonNames,
    institution: p.institution || "",
    color: PROJECT_COLORS[index % PROJECT_COLORS.length],
    computational: splitField(p.marr_l1_ethological_goal),
    algorithmic: splitField(p.marr_l2_algorithmic_function),
    implementation: splitField(p.marr_l3_implementational_hardware),
    dataModalities: p.data_modalities || [],
    experimentalApproaches: p.experimental_approaches || [],
    keywords: p.keywords || [],
  };
}

function splitField(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[;.]/)
    .map((s: string) => s.trim())
    .filter((s: string) => s.length > 0);
}

function parseSynergyFromProjects(projects: MarrProject[], rawProjects: any[]): {
  nodes: SynergyNode[];
  links: SynergyLink[];
} {
  const nodes: SynergyNode[] = projects.map((p) => ({
    id: p.id,
    shortName: p.shortName,
    pi: p.pi,
    species: p.species,
    color: p.color,
    grantType: getGrantType(p.id),
    l1Goal: p.computational.join(" & ") || "—",
  }));

  const links: SynergyLink[] = [];
  const projectIdSet = new Set(projects.map((p) => p.id));

  for (const raw of rawProjects) {
    const synText = raw.cross_project_synergy;
    if (!synText || typeof synText !== "string") continue;

    // Extract grant numbers mentioned in synergy text
    const grantPattern = /([A-Z0-9]+(?:DA|MH)\d+)/g;
    let match: RegExpExecArray | null;
    const targets: string[] = [];

    while ((match = grantPattern.exec(synText)) !== null) {
      const candidate = match[1];
      const core = coreGrantNumber(candidate);
      if (core !== raw.grant_number && projectIdSet.has(core)) {
        targets.push(core);
      }
    }

    // Also check for prefixed patterns like 1U01DA063534
    const prefixedPattern = /\d+([A-Z]\d+[A-Z]+\d+)/g;
    while ((match = prefixedPattern.exec(synText)) !== null) {
      const core = coreGrantNumber(match[0]);
      if (core !== raw.grant_number && projectIdSet.has(core)) {
        if (!targets.includes(core)) targets.push(core);
      }
    }

    // Determine synergy type from keywords
    const synergyType = inferSynergyType(synText);

    for (const target of targets) {
      links.push({
        source: raw.grant_number,
        target,
        description: synText,
        synergyType,
      });
    }
  }

  return { nodes, links };
}

function inferSynergyType(text: string): SynergyLink["synergyType"] {
  const lower = text.toLowerCase();
  if (lower.includes("hardware") || lower.includes("sensor") || lower.includes("lidar") || lower.includes("mmwave") || lower.includes("camera") || lower.includes("opm")) return "hardware";
  if (lower.includes("data") || lower.includes("dataset") || lower.includes("gps") || lower.includes("schema")) return "data";
  if (lower.includes("bard") || lower.includes("ember") || lower.includes("standardization") || lower.includes("infrastructure") || lower.includes("ontolog")) return "infrastructure";
  if (lower.includes("theor") || lower.includes("evolutionary") || lower.includes("cross-species") || lower.includes("autonomic") || lower.includes("foraging") || lower.includes("musculoskeletal") || lower.includes("embodied")) return "theoretical";
  return "algorithmic";
}

/** The record shape the parsers above expect, built from KG rows. Deliberately mimics the YAML
 *  field names so the parsers stay untouched and the diff stays reviewable. */
function toRawProject(
  kg: { grant_number: string | null; study_species: string[] | string | null;
        keywords: string[] | null; metadata: Record<string, any> | null },
  grant: { title?: string; institution?: string; piDetails?: { firstName: string; lastName: string; isContactPi: boolean }[]; allPis?: string; contactPi?: string } | undefined,
) {
  const md = kg.metadata ?? {};
  // "Lastname, Firstname", contact PI first — the format parseProject and parseShortName parse.
  const leads = (grant?.piDetails ?? [])
    .slice()
    .sort((a, b) => Number(b.isContactPi) - Number(a.isContactPi))
    .map((d) => [d.lastName, d.firstName].filter(Boolean).join(", "))
    .filter(Boolean);
  return {
    grant_number: coreGrantNumber(kg.grant_number),
    project_title: grant?.title ?? "",
    project_leads: leads.length ? leads : (grant?.contactPi ? [grant.contactPi] : []),
    institution: grant?.institution ?? "",
    species: kg.study_species ?? "",
    target_species_domain: md.target_species_domain ?? "",
    keywords: kg.keywords ?? [],
    marr_l1_ethological_goal: md.marr_l1_ethological_goal ?? "",
    marr_l2_algorithmic_function: md.marr_l2_algorithmic_function ?? "",
    marr_l3_implementational_hardware: md.marr_l3_implementational_hardware ?? "",
    data_modalities: asList(md.produce_data_modality),
    experimental_approaches: asList(md.use_approaches),
    cross_project_synergy: typeof md.cross_project_synergy === "string" ? md.cross_project_synergy : "",
  };
}

/** Metadata values are sometimes an array, sometimes a comma/semicolon string. */
function asList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string") return v.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

export interface MarrProjectsData {
  projects: MarrProject[];
  synergyNodes: SynergyNode[];
  synergyLinks: SynergyLink[];
  /** True only while the KG read is in flight. Titles arrive separately — see grantsLoading. */
  loading: boolean;
  /** Project titles and PI names are still on their way from the nih-grants function. */
  grantsLoading: boolean;
  error: string | null;
}

export function useMarrProjects(): MarrProjectsData {
  const kgQuery = useQuery({
    queryKey: ["marr-projects-kg"],
    staleTime: 60 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("projects")
        .select("grant_number, study_species, keywords, metadata");
      if (error) throw error;
      return data ?? [];
    },
  });

  // Same queryKey the /projects page uses, so React Query serves this from cache instead of
  // calling the edge function twice.
  const grantsQuery = useQuery({
    queryKey: ["nih-grants"],
    staleTime: 60 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("nih-grants");
      if (error) throw error;
      return (Array.isArray(data?.data) ? data.data : []) as any[];
    },
  });

  const value = useMemo(() => {
    const kgRows = (kgQuery.data ?? []) as any[];
    const byGrant = new Map<string, any>();
    for (const g of grantsQuery.data ?? []) byGrant.set(coreGrantNumber(g.grantNumber), g);

    const raw = kgRows
      .filter((r) => coreGrantNumber(r.grant_number))
      .map((r) => toRawProject(r, byGrant.get(coreGrantNumber(r.grant_number))))
      .sort((a, b) => a.grant_number.localeCompare(b.grant_number));

    const projects = raw.map((p, i) => parseProject(p, i));
    const { nodes, links } = parseSynergyFromProjects(projects, raw);
    return { projects, synergyNodes: nodes, synergyLinks: links };
  }, [kgQuery.data, grantsQuery.data]);

  return {
    ...value,
    // Only the KG query blocks. nih-grants is an edge function that calls NIH RePORTER, so it can
    // be slow or cold-start — and all it contributes here is project TITLES and PI names. Waiting
    // on it left /species showing "Loading" while the species themselves were already in hand.
    // Titles fill in when they arrive; a grant number is a usable label until then.
    loading: kgQuery.isLoading,
    grantsLoading: grantsQuery.isLoading,
    error: (kgQuery.error as Error)?.message ?? (grantsQuery.error as Error)?.message ?? null,
  };
}
