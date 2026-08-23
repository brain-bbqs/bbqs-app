import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { SummaryField } from "../SummaryField";
import { SummaryTabs } from "../SummaryTabs";
import { useEntitySummary } from "@/contexts/EntitySummaryContext";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ExternalLink, FileText, Building, Shield, Scale } from "lucide-react";
import { ProvenanceScope } from "@/components/provenance/ProvenanceScope";

export function OrganizationSummary({ id }: { id: string }) {
  const { open } = useEntitySummary();

  const { data, isLoading } = useQuery({
    queryKey: ["entity-organization", id],
    queryFn: async () => {
      const { data: org, error } = await supabase.from("organizations").select("*").eq("id", id).single();
      if (error) throw error;

      // Get investigators at this org
      const { data: invLinks } = await supabase
        .from("investigator_organizations")
        .select("investigator_id")
        .eq("organization_id", id);
      const invIds = invLinks?.map((i) => i.investigator_id) || [];
      const { data: investigators } = invIds.length
        ? await supabase.from("investigators_public" as any).select("id, name, resource_id").in("id", invIds) as { data: { id: string; name: string; resource_id: string | null }[] | null }
        : { data: [] };

      // Get allowed domains for this org
      const { data: domains } = await supabase
        .from("allowed_domains")
        .select("domain")
        .eq("organization_id", id);

      return { ...org, investigators: investigators || [], domains: domains || [] };
    },
  });

  if (isLoading) return <div className="p-6 space-y-4"><Skeleton className="h-10 w-48" /><Skeleton className="h-4 w-full" /></div>;
  if (!data) return <p className="p-6 text-muted-foreground">Organization not found.</p>;

  const summaryContent = (
    <div className="space-y-1">
      <SummaryField label="Name" field="name"><span className="font-medium">{data.name}</span></SummaryField>
      {data.url && (
        <SummaryField label="Website" field="url">
          <a href={data.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">
            {data.url} <ExternalLink className="h-3 w-3" />
          </a>
        </SummaryField>
      )}
      {data.domains.length > 0 && (
        <SummaryField label="Email Domains">
          <div className="flex flex-wrap gap-1.5">
            {data.domains.map((d: any) => (
              <Badge key={d.domain} variant="secondary" className="text-xs">{d.domain}</Badge>
            ))}
          </div>
        </SummaryField>
      )}
      {data.investigators.length > 0 && (
        <div className="pt-4">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Investigators ({data.investigators.length})</h3>
          <div className="flex flex-wrap gap-2">
            {data.investigators.map((inv: any) => (
              <Badge
                key={inv.id}
                variant="outline"
                className="cursor-pointer hover:bg-accent"
                onClick={() => open({ type: "investigator", id: inv.id, resourceId: inv.resource_id || undefined, label: inv.name })}
              >
                {inv.name}
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  const complianceContent = (
    <div className="space-y-4 p-1">
      <div className="rounded-lg border border-border p-4 bg-muted/20">
        <div className="flex items-center gap-2 mb-3">
          <Shield className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Data Sharing Agreements</h3>
        </div>
        <p className="text-xs text-muted-foreground">
          Data sharing and use agreements between this institution and the consortium. Contact the institution's research office for details.
        </p>
        <Badge variant="outline" className="mt-2 text-xs">Status: Active Participant</Badge>
      </div>

      <div className="rounded-lg border border-border p-4 bg-muted/20">
        <div className="flex items-center gap-2 mb-3">
          <Scale className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">IRB & Compliance</h3>
        </div>
        <p className="text-xs text-muted-foreground">
          Institutional Review Board approvals and animal use protocols associated with grants at this institution.
        </p>
      </div>

      <div className="rounded-lg border border-border p-4 bg-muted/20">
        <div className="flex items-center gap-2 mb-3">
          <FileText className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold text-foreground">Open Source Licensing</h3>
        </div>
        <p className="text-xs text-muted-foreground">
          Institutional policies on open-source licensing for software and tools developed under consortium grants.
        </p>
      </div>
    </div>
  );

  const logoDomain = data.url ? new URL(data.url.startsWith("http") ? data.url : `https://${data.url}`).hostname : null;
  const logoUrl = logoDomain ? `https://logo.clearbit.com/${logoDomain}` : null;

  return (
    <ProvenanceScope table="organizations" id={id}>
    <div>
      <div className="px-6 pt-6 pb-4">
        <div className="flex items-center gap-3">
          {logoUrl ? (
            <img
              src={logoUrl}
              alt={`${data.name} logo`}
              className="w-10 h-10 rounded-full object-contain bg-white border border-border"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
                (e.target as HTMLImageElement).nextElementSibling?.classList.remove("hidden");
              }}
            />
          ) : null}
          <div className={`w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center ${logoUrl ? "hidden" : ""}`}>
            <Building className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-foreground">{data.name}</h2>
            <p className="text-sm text-muted-foreground">Institution</p>
          </div>
        </div>
      </div>
      <SummaryTabs tabs={[
        { id: "summary", label: "Summary", icon: <FileText className="h-3.5 w-3.5" />, content: summaryContent },
        { id: "compliance", label: "Compliance & Policy", icon: <Shield className="h-3.5 w-3.5" />, content: complianceContent },
      ]} />
    </div>
    </ProvenanceScope>
  );
}
