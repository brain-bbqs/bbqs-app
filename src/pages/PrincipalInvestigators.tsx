"use client";

import { useSearchParams } from "react-router-dom";

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useIsMobile } from "@/hooks/use-mobile";
import { MobileCardList } from "@/components/MobileCardList";
import { AgGridReact } from "ag-grid-react";
import type { ColDef } from "ag-grid-community";
import { useQuery } from "@tanstack/react-query";
import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-alpine.css";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, Users, ExternalLink, Columns3, Filter } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { normalizePiName, piProfileUrl, institutionUrl } from "@/lib/pi-utils";
import { MARR_PROJECTS } from "@/data/marr-projects";
// Note: PrincipalInvestigators still uses static MARR_PROJECTS as fallback
// since the data is used inside a non-hook async function.
import { useEntitySummary } from "@/contexts/EntitySummaryContext";

import "@/styles/ag-grid-theme.css";

interface CoPiInfo {
  name: string;
  profileId: number | null;
  isContactPi: boolean;
}

interface GrantInfo {
  grantNumber: string;
  title: string;
  nihLink: string;
  role: string;
  awardAmount: number;
  institution: string;
  fiscalYear: number | null;
  isBbqs: boolean;
  coPis: CoPiInfo[];
}

interface OrgInfo {
  id: string;
  name: string;
  resourceId?: string;
}

interface PIRow {
  id: string;
  name: string;
  displayName: string;
  firstName: string;
  lastName: string;
  profileId: number | null;
  projectsAsPi: number;
  projectsAsCoPi: number;
  totalProjects: number;
  totalFunding: number;
  institutions: string[];
  orgs: OrgInfo[];
  grants: GrantInfo[];
  skills: string[];
  researchAreas: string[];
  resourceId?: string;
  workingGroups: string[];
}

const nameKey = (name: string): string =>
  name.replace(/[,.\\-]/g, " ").split(/\s+/).map((s) => s.toLowerCase().trim()).filter(Boolean).sort().join(" ");

const extractGrantType = (grantNumber: string): string => {
  const match = grantNumber?.match(/([A-Z]\d{2})/);
  return match?.[1] || "";
};

const openNihReporterProfile = async (pi: PIRow) => {
  try {
    const body = pi.profileId
      ? { pi_profile_id: pi.profileId }
      : { first_name: pi.firstName, last_name: pi.lastName };

    const { data, error } = await supabase.functions.invoke("nih-reporter-search", { body });
    if (!error && data?.url) {
      window.open(data.url, "_blank");
      return;
    }
  } catch {
    // fallback
  }
  window.open(piProfileUrl(pi.displayName), "_blank");
};

/* ── Name + Institution cell (merged) ── */
const NameCell = ({ data }: { data: PIRow }) => {
  const { open } = useEntitySummary();
  return (
    <div className="flex items-center gap-1.5 py-1">
      <Users className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <button
        onClick={() => open({ type: "investigator", id: data.id, resourceId: data.resourceId, label: data.displayName })}
        className="font-medium text-primary hover:text-primary/80 hover:underline transition-colors text-left text-sm leading-tight"
        title={`View summary for ${data.displayName}`}
      >
        {data.displayName}
      </button>
    </div>
  );
};

/* ── Projects cell ── */
const ProjectsCell = ({ data }: { data: PIRow }) => {
  // Collect unique co-PIs across all grants for this investigator
  const coPiGrants = data.grants.filter(g => g.role !== "contact_pi");
  const piGrants = data.grants.filter(g => g.role === "contact_pi");

  // For co-PI grants, the "other investigators" are the contact PIs
  const coPiDetails = coPiGrants.map(g => ({
    grantNumber: g.grantNumber,
    title: g.title,
    contactPis: g.coPis.filter(c => c.isContactPi),
  }));

  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>
        <span className="text-foreground cursor-help">
          <span className="font-semibold">{data.totalProjects}</span>
          <span className="text-muted-foreground ml-1 text-xs">
            ({data.projectsAsPi} PI / {data.projectsAsCoPi} Co-PI)
          </span>
        </span>
      </HoverCardTrigger>
      <HoverCardContent side="bottom" align="start" className="w-80 p-4">
        <p className="font-semibold text-sm mb-2">{data.displayName}</p>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="bg-muted/50 rounded p-2">
            <p className="text-muted-foreground">As PI</p>
            <p className="font-bold text-foreground text-base">{data.projectsAsPi}</p>
          </div>
          <div className="bg-muted/50 rounded p-2">
            <p className="text-muted-foreground">As Co-PI</p>
            <p className="font-bold text-foreground text-base">{data.projectsAsCoPi}</p>
          </div>
          <div className="bg-emerald-500/10 rounded p-2">
            <p className="text-muted-foreground">BBQS</p>
            <p className="font-bold text-emerald-600 text-base">{data.grants.filter(g => g.isBbqs).length}</p>
          </div>
          <div className="bg-muted/50 rounded p-2">
            <p className="text-muted-foreground">Other</p>
            <p className="font-bold text-foreground text-base">{data.grants.filter(g => !g.isBbqs).length}</p>
          </div>
        </div>
        {data.totalFunding > 0 && (
          <p className="text-xs font-mono text-emerald-600 font-semibold mt-2">
            Total: ${data.totalFunding.toLocaleString()}
          </p>
        )}
        {coPiDetails.length > 0 && (
          <div className="border-t border-border pt-2 mt-3">
            <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-1.5">Co-PI on grants with</p>
            <div className="flex flex-col gap-1.5 max-h-40 overflow-y-auto">
              {coPiDetails.map((g, i) => (
                <div key={i} className="text-xs">
                  <p className="text-muted-foreground truncate">{g.title.length > 60 ? g.title.slice(0, 60) + "…" : g.title}</p>
                  <div className="flex flex-wrap gap-1 mt-0.5">
                    {g.contactPis.map((pi, j) => (
                      <Badge key={j} variant="outline" className="text-[10px] bg-primary/10 text-primary border-primary/30">
                        {pi.name}
                      </Badge>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </HoverCardContent>
    </HoverCard>
  );
};

/* ── Funding cell ── */
const FundingCell = ({ value }: { value: number }) => {
  if (!value || isNaN(value)) return <span className="text-muted-foreground">—</span>;
  return <span className="font-mono text-emerald-600 font-semibold">${value.toLocaleString()}</span>;
};

/* ── Grants cell ── */
const GrantsCell = ({ data }: { data: PIRow }) => {
  if (!data?.grants || data.grants.length === 0) return <span className="text-muted-foreground">—</span>;

  const sorted = [...data.grants].sort((a, b) => {
    if (a.isBbqs !== b.isBbqs) return a.isBbqs ? -1 : 1;
    return (b.awardAmount || 0) - (a.awardAmount || 0);
  });

  const shown = sorted.slice(0, 6);
  const remaining = sorted.length - 6;

  return (
    <div className="flex flex-wrap gap-1.5 py-1">
      {shown.map((g, idx) => (
        <HoverCard key={`${g.grantNumber}-${idx}`} openDelay={200} closeDelay={100}>
          <HoverCardTrigger asChild>
            <Badge
              variant="outline"
              className={`text-xs cursor-help hover:bg-primary/20 transition-colors ${
                g.isBbqs
                  ? "bg-emerald-500/15 text-emerald-700 border-emerald-500/40 font-semibold dark:text-emerald-400"
                  : "bg-muted text-muted-foreground border-border"
              }`}
            >
              {extractGrantType(g.grantNumber) || g.grantNumber.slice(0, 6)}
              <ExternalLink className="h-2.5 w-2.5 ml-0.5" />
            </Badge>
          </HoverCardTrigger>
          <HoverCardContent side="bottom" align="start" className="w-80 p-4">
            <p className="font-semibold text-sm mb-1.5 leading-snug">{g.title}</p>
            <p className="text-xs text-muted-foreground mb-1">
              {g.grantNumber} · {g.institution}
            </p>
            {g.awardAmount > 0 && (
              <p className="text-xs font-mono text-emerald-600 font-semibold mb-2">
                ${g.awardAmount.toLocaleString()}
              </p>
            )}
            <a
              href={g.nihLink || `https://reporter.nih.gov/project-details/${encodeURIComponent(g.grantNumber)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-primary hover:underline flex items-center gap-1 mb-2"
            >
              View on NIH Reporter <ExternalLink className="h-3 w-3" />
            </a>
            {g.coPis && g.coPis.length > 0 && (
              <div className="border-t border-border pt-2 mt-1">
                <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-1.5">Investigators</p>
                <div className="flex flex-wrap gap-1">
                  {g.coPis.map((copi, i) => (
                    <Badge
                      key={i}
                      variant="outline"
                      className={`text-[11px] ${copi.profileId ? 'cursor-pointer hover:bg-primary/15' : ''} transition-colors ${
                        copi.isContactPi
                          ? "bg-primary/10 text-primary border-primary/30 font-medium"
                          : "bg-muted/50 text-muted-foreground border-border"
                      }`}
                      onClick={copi.profileId ? (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        supabase.functions.invoke("nih-reporter-search", {
                          body: { pi_profile_id: copi.profileId },
                        }).then(({ data }) => {
                          if (data?.url) window.open(data.url, "_blank");
                        });
                      } : undefined}
                    >
                      {copi.name}
                      {copi.isContactPi && <span className="ml-0.5 opacity-60">(PI)</span>}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
            {g.isBbqs && (
              <Badge variant="outline" className="text-[10px] bg-emerald-500/10 text-emerald-700 border-emerald-500/30 mt-2 dark:text-emerald-400">
                BBQS Grant
              </Badge>
            )}
          </HoverCardContent>
        </HoverCard>
      ))}
      {remaining > 0 && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-muted-foreground text-xs cursor-help self-center">+{remaining}</span>
            </TooltipTrigger>
            <TooltipContent>
              <p className="text-xs max-w-xs">
                {sorted.slice(6).map(g => extractGrantType(g.grantNumber) || g.grantNumber).join(", ")}
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );
};

/* ── Skills cell ── */
const SkillsCell = ({ data }: { data: PIRow }) => {
  if (!data?.skills || data.skills.length === 0) return <span className="text-muted-foreground">—</span>;
  const shown = data.skills.slice(0, 3);
  const remaining = data.skills.length - shown.length;

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-wrap gap-1 py-1">
        {shown.map((skill, i) => (
          <Badge key={i} variant="outline" className="text-[10px] px-1.5 py-0 font-normal bg-amber-500/10 text-amber-700 border-amber-500/30 dark:text-amber-400">
            {skill}
          </Badge>
        ))}
        {remaining > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-normal text-muted-foreground cursor-pointer">+{remaining}</Badge>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs">
              <div className="flex flex-wrap gap-1">
                {data.skills.slice(3).map((s, i) => (
                  <span key={i} className="text-xs">{s}{i < data.skills.length - 4 ? "," : ""}</span>
                ))}
              </div>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </TooltipProvider>
  );
};

/* ── Research Areas cell ── */
const ResearchAreasCell = ({ data }: { data: PIRow }) => {
  if (!data?.researchAreas || data.researchAreas.length === 0) return <span className="text-muted-foreground">—</span>;
  const shown = data.researchAreas.slice(0, 3);
  const remaining = data.researchAreas.length - shown.length;

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-wrap gap-1 py-1">
        {shown.map((area, i) => (
          <Badge key={i} variant="outline" className="text-[10px] px-1.5 py-0 font-normal bg-primary/10 text-primary border-primary/30">
            {area}
          </Badge>
        ))}
        {remaining > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-normal text-muted-foreground cursor-pointer">+{remaining}</Badge>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs">
              <div className="flex flex-wrap gap-1">
                {data.researchAreas.slice(3).map((a, i) => (
                  <span key={i} className="text-xs">{a}{i < data.researchAreas.length - 4 ? "," : ""}</span>
                ))}
              </div>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </TooltipProvider>
  );
};

/* ── Data fetching ── */
const fetchPIs = async (): Promise<PIRow[]> => {
  const [invResult, grantsResult, giResult, ioResult, orgResult] = await Promise.all([
    supabase.from("investigators_public" as any).select("*"),
    supabase.from("grants").select("*"),
    supabase.from("grant_investigators").select("*"),
    supabase.from("investigator_organizations").select("investigator_id, organization_id"),
    supabase.from("organizations").select("*"),
  ]);

  if (invResult.error) throw new Error(invResult.error.message);

  const investigators = (invResult.data || []) as any[];
  const grants = grantsResult.data || [];
  const grantInvLinks = giResult.data || [];
  const invOrgLinks = ioResult.data || [];
  const orgs = orgResult.data || [];

  const grantById = new Map(grants.map(g => [g.id, g]));
  const orgById = new Map(orgs.map(o => [o.id, o]));
  const bbqsGrantNumbers = new Set(MARR_PROJECTS.map(p => p.id));

  const piMap = new Map<string, PIRow>();

  for (const inv of investigators) {
    const key = nameKey(inv.name);
    const displayName = normalizePiName(inv.name);
    const nameParts = displayName.split(/\s+/);
    const profileId = inv.profile_url?.match(/pi_id=(\d+)/)?.[1] ? Number(inv.profile_url.match(/pi_id=(\d+)/)![1]) : null;

    const piGrantLinks = grantInvLinks.filter(gi => gi.investigator_id === inv.id);
    const wgs: string[] = (inv as any).working_groups || [];

    // Include investigators who have grants, working groups, or went through onboarding. The
    // roster is RePORTER-derived, so onboarded trainees/staff with no grant picked were invisible
    // here (Jared Reiling, 2026-10-08). `onboarded` comes from 20261008120000; until that is
    // applied it is undefined and this falls back to grants-or-working-groups.
    if (piGrantLinks.length === 0 && wgs.length === 0 && inv.onboarded !== true) continue;

    let piAsPi = 0;
    let piAsCoPi = 0;
    const piGrants: GrantInfo[] = [];
    const institutions = new Set<string>();
    const orgInfos: OrgInfo[] = [];

    for (const link of piGrantLinks) {
      const grant = grantById.get(link.grant_id);
      if (!grant) continue;

      const isContact = link.role === "contact_pi";
      if (isContact) piAsPi++;
      else piAsCoPi++;

      const coreNum = grant.grant_number.replace(/^\d+/, "").replace(/-\d+$/, "");
      const isBbqs = bbqsGrantNumbers.has(grant.grant_number) || bbqsGrantNumbers.has(coreNum) ||
        [...bbqsGrantNumbers].some(bn => grant.grant_number.includes(bn) || bn.includes(coreNum));

      const coPiLinks = grantInvLinks.filter(gi => gi.grant_id === link.grant_id && gi.investigator_id !== inv.id);
      const coPis: CoPiInfo[] = coPiLinks.map(coLink => {
        const coInv = investigators.find(i => i.id === coLink.investigator_id);
        const coProfileId = coInv?.profile_url?.match(/pi_id=(\d+)/)?.[1] ? Number(coInv.profile_url.match(/pi_id=(\d+)/)![1]) : null;
        return {
          name: coInv ? normalizePiName(coInv.name) : "Unknown",
          profileId: coProfileId,
          isContactPi: coLink.role === "contact_pi",
        };
      });

      piGrants.push({
        grantNumber: grant.grant_number,
        title: grant.title,
        nihLink: grant.nih_link || `https://reporter.nih.gov/project-details/${encodeURIComponent(grant.grant_number)}`,
        role: link.role,
        awardAmount: Number(grant.award_amount) || 0,
        institution: "",
        fiscalYear: grant.fiscal_year || null,
        isBbqs,
        coPis,
      });
    }

    const orgLinks = invOrgLinks.filter(io => io.investigator_id === inv.id);
    for (const ol of orgLinks) {
      const org = orgById.get(ol.organization_id);
      if (org) {
        institutions.add(org.name);
        orgInfos.push({ id: org.id, name: org.name, resourceId: org.resource_id || undefined });
        piGrants.forEach(g => { if (!g.institution) g.institution = org.name; });
      }
    }

    const totalFunding = piGrants.reduce((sum, g) => sum + (g.awardAmount || 0), 0);

    piMap.set(key, {
      id: inv.id,
      name: inv.name,
      displayName,
      firstName: nameParts[0] || "",
      lastName: nameParts[nameParts.length - 1] || "",
      profileId,
      projectsAsPi: piAsPi,
      projectsAsCoPi: piAsCoPi,
      totalProjects: piGrantLinks.length,
      totalFunding,
      institutions: Array.from(institutions),
      orgs: orgInfos,
      grants: piGrants,
      skills: inv.skills || [],
      researchAreas: inv.research_areas || [],
      resourceId: inv.resource_id || undefined,
      workingGroups: wgs,
    });
  }

  // Enrich with MARR_PROJECTS data for PIs without skills/research_areas
  for (const [, pi] of piMap) {
    if (pi.skills.length > 0 || pi.researchAreas.length > 0) continue;
    const piKey = nameKey(pi.displayName);
    const piGrantNumbers = new Set(pi.grants.map(g => g.grantNumber));
    const matchingProjects = MARR_PROJECTS.filter(p =>
      nameKey(p.pi) === piKey || piGrantNumbers.has(p.id)
    );
    const skills = new Set<string>();
    const areas = new Set<string>();
    matchingProjects.forEach(p => {
      p.algorithmic.forEach(s => skills.add(s));
      p.computational.forEach(a => areas.add(a));
    });
    pi.skills = Array.from(skills);
    pi.researchAreas = Array.from(areas);
  }

  return Array.from(piMap.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
};

/* ── Institution cell ── */
const InstitutionCell = ({ data }: { data: PIRow }) => {
  const { open } = useEntitySummary();
  if (!data?.orgs || data.orgs.length === 0) return <span className="text-muted-foreground">—</span>;
  const primary = data.orgs[0];
  const remaining = data.orgs.length - 1;

  // Derive logo from institution name for common patterns
  const getLogoDomain = (name: string) => {
    const lower = name.toLowerCase();
    if (lower.includes("mit") || lower.includes("massachusetts institute")) return "mit.edu";
    if (lower.includes("harvard")) return "harvard.edu";
    if (lower.includes("stanford")) return "stanford.edu";
    if (lower.includes("columbia")) return "columbia.edu";
    if (lower.includes("johns hopkins")) return "jhu.edu";
    if (lower.includes("caltech")) return "caltech.edu";
    if (lower.includes("carnegie mellon")) return "cmu.edu";
    if (lower.includes("boston")) return "bu.edu";
    if (lower.includes("northwestern")) return "northwestern.edu";
    if (lower.includes("georgia")) return "gatech.edu";
    if (lower.includes("princeton")) return "princeton.edu";
    if (lower.includes("yale")) return "yale.edu";
    if (lower.includes("cornell")) return "cornell.edu";
    if (lower.includes("duke")) return "duke.edu";
    if (lower.includes("upenn") || lower.includes("university of pennsylvania")) return "upenn.edu";
    if (lower.includes("uc berkeley") || lower.includes("berkeley")) return "berkeley.edu";
    if (lower.includes("ucla")) return "ucla.edu";
    if (lower.includes("ucsd") || lower.includes("san diego")) return "ucsd.edu";
    if (lower.includes("ucsf") || lower.includes("san francisco")) return "ucsf.edu";
    if (lower.includes("uc davis")) return "ucdavis.edu";
    if (lower.includes("michigan")) return "umich.edu";
    if (lower.includes("washington") && lower.includes("university")) return "uw.edu";
    if (lower.includes("nyu") || lower.includes("new york university")) return "nyu.edu";
    if (lower.includes("emory")) return "emory.edu";
    if (lower.includes("allen institute")) return "alleninstitute.org";
    if (lower.includes("rockefeller")) return "rockefeller.edu";
    if (lower.includes("salk")) return "salk.edu";
    if (lower.includes("janelia")) return "janelia.org";
    return null;
  };

  const logoDomain = getLogoDomain(primary.name);
  const logoUrl = logoDomain ? `https://logo.clearbit.com/${logoDomain}` : null;

  return (
    <div className="flex items-center gap-1.5 py-1 overflow-hidden w-full">
      {logoUrl && (
        <img
          src={logoUrl}
          alt=""
          className="w-4 h-4 rounded-sm object-contain shrink-0"
          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
        />
      )}
      <button
        onClick={() => open({ type: "organization", id: primary.id, resourceId: primary.resourceId, label: primary.name })}
        className="text-xs text-primary hover:underline truncate block text-left cursor-pointer"
      >
        {primary.name}
      </button>
      {remaining > 0 && (
        <HoverCard openDelay={150} closeDelay={100}>
          <HoverCardTrigger asChild>
            <span className="text-[10px] text-muted-foreground shrink-0 cursor-help">+{remaining}</span>
          </HoverCardTrigger>
          <HoverCardContent side="bottom" align="start" className="w-80 p-3">
            <p className="text-[11px] text-muted-foreground uppercase tracking-wide mb-2">
              All Institutions ({data.orgs.length})
            </p>
            <div className="flex flex-col gap-1.5">
              {data.orgs.map((org) => {
                const orgLogoDomain = getLogoDomain(org.name);
                const orgLogoUrl = orgLogoDomain ? `https://logo.clearbit.com/${orgLogoDomain}` : null;
                return (
                  <button
                    key={org.id}
                    onClick={() => open({ type: "organization", id: org.id, resourceId: org.resourceId, label: org.name })}
                    className="flex items-center gap-1.5 text-xs text-primary hover:underline text-left"
                  >
                    {orgLogoUrl && (
                      <img src={orgLogoUrl} alt="" className="w-4 h-4 rounded-sm object-contain shrink-0"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                    )}
                    {org.name}
                  </button>
                );
              })}
            </div>
          </HoverCardContent>
        </HoverCard>
      )}
    </div>
  );
};

const ALL_COLUMNS = [
  { id: "investigator" as const, label: "Investigator", default: true, locked: true },
  { id: "institution" as const, label: "Institutions", default: true },
  { id: "workingGroups" as const, label: "Working Groups", default: true },
  { id: "skills" as const, label: "Skills", default: true },
  { id: "researchAreas" as const, label: "Research Areas", default: true },
  { id: "projects" as const, label: "Projects", default: false },
  { id: "funding" as const, label: "Funding", default: false },
  { id: "grants" as const, label: "Grants", default: false },
];

type ColumnId = "investigator" | "institution" | "workingGroups" | "projects" | "grants" | "funding" | "skills" | "researchAreas";

type RoleFilter = "all" | "pi";
type WgFilter = "all" | "WG-Analytics" | "WG-Devices" | "WG-ELSI" | "WG-Standards";

const ROLE_FILTERS: { id: RoleFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "pi", label: "PIs" },
];

const WG_FILTERS: { id: WgFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "WG-Analytics", label: "Analytics" },
  { id: "WG-Devices", label: "Devices" },
  { id: "WG-ELSI", label: "ELSI" },
  { id: "WG-Standards", label: "Standards" },
];

// wgChairNames removed — using isWorkingGroupChair() instead

/* ── Main component ── */
export default function PrincipalInvestigators() {
  const [searchParams] = useSearchParams();
  const [quickFilterText, setQuickFilterText] = useState(searchParams.get("q") || "");
  const qParam = useMemo(() => searchParams.get("q"), []); // stable: read once on mount
  const [roleFilter, setRoleFilter] = useState<RoleFilter>("all");
  const [wgFilter, setWgFilter] = useState<WgFilter>("all");
  const [visibleColumns, setVisibleColumns] = useState<Set<ColumnId>>(
    () => new Set(ALL_COLUMNS.filter(c => c.default).map(c => c.id))
  );

  const { open } = useEntitySummary();
  const { data: rawRowData = [], isLoading } = useQuery({
    queryKey: ["principal-investigators"],
    queryFn: fetchPIs,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });

  // Auto-open entity summary when page is opened via a ?q=Name deep link
  // (e.g. from an agent investigator chip). Fires once after data loads.
  const autoOpenFired = useRef(false);
  useEffect(() => {
    if (!qParam || rawRowData.length === 0 || autoOpenFired.current) return;
    autoOpenFired.current = true;
    const qNorm = nameKey(qParam);
    const match = rawRowData.find(
      (pi) =>
        nameKey(pi.displayName).includes(qNorm) ||
        nameKey(pi.name).includes(qNorm),
    );
    if (match) {
      open({ type: "investigator", id: match.id, resourceId: match.resourceId, label: match.displayName });
    }
  }, [rawRowData]); // eslint-disable-line react-hooks/exhaustive-deps

  const rowData = useMemo(() => {
    let filtered = rawRowData;
    if (roleFilter === "pi") filtered = filtered.filter((pi) => pi.grants.some((g) => g.role === "contact_pi"));
    if (wgFilter !== "all") filtered = filtered.filter((pi) => pi.workingGroups.includes(wgFilter));
    return filtered;
  }, [rawRowData, roleFilter, wgFilter]);

  const totalFundingAll = useMemo(() => {
    const seen = new Set<string>();
    let total = 0;
    rowData.forEach(pi => {
      pi.grants.forEach(g => {
        if (!seen.has(g.grantNumber)) {
          seen.add(g.grantNumber);
          total += g.awardAmount || 0;
        }
      });
    });
    return total;
  }, [rowData]);

  const defaultColDef = useMemo<ColDef>(() => ({
    sortable: true,
    resizable: true,
    suppressMovable: true,
    unSortIcon: true,
  }), []);

  const toggleColumn = useCallback((id: ColumnId) => {
    setVisibleColumns(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const allColumnDefs = useMemo<Record<ColumnId, ColDef<PIRow>>>(() => ({
    investigator: {
      field: "displayName",
      headerName: "Name",
      flex: 1.2,
      minWidth: 220,
      cellRenderer: NameCell,
      sort: "asc" as const,
      wrapText: true,
      autoHeight: true,
    },
    institution: {
      headerName: "Institutions",
      width: 180,
      minWidth: 140,
      cellStyle: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      cellRenderer: (params: any) => <InstitutionCell data={params.data} />,
      filterValueGetter: (params) => (params.data?.institutions || []).join(", "),
    },
    workingGroups: {
      headerName: "Working Groups",
      width: 200,
      minWidth: 160,
      cellRenderer: (params: any) => {
        const wgs: string[] = params.data?.workingGroups || [];
        if (wgs.length === 0) return <span className="text-muted-foreground">—</span>;
        const colorMap: Record<string, string> = {
          "WG-Analytics": "bg-blue-500/10 text-blue-700 border-blue-500/30 dark:text-blue-400",
          "WG-Devices": "bg-violet-500/10 text-violet-700 border-violet-500/30 dark:text-violet-400",
          "WG-ELSI": "bg-rose-500/10 text-rose-700 border-rose-500/30 dark:text-rose-400",
          "WG-Standards": "bg-teal-500/10 text-teal-700 border-teal-500/30 dark:text-teal-400",
        };
        return (
          <div className="flex flex-wrap gap-1 py-1">
            {wgs.map((wg, i) => (
              <Badge key={i} variant="outline" className={`text-[10px] px-1.5 py-0 font-normal ${colorMap[wg] || ""}`}>
                {wg.replace("WG-", "")}
              </Badge>
            ))}
          </div>
        );
      },
      wrapText: true,
      autoHeight: true,
      filterValueGetter: (params) => (params.data?.workingGroups || []).join(", "),
    },
    projects: {
      headerName: "Projects",
      width: 160,
      minWidth: 140,
      cellRenderer: ProjectsCell,
      comparator: (_vA: any, _vB: any, nodeA: any, nodeB: any) =>
        (nodeA.data?.totalProjects || 0) - (nodeB.data?.totalProjects || 0),
    },
    grants: {
      headerName: "Grants",
      flex: 1.2,
      minWidth: 200,
      cellRenderer: GrantsCell,
      wrapText: true,
      autoHeight: true,
      comparator: (_vA: any, _vB: any, nodeA: any, nodeB: any) =>
        (nodeA.data?.grants?.length || 0) - (nodeB.data?.grants?.length || 0),
    },
    funding: {
      field: "totalFunding",
      headerName: "Funding",
      width: 140,
      minWidth: 120,
      cellRenderer: FundingCell,
      comparator: (a: number, b: number) => (a || 0) - (b || 0),
    },
    skills: {
      headerName: "Skills",
      flex: 1,
      minWidth: 200,
      cellRenderer: (params: any) => <SkillsCell data={params.data} />,
      wrapText: true,
      autoHeight: true,
      filterValueGetter: (params) => (params.data?.skills || []).join(", "),
    },
    researchAreas: {
      headerName: "Research Areas",
      flex: 1,
      minWidth: 220,
      cellRenderer: (params: any) => <ResearchAreasCell data={params.data} />,
      wrapText: true,
      autoHeight: true,
      filterValueGetter: (params) => (params.data?.researchAreas || []).join(", "),
    },
  }), []);

  const columnDefs = useMemo<ColDef<PIRow>[]>(() =>
    ALL_COLUMNS.filter(c => visibleColumns.has(c.id)).map(c => allColumnDefs[c.id]),
    [visibleColumns, allColumnDefs]
  );

  return (
    <div className="min-h-screen bg-background">
      <div className="px-6 py-8">
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-foreground mb-2">People</h1>
          <p className="text-muted-foreground mb-6">
            Browse all people across NIH grants in the BBQS consortium. Click a name to view their profile. BBQS-affiliated grants are highlighted in green.
          </p>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
            <Card className="bg-card border-border">
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-primary/10">
                    <Users className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">People</p>
                    <p className="text-xl font-bold text-foreground">{rowData.length}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
            <Card className="bg-card border-border">
              <CardContent className="p-4">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-primary/10">
                    <Users className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wide">Unique Institutions</p>
                    <p className="text-xl font-bold text-foreground">
                      {new Set(rowData.flatMap(pi => pi.institutions)).size}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="flex flex-wrap items-center gap-4 mb-4">
            <Input
              type="text"
              placeholder="Filter by name, institution, expertise..."
              value={quickFilterText}
              onChange={(e) => setQuickFilterText(e.target.value)}
              className="max-w-xs"
            />
            <div className="flex items-center gap-1.5">
              <Filter className="h-4 w-4 text-muted-foreground" />
              {ROLE_FILTERS.map((rf) => (
                <Button
                  key={rf.id}
                  variant={roleFilter === rf.id ? "default" : "outline"}
                  size="sm"
                  onClick={() => setRoleFilter(rf.id)}
                  className="text-xs h-7 px-3"
                >
                  {rf.label}
                </Button>
              ))}
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">WG:</span>
              {WG_FILTERS.map((wf) => (
                <Button
                  key={wf.id}
                  variant={wgFilter === wf.id ? "default" : "outline"}
                  size="sm"
                  onClick={() => setWgFilter(wf.id)}
                  className="text-xs h-7 px-3"
                >
                  {wf.label}
                </Button>
              ))}
            </div>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="gap-1.5">
                  <Columns3 className="h-4 w-4" />
                  Columns
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-52 p-3">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Toggle columns</p>
                <div className="flex flex-col gap-2">
                  {ALL_COLUMNS.map(col => (
                    <label key={col.id} className="flex items-center gap-2 text-sm cursor-pointer">
                      <Checkbox
                        checked={visibleColumns.has(col.id)}
                        onCheckedChange={() => !col.locked && toggleColumn(col.id)}
                        disabled={col.locked}
                      />
                      {col.label}
                    </label>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
            <span className="text-sm text-muted-foreground">{rowData.length} people</span>
          </div>
        </div>

        <div className="ag-grid-mobile-wrapper">
        <div
          className="ag-theme-alpine rounded-lg border border-border overflow-hidden"
          style={{ width: "100%" }}
        >
          <AgGridReact<PIRow>
            rowData={rowData}
            columnDefs={columnDefs}
            defaultColDef={defaultColDef}
            quickFilterText={quickFilterText}
            animateRows={true}
            domLayout="autoHeight"
            suppressCellFocus={true}
            enableCellTextSelection={true}
            rowHeight={64}
            headerHeight={40}
            loading={isLoading}
            loadingOverlayComponent={() => (
              <div className="flex flex-col items-center gap-3 text-muted-foreground">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                <span>Loading...</span>
              </div>
            )}
            noRowsOverlayComponent={() => (
              <div className="flex flex-col items-center gap-3 text-muted-foreground">
                <Users className="h-8 w-8 text-muted-foreground" />
                <span>No investigators found</span>
              </div>
            )}
          />
        </div>
        </div>

      </div>
    </div>
  );
}
