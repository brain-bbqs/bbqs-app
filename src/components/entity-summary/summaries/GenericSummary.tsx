import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { SummaryField } from "../SummaryField";
import { SummaryTabs } from "../SummaryTabs";
import { EntityComments } from "../EntityComments";
import { Skeleton } from "@/components/ui/skeleton";
import { FileText, MessageSquare, Box } from "lucide-react";
import type { EntityType } from "@/contexts/EntitySummaryContext";
import { ProvenanceScope } from "@/components/provenance/ProvenanceScope";

export function GenericSummary({ id, type }: { id: string; type: EntityType }) {
  const { data, isLoading } = useQuery({
    queryKey: ["entity-resource", id],
    queryFn: async () => {
      const { data: res, error } = await supabase.from("resources").select("*").eq("id", id).single();
      if (error) throw error;
      return res;
    },
  });

  if (isLoading) return <div className="p-6 space-y-4"><Skeleton className="h-10 w-48" /><Skeleton className="h-4 w-full" /></div>;
  if (!data) return <p className="p-6 text-muted-foreground">Resource not found.</p>;

  const summaryContent = (
    <div className="space-y-1">
      <SummaryField label="Name" field="name"><span className="font-medium">{data.name}</span></SummaryField>
      {data.description && <SummaryField label="Description" field="description">{data.description}</SummaryField>}
      {data.external_url && (
        <SummaryField label="Link" field="external_url">
          <a href={data.external_url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
            {data.external_url}
          </a>
        </SummaryField>
      )}
    </div>
  );

  return (
    <ProvenanceScope table="resources" id={id}>
    <div>
      <div className="px-6 pt-6 pb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
            <Box className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-foreground">{data.name}</h2>
            <p className="text-sm text-muted-foreground capitalize">{type.replace("_", " ")}</p>
          </div>
        </div>
      </div>
      <SummaryTabs tabs={[
        { id: "summary", label: "Summary", icon: <FileText className="h-3.5 w-3.5" />, content: summaryContent },
        { id: "comments", label: "Comments", icon: <MessageSquare className="h-3.5 w-3.5" />, content: <EntityComments resourceId={data.id} /> },
      ]} />
    </div>
    </ProvenanceScope>
  );
}
