import { ProvenanceScope } from "@/components/provenance/ProvenanceScope";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { SummaryField } from "../SummaryField";
import { SummaryTabs } from "../SummaryTabs";
import { EntityComments } from "../EntityComments";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ExternalLink, FileText, MessageSquare, Code, Database, FlaskConical,
  Brain, BookOpen, Github, Container, Shield, Check, Circle
} from "lucide-react";

const categoryConfig: Record<string, { icon: typeof Code; label: string; badgeClass: string }> = {
  software: { icon: Code, label: "Software", badgeClass: "bg-blue-500/20 text-blue-400 border-blue-500/30" },
  tool: { icon: Code, label: "Software Tool", badgeClass: "bg-blue-500/20 text-blue-400 border-blue-500/30" },
  dataset: { icon: Database, label: "Dataset", badgeClass: "bg-green-500/20 text-green-400 border-green-500/30" },
  benchmark: { icon: FlaskConical, label: "Benchmark", badgeClass: "bg-orange-500/20 text-orange-400 border-orange-500/30" },
  ml_model: { icon: Brain, label: "ML Model", badgeClass: "bg-purple-500/20 text-purple-400 border-purple-500/30" },
  protocol: { icon: BookOpen, label: "Protocol", badgeClass: "bg-pink-500/20 text-pink-400 border-pink-500/30" },
};

export function ResourceSummary({ id }: { id: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["entity-resource", id],
    queryFn: async () => {
      // Try resources table first
      const { data: resource, error } = await supabase
        .from("resources")
        .select("*")
        .eq("id", id)
        .single();
      if (error) throw error;

      // If it's software, also get software_tools details
      let softwareDetails = null;
      if (resource.resource_type === "software" || resource.resource_type === "tool") {
        const { data: sw } = await supabase
          .from("software_tools")
          .select("*")
          .eq("resource_id", id)
          .maybeSingle();
        softwareDetails = sw;
      }

      return { ...resource, softwareDetails };
    },
  });

  if (isLoading) return <div className="p-6 space-y-4"><Skeleton className="h-10 w-48" /><Skeleton className="h-4 w-full" /></div>;
  if (!data) return <p className="p-6 text-muted-foreground">Resource not found.</p>;

  const meta = (data.metadata as Record<string, any>) || {};
  const sw = data.softwareDetails;
  const config = categoryConfig[data.resource_type] || categoryConfig.software;
  const Icon = config.icon;

  const version = sw?.version || meta.version || null;
  const language = sw?.language || meta.implementation || null;
  const license = sw?.license || meta.license || null;
  const repoUrl = sw?.repo_url || meta.repoUrl || null;
  const docsUrl = sw?.docs_url || meta.docsUrl || null;
  const dockerUrl = meta.dockerUrl || null;
  const containerized = meta.containerized || false;
  const mcpStatus = meta.mcpStatus || meta.neuroMcpStatus || "not-started";
  const species = meta.species || null;
  const architecture = meta.neuralNetworkArchitecture || null;
  const pipeline = meta.mlPipeline || null;

  const mcpConfig = {
    trained: { label: "Trained", className: "bg-green-500/20 text-green-400 border-green-500/30", icon: Check },
    pending: { label: "Pending", className: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30", icon: Circle },
    "not-started": { label: "Not Started", className: "bg-muted/50 text-muted-foreground border-border", icon: Circle },
  };
  const mcp = mcpConfig[mcpStatus as keyof typeof mcpConfig] || mcpConfig["not-started"];
  const McpIcon = mcp.icon;

  const summaryContent = (
    <div className="space-y-1">
      {meta.source === "ember" && (
        <SummaryField label="Archive">
          <Badge variant="outline" className="bg-emerald-500/15 text-emerald-700 border-emerald-500/30 text-xs">
            EMBER {meta.dandiset_id ? `· DANDI:${meta.dandiset_id}` : ""}
          </Badge>
        </SummaryField>
      )}
      {data.description && <SummaryField label="Description" field="description">{data.description}</SummaryField>}
      {version && <SummaryField label="Version">{version}</SummaryField>}
      {language && <SummaryField label="Language / Format">{language}</SummaryField>}
      {license && <SummaryField label="License"><Badge variant="outline" className="text-xs">{license}</Badge></SummaryField>}
      {species && <SummaryField label="Species" field="species">{species}</SummaryField>}
      {architecture && <SummaryField label="Architecture" field="neuralNetworkArchitecture">{architecture}</SummaryField>}
      {pipeline && <SummaryField label="Pipeline" field="mlPipeline">{pipeline}</SummaryField>}
      {data.external_url && (
        <SummaryField label="Website" field="external_url">
          <a href={data.external_url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">
            {data.external_url} <ExternalLink className="h-3 w-3" />
          </a>
        </SummaryField>
      )}
      {repoUrl && (
        <SummaryField label="Repository">
          <a href={repoUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">
            <Github className="h-3.5 w-3.5" /> {repoUrl} <ExternalLink className="h-3 w-3" />
          </a>
        </SummaryField>
      )}
      {docsUrl && (
        <SummaryField label="Documentation">
          <a href={docsUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">
            Docs <ExternalLink className="h-3 w-3" />
          </a>
        </SummaryField>
      )}
    </div>
  );

  const technicalContent = (
    <div className="space-y-4 p-1">
      {/* Docker */}
      <div className="rounded-lg border border-border p-4 bg-muted/20">
        <div className="flex items-center gap-2 mb-3">
          <Container className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Docker / Container</h3>
        </div>
        {dockerUrl ? (
          <a href={dockerUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-1 text-sm">
            <Container className="h-3.5 w-3.5" /> View Registry <ExternalLink className="h-3 w-3" />
          </a>
        ) : containerized ? (
          <Badge variant="outline" className="bg-cyan-500/20 text-cyan-400 border-cyan-500/30 text-xs gap-1">
            <Container className="h-3 w-3" /> Available
          </Badge>
        ) : (
          <Badge variant="outline" className="bg-muted/50 text-muted-foreground border-border text-xs gap-1">
            Coming Soon
          </Badge>
        )}
      </div>

      {/* MCP Protocol */}
      <div className="rounded-lg border border-border p-4 bg-muted/20">
        <div className="flex items-center gap-2 mb-3">
          <Shield className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">MCP Protocol</h3>
        </div>
        <Badge variant="outline" className={`${mcp.className} text-xs gap-1`}>
          <McpIcon className="h-3 w-3" /> {mcp.label}
        </Badge>
        <p className="text-xs text-muted-foreground mt-2">
          Model Context Protocol integration status for AI-assisted workflows.
        </p>
      </div>
    </div>
  );

  return (
    <ProvenanceScope table="resources" id={id}>
    <div>
      <div className="px-6 pt-6 pb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
            <Icon className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-foreground">{data.name}</h2>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className={`${config.badgeClass} text-xs`}>{config.label}</Badge>
              {version && <span className="text-sm text-muted-foreground">v{version}</span>}
            </div>
          </div>
        </div>
      </div>
      <SummaryTabs tabs={[
        { id: "summary", label: "Summary", icon: <FileText className="h-3.5 w-3.5" />, content: summaryContent },
        { id: "technical", label: "Technical", icon: <Code className="h-3.5 w-3.5" />, content: technicalContent },
        { id: "comments", label: "Comments", icon: <MessageSquare className="h-3.5 w-3.5" />, content: <EntityComments resourceId={id} /> },
      ]} />
    </div>
    </ProvenanceScope>
  );
}
