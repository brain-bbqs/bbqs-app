import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { SummaryField } from "../SummaryField";
import { SummaryTabs } from "../SummaryTabs";
import { EntityComments } from "../EntityComments";
import { useEntitySummary } from "@/contexts/EntitySummaryContext";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ExternalLink, FileText, MessageSquare, FolderOpen, Microscope, Settings } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useCanEditProject } from "@/hooks/useCanEditProject";
import { useUserTier } from "@/hooks/useUserTier";
import { GrantMarrSection } from "./GrantMarrSection";
import { ProjectQuestionnaireBody } from "@/components/project-profile/ProjectQuestionnaireBody";
import { useProjectProfileEditor } from "@/components/project-profile/useProjectProfileEditor";
import { Database } from "lucide-react";
import { ProvenanceScope } from "@/components/provenance/ProvenanceScope";

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

const PI_ROLES = new Set(["pi", "contact_pi", "co_pi", "mpi"]);

function roleLabel(role: string | null | undefined): string {
  switch ((role || "").toLowerCase()) {
    case "contact_pi": return "Contact PI";
    case "pi": return "PI";
    case "co_pi": return "Co-PI";
    case "mpi": return "MPI";
    default: return "Co-PI";
  }
}

export function GrantSummary({ id }: { id: string }) {
  const { open, close } = useEntitySummary();
  const grantNumberQ = useQuery({
    queryKey: ["grant-number-only", id],
    queryFn: async () => {
      const { data } = await supabase.from("grants").select("grant_number").eq("id", id).single();
      return data?.grant_number ?? null;
    },
  });
  const { canEdit } = useCanEditProject(grantNumberQ.data ?? null);
  // The full profile is the richest page on the site and was reachable only through a button hidden
  // from anyone who could not edit — so most of the consortium could not find it at all.
  const { isMember } = useUserTier();

  // The profile's own editor, so the tab below shows the questionnaire rather than a button that
  // leaves. Gated by passing null: the hook must run unconditionally, but its query must not fire
  // for someone who cannot read the profile.
  const profileEditor = useProjectProfileEditor(
    isMember ? (grantNumberQ.data ?? null) : null,
    canEdit,
  );

  const { data, isLoading } = useQuery({
    queryKey: ["entity-grant", id],
    queryFn: async () => {
      const { data: grant, error } = await supabase.from("grants").select("*").eq("id", id).single();
      if (error) throw error;

      // Get investigators — only PI-like roles are shown in the grant
      // summary's "Investigators" badge row, matching the Projects page
      // PI column. Staff/trainees added by curators live in the project
      // profile's team roster instead.
      const { data: invLinks } = await supabase
        .from("grant_investigators")
        .select("investigator_id, role, grant_id")
        .eq("grant_id", id);
      const piLinks = (invLinks || []).filter((l: any) =>
        PI_ROLES.has((l.role || "").toLowerCase())
      );
      const invIds = piLinks.map((i) => i.investigator_id);
      const { data: investigators } = invIds.length
        ? await supabase.from("investigators_public" as any).select("id, name, resource_id").in("id", invIds) as { data: { id: string; name: string; resource_id: string | null }[] | null }
        : { data: [] };

      // Get project metadata
      const { data: project } = await supabase
        .from("projects")
        .select("*")
        .eq("grant_number", grant.grant_number)
        .maybeSingle();

      // Get linked EMBER dandisets (read-only, public)
      const { data: dsLinks } = await supabase
        .from("grant_dandisets")
        .select("matched_award, dandiset:dandisets(id, dandiset_id, name, contact_name, file_count, size_bytes, species, draft_url, neurosift_url)")
        .eq("grant_id", id);
      const dandisets = (dsLinks || []).filter((r: any) => r.dandiset);

      // Get publications - try project_publications join first, then fall back to nih_grants_cache
      let publications: any[] = [];
      if (project?.id) {
        const { data: pubLinks } = await supabase
          .from("project_publications")
          .select("publication_id")
          .eq("project_id", project.id);
        const pubIds = pubLinks?.map((p) => p.publication_id) || [];
        if (pubIds.length) {
          const { data: pubs } = await supabase
            .from("publications")
            .select("id, title, authors, year, journal, doi, citations, rcr, resource_id, pubmed_link")
            .in("id", pubIds)
            .order("year", { ascending: false });
          publications = pubs || [];
        }
      }

      // nih_grants_cache fallback removed (table dropped)

      return {
        ...grant,
        invLinks: piLinks,
        investigators: investigators || [],
        project,
        publications,
        dandisets,
      };
    },
  });

  if (isLoading) return <div className="p-6 space-y-4"><Skeleton className="h-10 w-48" /><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-3/4" /></div>;
  if (!data) return <p className="p-6 text-muted-foreground">Grant not found.</p>;

  const summaryContent = (
    <div className="space-y-1">
      <SummaryField label="Title" field="title"><span className="font-medium">{data.title}</span></SummaryField>
      <SummaryField label="Grant Number" field="grant_number"><span className="font-mono">{data.grant_number}</span></SummaryField>
      {data.fiscal_year && <SummaryField label="Fiscal Year" field="fiscal_year">{data.fiscal_year}</SummaryField>}
      {data.award_amount && <SummaryField label="Award Amount" field="award_amount">${Number(data.award_amount).toLocaleString()}</SummaryField>}
      {data.nih_link && (
        <SummaryField label="NIH Reporter" field="nih_link">
          <a href={data.nih_link} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">
            View on NIH Reporter <ExternalLink className="h-3 w-3" />
          </a>
        </SummaryField>
      )}
      {data.project?.website && (
        <SummaryField label="Website">
          <a href={data.project.website} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">
            {data.project.website} <ExternalLink className="h-3 w-3" />
          </a>
        </SummaryField>
      )}

      {/* Abstract */}
      {data.abstract && (
        <div className="pt-3">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-2">Abstract</h3>
          <p className="text-sm text-foreground leading-relaxed">{data.abstract}</p>
        </div>
      )}

      {/* Investigators */}
      {data.investigators.length > 0 && (
        <div className="pt-4">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Investigators ({data.investigators.length})</h3>
          <div className="flex flex-wrap gap-2">
            {data.investigators.map((inv) => {
              const link = data.invLinks.find((l: any) => l.investigator_id === inv.id);
              return (
                <Badge
                  key={inv.id}
                  variant="outline"
                  className="cursor-pointer hover:bg-accent"
                  onClick={() => open({ type: "investigator", id: inv.id, resourceId: inv.resource_id || undefined, label: inv.name })}
                >
                  {inv.name} ({roleLabel(link?.role)})
                </Badge>
              );
            })}
          </div>
        </div>
      )}

      {/* Project metadata */}
      {data.project && (
        <div className="pt-4 space-y-2">
          {data.project.keywords?.length > 0 && (
            <SummaryField label="Keywords">
              <div className="flex flex-wrap gap-1.5">{data.project.keywords.map((k: string) => <Badge key={k} variant="secondary">{k}</Badge>)}</div>
            </SummaryField>
          )}
          {data.project.study_species?.length > 0 && (
            <SummaryField label="Species">
              <div className="flex flex-wrap gap-1.5">{data.project.study_species.map((s: string) => <Badge key={s} variant="secondary">{s}</Badge>)}</div>
            </SummaryField>
          )}
          {(data.project.metadata as any)?.use_approaches?.length > 0 && (
            <SummaryField label="Approaches">
              <div className="flex flex-wrap gap-1.5">{((data.project.metadata as any).use_approaches as string[]).map((a: string) => <Badge key={a} variant="secondary">{a}</Badge>)}</div>
            </SummaryField>
          )}
        </div>
      )}

    </div>
  );

  const emberContent = (
    !data.dandisets || data.dandisets.length === 0 ? (
      <p className="text-sm text-muted-foreground border border-dashed border-border rounded-lg p-4">
        No EMBER datasets are linked to this award. Datasets auto-link when their
        DANDI <code className="text-xs">contributor.awardNumber</code> matches this grant.{" "}
        <a
          href="https://dandi.emberarchive.org/"
          target="_blank"
          rel="noreferrer"
          className="text-primary hover:underline"
        >
          Browse EMBER archive →
        </a>
      </p>
    ) : (
      <ul className="divide-y divide-border border border-border rounded-lg">
        {data.dandisets.map((row: any) => {
          const d = row.dandiset;
          return (
            <li key={d.id} className="p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <a
                    href={d.draft_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm font-medium text-foreground hover:text-primary inline-flex items-center gap-1"
                  >
                    {d.name}
                    <ExternalLink className="h-3 w-3 opacity-60" />
                  </a>
                  <p className="text-xs font-mono text-muted-foreground mt-0.5">
                    DANDI:{d.dandiset_id}
                    {row.matched_award ? ` · matched ${row.matched_award}` : ""}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {d.contact_name ? `${d.contact_name} · ` : ""}
                    {d.file_count?.toLocaleString() || "—"} files · {formatBytes(d.size_bytes)}
                    {d.species?.length ? ` · ${d.species.join(", ")}` : ""}
                  </p>
                </div>
                {d.neurosift_url && (
                  <a
                    href={d.neurosift_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-primary hover:underline whitespace-nowrap shrink-0"
                  >
                    Neurosift →
                  </a>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    )
  );

  const publicationsContent = (
    <div className="space-y-3">
      {data.publications.length === 0 ? (
        <p className="text-sm text-muted-foreground italic">No publications linked to this grant yet.</p>
      ) : (
        data.publications.map((pub: any) => (
          <div key={pub.id} className="p-3 rounded-lg border border-border bg-card hover:bg-accent/50 transition-colors">
            <button
              className="text-left w-full"
              onClick={() => open({ type: "publication", id: pub.id, resourceId: pub.resource_id || undefined, label: pub.title })}
            >
              <p className="text-sm font-medium text-foreground leading-snug line-clamp-2">{pub.title}</p>
            </button>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-xs text-muted-foreground">
              {pub.journal && <span>{pub.journal}</span>}
              {pub.year && <span>{pub.year}</span>}
              {pub.citations > 0 && <span>{pub.citations} citations</span>}
              {pub.doi && (
                <a href={`https://doi.org/${pub.doi}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-0.5">
                  DOI <ExternalLink className="h-2.5 w-2.5" />
                </a>
              )}
              {pub.pubmed_link && (
                <a href={pub.pubmed_link} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-0.5">
                  PubMed <ExternalLink className="h-2.5 w-2.5" />
                </a>
              )}
            </div>
            {pub.authors && <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{pub.authors}</p>}
          </div>
        ))
      )}
    </div>
  );

  return (
    <ProvenanceScope table="grants" id={id}>
    <div>
      <div className="px-6 pt-6 pb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
            <FolderOpen className="h-5 w-5 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-xl font-bold text-foreground">{data.grant_number}</h2>
            <p className="text-sm text-muted-foreground">NIH Grant</p>
          </div>
          {/* Was a button here. It is a TAB now, next to Summary, so the way into the profile sits
              with the rest of the card's navigation instead of floating in the header. */}
        </div>
      </div>
      <SummaryTabs tabs={[
        { id: "summary", label: "Summary", icon: <FileText className="h-3.5 w-3.5" />, content: summaryContent },
        ...(isMember ? [{
          id: "profile",
          label: canEdit ? "Manage" : "Full profile",
          icon: <Settings className="h-3.5 w-3.5" />,
          // The questionnaire itself, edited in place. This tab previously held one button whose
          // only job was to navigate away, which made the tab a doorway rather than a place.
          content: (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <p className="text-xs text-muted-foreground">
                  Every questionnaire answer, with the source recorded against each field.
                  {canEdit ? " Click a value to edit it." : " Read only."}
                </p>
                <div className="flex items-center gap-3 shrink-0">
                  {data.project && (
                    <span className="text-xs text-muted-foreground">
                      <span className="font-medium text-foreground tabular-nums">
                        {(data.project as any).metadata_completeness ?? 0}%
                      </span>{" "}
                      complete
                    </span>
                  )}
                  {/* Still worth linking: the page is wider and adds the roster and EMBER panels. */}
                  <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-xs">
                    <Link to={`/projects/${data.grant_number}/profile`} onClick={() => close()}>
                      <ExternalLink className="h-3 w-3 mr-1" />
                      Full page
                    </Link>
                  </Button>
                </div>
              </div>
              <ProjectQuestionnaireBody
                editor={profileEditor}
                canEdit={canEdit}
                variant="panel"
              />
            </div>
          ),
        }] : []),
        { id: "details", label: "Details", icon: <Microscope className="h-3.5 w-3.5" />, content: (
          data.project ? (
            <GrantMarrSection metadata={(data.project as any).metadata || {}} project={data.project} />
          ) : (
            <p className="text-sm text-muted-foreground italic">No project metadata available.</p>
          )
        )},
        { id: "publications", label: `Publications (${data.publications.length})`, icon: <FileText className="h-3.5 w-3.5" />, content: publicationsContent },
        { id: "ember", label: `EMBER Data${data.dandisets?.length ? ` (${data.dandisets.length})` : ""}`, icon: <Database className="h-3.5 w-3.5" />, content: emberContent },
        { id: "comments", label: "Comments", icon: <MessageSquare className="h-3.5 w-3.5" />, content: data.resource_id ? <EntityComments resourceId={data.resource_id} /> : <p className="text-sm text-muted-foreground italic">Comments not available.</p> },
      ]} />
    </div>
    </ProvenanceScope>
  );
}
