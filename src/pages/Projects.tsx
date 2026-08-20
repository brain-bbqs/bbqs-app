"use client";

import { useState, useMemo, useCallback } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { MobileCardList } from "@/components/MobileCardList";
import { useNavigate, useSearchParams } from "react-router-dom";
import { PageMeta } from "@/components/PageMeta";
import { useHashState } from "@/hooks/useHashState";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, CellMouseOverEvent, CellMouseOutEvent } from "ag-grid-community";
import { useQuery } from "@tanstack/react-query";
import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-alpine.css";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ExternalLink, Download, Loader2, RefreshCw, FileText, DollarSign, FolderOpen, Users, FileDown } from "lucide-react";
import { normalizePiName } from "@/lib/pi-utils";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { coreGrantNumber } from "@/lib/grantNumber";
import { formatAuthors } from "@/components/projects/PublicationsGrid";
import { FundingCharts } from "@/components/projects/FundingCharts";
import { SpeciesHeatmap } from "@/components/diagrams/SpeciesHeatmap";
import "@/styles/ag-grid-theme.css";
import { useEntitySummary } from "@/contexts/EntitySummaryContext";
import { useUserTier } from "@/hooks/useUserTier";
import { useGrantsWithDandisets } from "@/hooks/useGrantsWithDandisets";
import { AddProjectByGrantDialog } from "@/components/admin/AddProjectByGrantDialog";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/contexts/AuthContext";

interface Publication {
  pmid: string;
  title: string;
  authors: string | { name: string }[];
  year: number;
  journal: string;
  citations: number;
  rcr: number;
  pubmedLink: string;
}

interface PiDetail {
  fullName: string;
  firstName: string;
  lastName: string;
  profileId: number | null;
  isContactPi: boolean;
}

interface ProjectRow {
  grantNumber: string;
  title: string;
  contactPi: string;
  allPis: string;
  piDetails?: PiDetail[];
  institution: string;
  fiscalYear: number;
  awardAmount: number;
  nihLink: string;
  publications: Publication[];
  publicationCount: number;
  species?: string;
}

type RawPublication = Partial<Publication> | null | undefined;

type RawPiDetail = Partial<PiDetail> | null | undefined;

type RawProjectRow = Partial<Omit<ProjectRow, "publications" | "piDetails">> & {
  publications?: RawPublication[] | null;
  piDetails?: RawPiDetail[] | null;
};

const toSafeString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const toSafeNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const normalizePublication = (publication: RawPublication): Publication => ({
  pmid: toSafeString(publication?.pmid),
  title: toSafeString(publication?.title),
  authors:
    typeof publication?.authors === "string" || Array.isArray(publication?.authors)
      ? publication.authors
      : "",
  year: toSafeNumber(publication?.year),
  journal: toSafeString(publication?.journal),
  citations: toSafeNumber(publication?.citations),
  rcr: toSafeNumber(publication?.rcr),
  pubmedLink: toSafeString(publication?.pubmedLink),
});

const normalizePiDetails = (details: RawPiDetail[] | null | undefined): PiDetail[] | undefined => {
  if (!Array.isArray(details)) return undefined;

  const normalized = details
    .map((detail) => ({
      fullName: toSafeString(detail?.fullName).trim(),
      firstName: toSafeString(detail?.firstName).trim(),
      lastName: toSafeString(detail?.lastName).trim(),
      profileId: typeof detail?.profileId === "number" ? detail.profileId : null,
      isContactPi: Boolean(detail?.isContactPi),
    }))
    .filter((detail) => detail.fullName);

  return normalized.length > 0 ? normalized : undefined;
};

const normalizeProjectRow = (row: RawProjectRow): ProjectRow | null => {
  const grantNumber = toSafeString(row.grantNumber).trim();
  if (!grantNumber) return null;

  const publications = Array.isArray(row.publications)
    ? row.publications.filter(Boolean).map(normalizePublication)
    : [];

  const contactPi = toSafeString(row.contactPi).trim();
  const allPis = toSafeString(row.allPis).trim() || contactPi;

  return {
    grantNumber,
    title: toSafeString(row.title).trim() || "Untitled project",
    contactPi,
    allPis,
    piDetails: normalizePiDetails(row.piDetails),
    institution: toSafeString(row.institution).trim(),
    fiscalYear: toSafeNumber(row.fiscalYear),
    awardAmount: toSafeNumber(row.awardAmount),
    nihLink: toSafeString(row.nihLink).trim(),
    publications,
    publicationCount:
      typeof row.publicationCount === "number" && Number.isFinite(row.publicationCount)
        ? row.publicationCount
        : publications.length,
    species: toSafeString(row.species).trim(),
  };
};

const TitleCell = ({ value, data }: { value: string; data: ProjectRow }) => {
  const { open } = useEntitySummary();
  const { data: emberSet } = useGrantsWithDandisets();
  const noSuffix = data.grantNumber.replace(/-\d+$/, "");
  const noPrefix = noSuffix.replace(/^\d+/, "");
  const hasEmber =
    !!emberSet &&
    (emberSet.has(data.grantNumber) || emberSet.has(noSuffix) || emberSet.has(noPrefix));
  
  const handleClick = async () => {
    // API returns "1U01DA063534-01", DB may store "1U01DA063534" or "U01DA063534"
    const candidates = [...new Set([data.grantNumber, noSuffix, noPrefix])];
    const { data: grant } = await supabase
      .from("grants")
      .select("id, resource_id")
      .in("grant_number", candidates)
      .maybeSingle();
    if (grant) {
      open({ type: "grant", id: grant.id, resourceId: grant.resource_id || undefined, label: data.grantNumber });
    }
  };

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex items-center gap-1.5 min-w-0">
            <button
              onClick={handleClick}
              className="font-medium text-foreground hover:text-primary hover:underline truncate block max-w-full text-left"
            >
              {value}
            </button>
            {hasEmber && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleClick();
                }}
                title="View linked EMBER dataset(s) for this grant"
                className="shrink-0 inline-flex items-center rounded-full bg-emerald-500/15 text-emerald-700 border border-emerald-500/30 text-[10px] px-1.5 h-4 font-semibold hover:bg-emerald-500/25 hover:underline"
              >
                EMBER data →
              </button>
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-md">
          <p className="font-medium">{value}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

const TruncatedCell = ({ value }: { value: string }) => {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="truncate block max-w-full">{value}</span>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>{value}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};


const PiCell = ({ data }: { value: string; data: ProjectRow }) => {
  const { open } = useEntitySummary();
  const piDetails = data.piDetails;

  const openInvestigator = async (name: string) => {
    const { data: inv } = await supabase
      .from("investigators_public" as any)
      .select("id, resource_id")
      .ilike("name", `%${name.split(" ").pop()}%`)
      .maybeSingle() as { data: { id: string; resource_id: string | null } | null };
    if (inv) {
      open({ type: "investigator", id: inv.id, resourceId: inv.resource_id || undefined, label: name });
    }
  };
  
  if (piDetails && piDetails.length > 0) {
    return (
      <span className="block w-full max-w-full whitespace-normal break-words leading-[1.4]">
        {piDetails.map((pi, i) => {
          const displayName = normalizePiName(pi.fullName);
          return (
            <span key={i}>
              <span
                className="text-primary hover:underline cursor-pointer"
                title={`View ${displayName}`}
                onClick={(e) => {
                  e.stopPropagation();
                  openInvestigator(displayName);
                }}
              >
                {displayName}
              </span>
              {i < piDetails.length - 1 ? ", " : ""}
            </span>
          );
        })}
      </span>
    );
  }

  const piNames = (data.allPis || "").split(/[,;]/).map((n) => n.trim()).filter(Boolean);
  const normalizedNames = piNames.map(normalizePiName);

  return (
    <span className="block w-full max-w-full whitespace-normal break-words leading-[1.4]">
      {normalizedNames.map((name, i) => (
        <span key={i}>
          <span
            className="text-primary hover:underline cursor-pointer"
            title={`View ${name}`}
            onClick={(e) => {
              e.stopPropagation();
              openInvestigator(name);
            }}
          >
            {name}
          </span>
          {i < normalizedNames.length - 1 ? ", " : ""}
        </span>
      ))}
    </span>
  );
};

const InstitutionCell = ({ value }: { value: string }) => {
  const { open } = useEntitySummary();
  if (!value) return <span className="text-muted-foreground">—</span>;

  const openOrg = async () => {
    const { data: org } = await supabase
      .from("organizations")
      .select("id, resource_id")
      .ilike("name", `%${value}%`)
      .maybeSingle();
    if (org) {
      open({ type: "organization", id: org.id, resourceId: org.resource_id || undefined, label: value });
    }
  };

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={openOrg}
            className="block w-full max-w-full whitespace-normal break-words leading-[1.4] text-primary hover:underline cursor-pointer text-left"
          >
            {value}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>View {value}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

const CurrencyCell = ({ value }: { value: number }) => {
  if (!value) return <span className="text-muted-foreground">—</span>;
  return <span className="font-mono text-emerald-600">${value.toLocaleString()}</span>;
};

const GrantTypeBadge = ({ value }: { value: string }) => {
  if (!value) return <Badge variant="outline" className="bg-muted/50 text-muted-foreground border-border text-xs">—</Badge>;
  // Strip leading digits (e.g. "5R34DA..." -> "R34DA...") then extract mechanism code
  const stripped = value.replace(/^\d+/, "");
  const grantType = stripped.match(/^[A-Z]\d+/)?.[0] || stripped.substring(0, 3);
  const colorMap: Record<string, string> = {
    "R34": "bg-blue-500/20 text-blue-600 border-blue-500/30",
    "R61": "bg-purple-500/20 text-purple-600 border-purple-500/30",
    "U01": "bg-green-500/20 text-green-600 border-green-500/30",
    "U24": "bg-orange-500/20 text-orange-600 border-orange-500/30",
    "R24": "bg-pink-500/20 text-pink-600 border-pink-500/30",
    "5R3": "bg-blue-500/20 text-blue-600 border-blue-500/30",
    "1R3": "bg-cyan-500/20 text-cyan-600 border-cyan-500/30",
    "5R6": "bg-indigo-500/20 text-indigo-600 border-indigo-500/30",
  };
  const colorClass = colorMap[grantType] || "bg-muted/50 text-muted-foreground border-border";
  
  return (
    <Badge variant="outline" className={`${colorClass} text-xs`}>
      {grantType}
    </Badge>
  );
};

const fetchGrants = async (): Promise<ProjectRow[]> => {
  const { data, error } = await supabase.functions.invoke("nih-grants");
  
  if (error) {
    throw new Error(error.message || "Failed to fetch grants");
  }
  if (data?.error) {
    throw new Error(data.error);
  }

  const rawRows = Array.isArray(data?.data) ? data.data : [];

  return rawRows
    .map((row) => normalizeProjectRow(row as RawProjectRow))
    .filter((row): row is ProjectRow => row !== null);
};

const Projects = () => {
  const isMobile = useIsMobile();
  const [searchParams] = useSearchParams();
  const initialFilter = searchParams.get("q") || "";
  const [quickFilterText, setQuickFilterText] = useState(initialFilter);
  const [projectsTab, setProjectsTab] = useHashState<"table">("table", ["table"] as const);
  const [hoveredRow, setHoveredRow] = useState<ProjectRow | null>(null);
  const [hoverPosition, setHoverPosition] = useState({ x: 0, y: 0 });
  const navigate = useNavigate();
  const { toast } = useToast();
  const { isCurator } = useUserTier();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  // Fetch grants from server cache (data refreshed via cron/admin)
  const { data: rawRowData = [], isLoading: loading, refetch } = useQuery({
    queryKey: ["nih-grants"],
    queryFn: fetchGrants,
    staleTime: 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
  });

  // Species comes from the KNOWLEDGE GRAPH, never from a checked-in file (Constitution XI:
  // no shadow copies of KG data). This column previously read public/bbqs_marr.yaml, which
  // disagreed with projects.study_species on 25 of 30 projects and left 6 rows blank.
  const { data: speciesRows = [] } = useQuery({
    queryKey: ["project-species"],
    staleTime: 60 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("projects").select("id, grant_number, study_species");
      if (error) throw error;
      return (data ?? []) as { id: string; grant_number: string | null; study_species: string[] | string | null }[];
    },
  });

  // Provenance for the species column only (Constitution XI: a generated value must not look like a
  // verified one). RLS restricts this to admins/curators, so it comes back empty for the public and
  // the cell falls back to plain text — a marker nobody can explain is worse than no marker.
  const { data: speciesProv = [] } = useQuery({
    queryKey: ["species-provenance"],
    staleTime: 60 * 60 * 1000,
    retry: false,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("field_provenance_current")
        .select("entity_id, source_class, source_label, is_verified, agent_label, model_id")
        .eq("entity_table", "projects")
        .eq("entity_column", "study_species");
      if (error) throw error;
      return (data ?? []) as unknown as {
        entity_id: string; source_class: string; source_label: string;
        is_verified: boolean; agent_label: string | null; model_id: string | null;
      }[];
    },
  });

  const provByGrant = useMemo(() => {
    const idToGrant = new Map<string, string>();
    for (const r of speciesRows as any[]) {
      if (r.id && r.grant_number) idToGrant.set(r.id, coreGrantNumber(r.grant_number));
    }
    const m = new Map<string, (typeof speciesProv)[number]>();
    for (const p of speciesProv) {
      const g = idToGrant.get(p.entity_id);
      if (g) m.set(g, p);
    }
    return m;
  }, [speciesProv, speciesRows]);

  const speciesMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of speciesRows) {
      const key = coreGrantNumber(r.grant_number);
      if (!key) continue;
      const v = Array.isArray(r.study_species)
        ? r.study_species.filter(Boolean).join(", ")
        : (r.study_species ?? "");
      if (v.trim()) map.set(key, v.trim());
    }
    return map;
  }, [speciesRows]);

  const rowData = useMemo(() => rawRowData.map(row => ({
    ...row,
    // Both sides go through coreGrantNumber. The old lookup normalized only the ROW, so a
    // stored key that kept NIH's application-type prefix (1U01DA063565) never matched.
    species: speciesMap.get(coreGrantNumber(row.grantNumber)) || "",
    speciesProvenance: provByGrant.get(coreGrantNumber(row.grantNumber)),
  })), [rawRowData, speciesMap, provByGrant]);

  const filteredData = rowData;

  // Calculate metrics
  const totalFunding = useMemo(() => 
    rowData.reduce((sum, g) => sum + (g.awardAmount || 0), 0), 
    [rowData]
  );
  const totalPublications = useMemo(() => 
    rowData.reduce((sum, g) => sum + (g.publicationCount || 0), 0), 
    [rowData]
  );
  const uniqueInstitutions = useMemo(() => 
    new Set(rowData.map(g => g.institution)).size, 
    [rowData]
  );

  const defaultColDef = useMemo<ColDef>(() => ({
    sortable: true,
    resizable: true,
    suppressMovable: true,
    unSortIcon: true,
  }), []);

  const columnDefs = useMemo<ColDef<ProjectRow>[]>(() => [
    {
      field: "grantNumber",
      headerName: "Grant Type",
      width: 80,
      minWidth: 80,
      maxWidth: 80,
      cellRenderer: GrantTypeBadge,
      suppressSizeToFit: true,
    },
    {
      field: "title",
      headerName: "Title",
      flex: 1,
      minWidth: 250,
      cellRenderer: TitleCell,
      cellStyle: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    },
    {
      field: "allPis",
      headerName: "PIs",
      width: 220,
      minWidth: 180,
      wrapText: true,
      autoHeight: true,
      cellRenderer: PiCell,
      cellStyle: { whiteSpace: 'normal', wordBreak: 'break-word', overflow: 'hidden', lineHeight: '1.4', paddingTop: '6px', paddingBottom: '6px' },
      valueGetter: (params) => params.data?.allPis || params.data?.contactPi || '',
    },
    {
      field: "species",
      headerName: "Species",
      width: 130,
      minWidth: 110,
      cellRenderer: ({ value, data }: { value: string; data: ProjectRow }) => {
        if (!value) return <span className="text-muted-foreground">—</span>;
        const p = (data as any)?.speciesProvenance;
        // Verified values render plainly, per Principle XI. Only AI-assisted and unverified get a
        // mark, so the mark means something when you see it.
        const mark =
          !p ? null
          : p.source_class === "curated_with_ai"
            ? { cls: "text-violet-500", ch: "✦", tip: `Curated with AI${p.model_id ? ` (${p.model_id})` : ""}${p.agent_label ? ` — ${p.agent_label}` : ""}. Worth checking against the grant record.` }
          : !p.is_verified
            ? { cls: "text-amber-500", ch: "?", tip: "No recorded source — not human-verified." }
            : null;
        return (
          <span className="text-sm inline-flex items-center gap-1">
            {value}
            {mark && (
              <abbr title={mark.tip} className={`${mark.cls} no-underline cursor-help text-xs`}>
                {mark.ch}
              </abbr>
            )}
          </span>
        );
      },
    },
    {
      field: "institution",
      headerName: "Institution",
      width: 200,
      minWidth: 180,
      wrapText: true,
      autoHeight: true,
      cellRenderer: InstitutionCell,
      cellStyle: { whiteSpace: 'normal', wordBreak: 'break-word', overflow: 'hidden', lineHeight: '1.4', paddingTop: '6px', paddingBottom: '6px' },
    },
    {
      field: "publicationCount",
      headerName: "Pubs",
      width: 80,
      minWidth: 80,
      maxWidth: 80,
      suppressSizeToFit: true,
      cellRenderer: ({ value, data }: { value: number; data: ProjectRow }) => {
        if (!value) return <span className="text-muted-foreground">0</span>;
        return (
          <span
            className="text-primary hover:underline font-medium cursor-pointer"
            title={`View ${value} publication${value !== 1 ? 's' : ''} for this grant`}
            onClick={() => {
              window.location.href = `/publications?grant=${encodeURIComponent(data.grantNumber)}`;
            }}
          >
            {value}
          </span>
        );
      },
    },
    {
      field: "awardAmount",
      headerName: "Funding",
      width: 110,
      minWidth: 110,
      maxWidth: 110,
      cellRenderer: CurrencyCell,
      suppressSizeToFit: true,
    },
  ], []);

  const onCellMouseOver = useCallback((event: CellMouseOverEvent) => {
    if (event.data && event.event) {
      const mouseEvent = event.event as MouseEvent;
      setHoveredRow(event.data);
      setHoverPosition({ x: mouseEvent.clientX, y: mouseEvent.clientY });
    }
  }, []);

  const onCellMouseOut = useCallback(() => {
    setHoveredRow(null);
  }, []);

  const handleRefresh = useCallback(() => {
    refetch().then(() => {
      toast({
        title: "Data refreshed",
        description: `Loaded ${rowData.length} grants.`,
      });
    });
  }, [refetch, rowData.length, toast]);

  const exportToCSV = useCallback(async () => {
    if (rowData.length === 0) return;

    // When signed in, attempt to enrich with Contact PI emails. RLS on the
    // `investigators` table will only return rows the viewer is allowed to
    // see (curators/admins see all; collaborators see grant-mates; others
    // see only their own). Missing emails are left blank.
    const emailByNormalizedName = new Map<string, string>();
    if (user) {
      // Pull all investigator rows the viewer is allowed to see (RLS-gated).
      // We must NOT filter out rows whose primary `email` is null — many PIs
      // only have a secondary email recorded.
      const { data: invs } = await supabase
        .from("investigators")
        .select("name, email, secondary_emails");
      for (const inv of invs || []) {
        const rawKey = normalizePiName(inv.name || "").toLowerCase().replace(/\s+/g, " ").trim();
        if (!rawKey) continue;
        const primary = (inv.email || "").trim();
        const secondary = Array.isArray(inv.secondary_emails)
          ? inv.secondary_emails.filter(Boolean).join("; ")
          : "";
        const combined = [primary, secondary].filter(Boolean).join("; ");
        if (!combined) continue;
        // Prefer a row that has a primary email over one with only secondaries.
        const existing = emailByNormalizedName.get(rawKey);
        if (!existing || (!existing.includes("@") && combined.includes("@")) || (primary && !existing.split(";")[0].trim().includes("@"))) {
          emailByNormalizedName.set(rawKey, combined);
        }
      }
    }

    const includeEmail = !!user;
    const grantHeaders = [
      "Grant Number",
      "Title",
      "Contact PI",
      ...(includeEmail ? ["Contact PI Email"] : []),
      "All PIs",
      "Institution",
      "Fiscal Year",
      "Award Amount",
      "Publications",
      "NIH Link",
    ];
    const grantRows = rowData.map(row => {
      const piKey = normalizePiName(row.contactPi || "").toLowerCase().replace(/\s+/g, " ").trim();
      const email = includeEmail ? (emailByNormalizedName.get(piKey) || "") : null;
      return [
        row.grantNumber,
        row.title,
        row.contactPi,
        ...(includeEmail ? [email ?? ""] : []),
        row.allPis,
        row.institution,
        row.fiscalYear.toString(),
        row.awardAmount.toString(),
        row.publicationCount.toString(),
        row.nihLink,
      ];
    });

    const grantCSV = [
      grantHeaders.join(","),
      ...grantRows.map(row => row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(","))
    ].join("\n");

    const pubHeaders = ["Grant Number", "PMID", "Title", "Authors", "Year", "Journal", "Citations", "RCR", "PubMed Link"];
    const pubRows = rowData.flatMap(grant => 
      grant.publications.map(pub => [
        grant.grantNumber,
        pub.pmid,
        pub.title,
        formatAuthors(pub.authors),
        pub.year.toString(),
        pub.journal,
        pub.citations.toString(),
        pub.rcr.toString(),
        pub.pubmedLink
      ])
    );

    const pubCSV = [
      pubHeaders.join(","),
      ...pubRows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    ].join("\n");

    const downloadCSV = (content: string, filename: string) => {
      const blob = new Blob([content], { type: "text/csv" });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      window.URL.revokeObjectURL(url);
    };

    downloadCSV(grantCSV, "bbqs_grants.csv");
    downloadCSV(pubCSV, "bbqs_publications.csv");

    toast({
      title: "Export complete",
      description: includeEmail
        ? `Exported ${rowData.length} grants (with PI emails where available) and ${pubRows.length} publications.`
        : `Exported ${rowData.length} grants and ${pubRows.length} publications. Sign in to include PI emails.`,
    });
  }, [rowData, toast, user]);

  const exportToYAML = useCallback(() => {
    if (rowData.length === 0) return;

    const escapeYaml = (val: string | number | null | undefined): string => {
      if (val === null || val === undefined) return '""';
      const s = String(val);
      if (s === '') return '""';
      if (/[:#\[\]{}&*!|>'"%@`,?]/.test(s) || s.includes('\n') || s.startsWith(' ') || s.endsWith(' ')) {
        return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
      }
      return s;
    };

    const lines: string[] = ['# BBQS Consortium Projects Export', `# Generated: ${new Date().toISOString()}`, '', 'projects:'];

    for (const row of rowData) {
      lines.push(`  - grant_number: ${escapeYaml(row.grantNumber)}`);
      lines.push(`    title: ${escapeYaml(row.title)}`);
      lines.push(`    contact_pi: ${escapeYaml(row.contactPi)}`);
      lines.push(`    all_pis: ${escapeYaml(row.allPis)}`);
      lines.push(`    institution: ${escapeYaml(row.institution)}`);
      lines.push(`    fiscal_year: ${row.fiscalYear || ''}`);
      lines.push(`    award_amount: ${row.awardAmount || 0}`);
      lines.push(`    nih_link: ${escapeYaml(row.nihLink)}`);
      lines.push(`    publication_count: ${row.publicationCount || 0}`);
      if (row.publications && row.publications.length > 0) {
        lines.push(`    publications:`);
        for (const pub of row.publications) {
          lines.push(`      - pmid: ${escapeYaml(pub.pmid)}`);
          lines.push(`        title: ${escapeYaml(pub.title)}`);
          lines.push(`        authors: ${escapeYaml(formatAuthors(pub.authors))}`);
          lines.push(`        year: ${pub.year || ''}`);
          lines.push(`        journal: ${escapeYaml(pub.journal)}`);
          lines.push(`        citations: ${pub.citations || 0}`);
          lines.push(`        rcr: ${pub.rcr || 0}`);
          lines.push(`        pubmed_link: ${escapeYaml(pub.pubmedLink)}`);
        }
      } else {
        lines.push(`    publications: []`);
      }
    }

    const yaml = lines.join('\n');
    const blob = new Blob([yaml], { type: 'text/yaml' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bbqs_projects.yaml';
    a.click();
    window.URL.revokeObjectURL(url);

    toast({
      title: 'YAML exported',
      description: `Exported ${rowData.length} projects with publications.`,
    });
  }, [rowData, toast]);

  return (
    <div className="min-h-screen bg-background">
      <PageMeta title="Projects" description="Browse all BBQS consortium research projects — NIH grants, principal investigators, species, and Marr-level computational features." />
      <div className="px-6 py-8">
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-foreground mb-2">Projects</h1>
          <p className="text-muted-foreground mb-6">
            NIH-funded Brain Behavior Quantification and Synchronization grants.
          </p>

          {/* Metrics Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            <Card className="bg-card border-border">
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-emerald-500/10">
                    <DollarSign className="h-5 w-5 text-emerald-600" />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">Total Funding</p>
                    <p className="text-xl font-bold text-foreground">
                      ${(totalFunding / 1000000).toFixed(1)}M
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card
              className="bg-card border-border cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => document.getElementById('grants-grid')?.scrollIntoView({ behavior: 'smooth' })}
            >
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-blue-500/10">
                    <FolderOpen className="h-5 w-5 text-blue-600" />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">Projects</p>
                    <p className="text-xl font-bold text-foreground">{rowData.length}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card
              className="bg-card border-border cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => navigate('/publications')}
            >
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-purple-500/10">
                    <FileText className="h-5 w-5 text-purple-600" />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">Publications</p>
                    <p className="text-xl font-bold text-foreground">{totalPublications}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card
              className="bg-card border-border cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => navigate('/investigators')}
            >
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-orange-500/10">
                    <Users className="h-5 w-5 text-orange-600" />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">Institutions</p>
                    <p className="text-xl font-bold text-foreground">{uniqueInstitutions}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
          
          <div className="flex flex-wrap items-center gap-4 mb-4">
            <Input
              type="text"
              placeholder="Quick filter..."
              value={quickFilterText}
              onChange={(e) => setQuickFilterText(e.target.value)}
              className="max-w-md"
            />

            
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              disabled={loading}
            >
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Loading...
                </>
              ) : (
                <>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Refresh
                </>
              )}
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={exportToCSV}
              disabled={rowData.length === 0}
            >
              <Download className="mr-2 h-4 w-4" />
              CSV
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={exportToYAML}
              disabled={rowData.length === 0}
            >
              <FileDown className="mr-2 h-4 w-4" />
              YAML
            </Button>

            {isCurator && (
              <AddProjectByGrantDialog
                onAdded={() => queryClient.invalidateQueries({ queryKey: ["projects"] })}
              />
            )}
          </div>
        </div>

        <Tabs value={projectsTab} onValueChange={(v) => setProjectsTab(v as "table")} className="w-full">
          <TabsList className="mb-4">
            <TabsTrigger value="table" className="gap-1.5">
              <FolderOpen className="h-4 w-4" />
              Table
            </TabsTrigger>
            {/* Explorer tab hidden until feature is ready */}
          </TabsList>

          <TabsContent value="table">
            {isMobile ? (
              <MobileCardList
                items={filteredData
                  .filter((r) => !quickFilterText || r.title.toLowerCase().includes(quickFilterText.toLowerCase()) || r.contactPi.toLowerCase().includes(quickFilterText.toLowerCase()))
                  .map((r) => ({
                    id: r.grantNumber,
                    title: r.title,
                    titleHref: r.nihLink,
                    fields: [
                      { label: "Grant", value: r.grantNumber },
                      { label: "PI", value: r.contactPi },
                      { label: "Institution", value: r.institution },
                      { label: "Year", value: String(r.fiscalYear) },
                      { label: "Award", value: r.awardAmount ? `$${(r.awardAmount / 1000).toFixed(0)}K` : "—" },
                      { label: "Pubs", value: String(r.publicationCount) },
                    ],
                  }))}
                emptyMessage="No projects found"
              />
            ) : (
              <div className="ag-grid-mobile-wrapper">
              <div
                id="grants-grid"
                className="ag-theme-alpine rounded-lg border border-border overflow-hidden"
              >
                <AgGridReact<ProjectRow>
                  rowData={filteredData}
                  columnDefs={columnDefs}
                  defaultColDef={defaultColDef}
                  quickFilterText={quickFilterText}
                  onCellMouseOver={onCellMouseOver}
                  onCellMouseOut={onCellMouseOut}
                  animateRows={true}
                  suppressCellFocus={true}
                  enableCellTextSelection={true}
                  domLayout="autoHeight"
                  
                  headerHeight={40}
                  loading={loading}
                  loadingOverlayComponent={() => (
                    <div className="flex flex-col items-center gap-3 text-muted-foreground py-12">
                      <Loader2 className="h-8 w-8 animate-spin text-primary" />
                      <span>Loading...</span>
                    </div>
                  )}
                  noRowsOverlayComponent={() => (
                    <div className="flex flex-col items-center gap-3 text-muted-foreground py-12">
                      <Loader2 className="h-8 w-8 animate-spin text-primary" />
                      <span>Fetching projects...</span>
                    </div>
                  )}
                />
              </div>
              </div>
            )}
            <FundingCharts data={rowData} />
          </TabsContent>

          <TabsContent value="explorer">
            <Card className="border-border">
              <CardContent className="p-6">
                <h2 className="text-lg font-semibold text-foreground mb-1">Species × Marr Level Explorer</h2>
                <p className="text-sm text-muted-foreground mb-4">
                  Heatmap showing shared computational goals, algorithmic methods, and implementation resources across species studied by BBQS projects.
                </p>
                <SpeciesHeatmap />
              </CardContent>
            </Card>
          </TabsContent>

        </Tabs>

        {/* Hover Detail Card */}
        {hoveredRow && (
          <div
            className="fixed z-[9999] bg-card border border-border rounded-lg shadow-xl p-4 max-w-md pointer-events-none"
            style={{
              left: Math.min(hoverPosition.x + 15, window.innerWidth - 420),
              top: Math.min(hoverPosition.y + 10, window.innerHeight - 320),
            }}
          >
            <div className="flex items-start gap-2 mb-3">
              <a
                href={hoveredRow.nihLink}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-primary hover:underline line-clamp-2 pointer-events-auto"
              >
                {hoveredRow.title}
                <ExternalLink className="inline h-3 w-3 ml-1 opacity-60" />
              </a>
            </div>
            <div className="space-y-2 text-sm">
              <div>
                <span className="text-muted-foreground">Grant: </span>
                <span className="text-foreground font-mono">{hoveredRow.grantNumber}</span>
              </div>
              <div>
                <span className="text-muted-foreground">All PIs: </span>
                <span className="text-foreground">
                  {(hoveredRow.allPis || hoveredRow.contactPi)
                    ?.split(/[,;]/)
                    .map((n: string) => normalizePiName(n.trim()))
                    .join(", ")}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">Fiscal Year: </span>
                <span className="text-foreground">{hoveredRow.fiscalYear}</span>
              </div>
              <div className="flex items-center gap-1">
                <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-muted-foreground">Publications: </span>
                <span className={hoveredRow.publicationCount > 0 ? "text-primary font-medium" : "text-muted-foreground"}>
                  {hoveredRow.publicationCount}
                </span>
              </div>
              {hoveredRow.publications.length > 0 && (
                <div className="mt-3 pt-3 border-t border-border">
                  <span className="text-muted-foreground text-xs uppercase tracking-wide">Recent Papers:</span>
                  <ul className="mt-2 space-y-1">
                    {hoveredRow.publications.slice(0, 3).map((pub, i) => (
                      <li key={i} className="text-xs text-foreground/80 line-clamp-1">
                        • {pub.title}
                      </li>
                    ))}
                    {hoveredRow.publications.length > 3 && (
                      <li className="text-xs text-muted-foreground">
                        +{hoveredRow.publications.length - 3} more...
                      </li>
                    )}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Projects;
