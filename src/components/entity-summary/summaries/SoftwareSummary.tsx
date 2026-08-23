import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { SummaryField } from "../SummaryField";
import { SummaryTabs } from "../SummaryTabs";
import { EntityComments } from "../EntityComments";
import { Skeleton } from "@/components/ui/skeleton";
import { ExternalLink, FileText, MessageSquare, Code } from "lucide-react";
import { ProvenanceScope } from "@/components/provenance/ProvenanceScope";

export function SoftwareSummary({ id }: { id: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["entity-software", id],
    queryFn: async () => {
      const { data: sw, error } = await supabase.from("software_tools").select("*").eq("id", id).single();
      if (error) throw error;
      return sw;
    },
  });

  if (isLoading) return <div className="p-6 space-y-4"><Skeleton className="h-10 w-48" /><Skeleton className="h-4 w-full" /></div>;
  if (!data) return <p className="p-6 text-muted-foreground">Software not found.</p>;

  const summaryContent = (
    <div className="space-y-1">
      <SummaryField label="Name" field="name"><span className="font-medium">{data.name}</span></SummaryField>
      {data.description && <SummaryField label="Description" field="description">{data.description}</SummaryField>}
      {data.language && <SummaryField label="Language" field="language">{data.language}</SummaryField>}
      {data.version && <SummaryField label="Version" field="version">{data.version}</SummaryField>}
      {data.license && <SummaryField label="License" field="license">{data.license}</SummaryField>}
      {data.repo_url && (
        <SummaryField label="Repository" field="repo_url">
          <a href={data.repo_url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">
            {data.repo_url} <ExternalLink className="h-3 w-3" />
          </a>
        </SummaryField>
      )}
      {data.docs_url && (
        <SummaryField label="Documentation" field="docs_url">
          <a href={data.docs_url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">
            Docs <ExternalLink className="h-3 w-3" />
          </a>
        </SummaryField>
      )}
    </div>
  );

  return (
    <ProvenanceScope table="software_tools" id={id}>
    <div>
      <div className="px-6 pt-6 pb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
            <Code className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-foreground">{data.name}</h2>
            <p className="text-sm text-muted-foreground">Software Tool{data.version ? ` · v${data.version}` : ""}</p>
          </div>
        </div>
      </div>
      <SummaryTabs tabs={[
        { id: "summary", label: "Summary", icon: <FileText className="h-3.5 w-3.5" />, content: summaryContent },
        { id: "comments", label: "Comments", icon: <MessageSquare className="h-3.5 w-3.5" />, content: data.resource_id ? <EntityComments resourceId={data.resource_id} /> : <p className="text-sm text-muted-foreground italic">Comments not available.</p> },
      ]} />
    </div>
    </ProvenanceScope>
  );
}
