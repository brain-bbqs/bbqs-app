import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { SummaryField } from "../SummaryField";
import { SummaryTabs } from "../SummaryTabs";
import { EntityComments } from "../EntityComments";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ExternalLink, FileText, MessageSquare, BookOpen } from "lucide-react";
import { ProvenanceScope } from "@/components/provenance/ProvenanceScope";

export function PublicationSummary({ id }: { id: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["entity-publication", id],
    queryFn: async () => {
      const { data: pub, error } = await supabase.from("publications").select("*").eq("id", id).single();
      if (error) throw error;
      return pub;
    },
  });

  if (isLoading) return <div className="p-6 space-y-4"><Skeleton className="h-10 w-48" /><Skeleton className="h-4 w-full" /></div>;
  if (!data) return <p className="p-6 text-muted-foreground">Publication not found.</p>;

  const summaryContent = (
    <div className="space-y-1">
      <SummaryField label="Title" field="title"><span className="font-medium italic">{data.title}</span></SummaryField>
      {data.authors && <SummaryField label="Authors" field="authors">{data.authors}</SummaryField>}
      {data.journal && <SummaryField label="Journal" field="journal">{data.journal}</SummaryField>}
      {data.year && <SummaryField label="Published" field="year">{data.year}</SummaryField>}
      {data.doi && (
        <SummaryField label="DOI" field="doi">
          <a href={`https://doi.org/${data.doi}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">
            {data.doi} <ExternalLink className="h-3 w-3" />
          </a>
        </SummaryField>
      )}
      {data.pmid && (
        <SummaryField label="PubMed ID" field="pmid">
          <a href={data.pubmed_link || `https://pubmed.ncbi.nlm.nih.gov/${data.pmid}/`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">
            {data.pmid} <ExternalLink className="h-3 w-3" />
          </a>
        </SummaryField>
      )}
      {data.citations != null && <SummaryField label="Citations" field="citations">{data.citations}</SummaryField>}
      {data.rcr != null && <SummaryField label="RCR" field="rcr">{Number(data.rcr).toFixed(2)}</SummaryField>}
      {data.keywords && data.keywords.length > 0 && (
        <SummaryField label="Keywords" field="keywords">
          <div className="flex flex-wrap gap-1.5">{data.keywords.map((k: string) => <Badge key={k} variant="secondary">{k}</Badge>)}</div>
        </SummaryField>
      )}
    </div>
  );

  return (
    <ProvenanceScope table="publications" id={id}>
    <div>
      <div className="px-6 pt-6 pb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
            <BookOpen className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-foreground line-clamp-2">{data.title}</h2>
            <p className="text-sm text-muted-foreground">Publication · {data.year || "N/A"}</p>
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
