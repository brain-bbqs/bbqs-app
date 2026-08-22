// The full-page project profile. Its editor and its questionnaire body are shared with the project
// card's "Manage" tab (see useProjectProfileEditor / ProjectQuestionnaireBody) — this page is now
// the roomy view of that content, not the only place it exists.
import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useCanEditProject } from "@/hooks/useCanEditProject";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageMeta } from "@/components/PageMeta";
import { useUserTier } from "@/hooks/useUserTier";
import { AccessGate } from "@/components/project-profile/AccessGate";
import { TeamRosterEditor } from "@/components/project-profile/TeamRosterEditor";
import { EmberDandisetsPanel } from "@/components/project-profile/EmberDandisetsPanel";
import { ProjectQuestionnaireBody } from "@/components/project-profile/ProjectQuestionnaireBody";
import { useProjectProfileEditor } from "@/components/project-profile/useProjectProfileEditor";

export default function ProjectProfile() {
  const { grantNumber } = useParams<{ grantNumber: string }>();
  const { user, loading: authLoading } = useAuth();
  const { canEdit, isLoading: permLoading } = useCanEditProject(grantNumber || null);
  // Any consortium member (tier 3 and up) may READ a project profile. Editing still needs canEdit.
  const { isMember, isLoading: tierLoading } = useUserTier();

  const editor = useProjectProfileEditor(grantNumber || null, canEdit);
  const { data, isLoading, completeness } = editor;

  // Deep links like /projects/R24MH136632/profile#species open that section and scroll to it.
  const [hashSection, setHashSection] = useState<string>(() =>
    window.location.hash.replace(/^#/, ""),
  );
  useEffect(() => {
    const onHash = () => setHashSection(window.location.hash.replace(/^#/, ""));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    if (!hashSection) return;
    const t = setTimeout(() => {
      const el = document.getElementById(hashSection);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 300);
    return () => clearTimeout(t);
  }, [hashSection, isLoading]);

  // ── Render gates ────────────────────────────────────────────────
  if (!grantNumber) return <div className="p-8">Missing grant number.</div>;
  if (authLoading) return <div className="p-8"><Skeleton className="h-8 w-64" /></div>;
  if (!user) return <AccessGate reason="unauthenticated" grantNumber={grantNumber} />;
  if (permLoading || tierLoading) return <div className="p-8"><Skeleton className="h-8 w-64" /></div>;
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

        {/* Team roster */}
        <TeamRosterEditor grantId={data.grant.id} canEdit={canEdit} />

        {/* EMBER datasets linked by award number */}
        <EmberDandisetsPanel grantId={data.grant.id} canSync={canEdit} />

        {/* Questionnaire — the same component the card tab renders */}
        <ProjectQuestionnaireBody
          editor={editor}
          canEdit={canEdit}
          variant="page"
          openSection={hashSection}
        />
      </div>
    </>
  );
}
