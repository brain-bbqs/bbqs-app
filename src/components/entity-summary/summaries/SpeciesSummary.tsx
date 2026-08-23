import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useEntitySummary } from "@/contexts/EntitySummaryContext";
import { SummaryField } from "../SummaryField";
import { SummaryTabs } from "../SummaryTabs";
import { EntityComments } from "../EntityComments";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { FileText, MessageSquare, Bug, FlaskConical } from "lucide-react";
import { useMarrProjects } from "@/hooks/useMarrProjects";
import { ProvenanceScope } from "@/components/provenance/ProvenanceScope";

function RelatedProjects({ speciesName, commonName }: { speciesName: string; commonName?: string | null }) {
  const { open } = useEntitySummary();
  // Use YAML as the single source of truth so the count here always matches
  // the Species directory table (which is also derived from YAML).
  const { projects: yamlProjects, loading: isLoading } = useMarrProjects();

  const norm = (s: string) => s.trim().toLowerCase();
  const terms = new Set<string>();
  if (speciesName) terms.add(norm(speciesName));
  if (commonName) terms.add(norm(commonName));

  const projects = yamlProjects
    .filter((p) => {
      const candidates = [
        ...(p.speciesList || []),
        p.species,
        p.speciesCommonName,
        ...Object.values(p.speciesCommonNames || {}),
      ]
        .filter(Boolean)
        .map((s) => norm(s as string));
      return candidates.some((c) =>
        Array.from(terms).some((t) => c === t || c.includes(t) || t.includes(c)),
      );
    })
    .map((p) => ({
      id: p.id,
      grant_number: p.id,
      keywords: p.keywords,
    }));

  const openGrant = async (grantNumber: string) => {
    const cleanId = grantNumber.replace(/^\d(?=[A-Z])/, "");
    const { data: grant } = await supabase
      .from("grants")
      .select("id, resource_id, title")
      .eq("grant_number", cleanId)
      .maybeSingle();
    if (grant) {
      open({ type: "grant", id: grant.id, resourceId: grant.resource_id || undefined, label: grant.title || grantNumber });
    }
  };

  if (isLoading) return <div className="space-y-2"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></div>;

  if (!projects?.length) return <p className="text-sm text-muted-foreground italic">No linked projects found.</p>;

  return (
    <div className="space-y-2">
      {projects.map((p) => (
        <button
          key={p.id}
          onClick={() => openGrant(p.grant_number)}
          className="w-full text-left p-3 rounded-lg border border-border hover:bg-accent/50 transition-colors group"
        >
          <p className="text-sm font-medium text-primary group-hover:underline">{p.grant_number}</p>
          {p.keywords && p.keywords.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {p.keywords.slice(0, 5).map((k: string) => (
                <Badge key={k} variant="secondary" className="text-[10px]">{k}</Badge>
              ))}
            </div>
          )}
        </button>
      ))}
    </div>
  );
}

export function SpeciesSummary({ id }: { id: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["entity-species", id],
    queryFn: async () => {
      const { data: sp, error } = await supabase.from("species").select("*").eq("id", id).single();
      if (error) throw error;
      return sp;
    },
  });

  if (isLoading) return <div className="p-6 space-y-4"><Skeleton className="h-10 w-48" /><Skeleton className="h-4 w-full" /></div>;
  if (!data) return <p className="p-6 text-muted-foreground">Species not found.</p>;

  const summaryContent = (
    <div className="space-y-1">
      <SummaryField label="Scientific Name" field="name"><span className="italic font-medium">{data.name}</span></SummaryField>
      {data.common_name && <SummaryField label="Common Name" field="common_name">{data.common_name}</SummaryField>}
      {data.taxonomy_class && <SummaryField label="Class" field="taxonomy_class">{data.taxonomy_class}</SummaryField>}
      {data.taxonomy_order && <SummaryField label="Order" field="taxonomy_order">{data.taxonomy_order}</SummaryField>}
      {data.taxonomy_family && <SummaryField label="Family" field="taxonomy_family">{data.taxonomy_family}</SummaryField>}
      {data.taxonomy_genus && <SummaryField label="Genus" field="taxonomy_genus">{data.taxonomy_genus}</SummaryField>}
    </div>
  );

  return (
    <ProvenanceScope table="species" id={id}>
    <div>
      <div className="px-6 pt-6 pb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
            <Bug className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-foreground italic">{data.name}</h2>
            <p className="text-sm text-muted-foreground">Species{data.common_name ? ` · ${data.common_name}` : ""}</p>
          </div>
        </div>
      </div>
      <SummaryTabs tabs={[
        { id: "summary", label: "Summary", icon: <FileText className="h-3.5 w-3.5" />, content: summaryContent },
        { id: "projects", label: "Projects", icon: <FlaskConical className="h-3.5 w-3.5" />, content: <RelatedProjects speciesName={data.name} commonName={data.common_name} /> },
        { id: "comments", label: "Comments", icon: <MessageSquare className="h-3.5 w-3.5" />, content: data.resource_id ? <EntityComments resourceId={data.resource_id} /> : <p className="text-sm text-muted-foreground italic">Comments not available.</p> },
      ]} />
    </div>
    </ProvenanceScope>
  );
}