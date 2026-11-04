import { SummaryField } from "../SummaryField";
import { SummaryTabs } from "../SummaryTabs";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, FileText, Users, Mail, Link as LinkIcon, FolderOpen } from "lucide-react";

export interface WorkingGroupData {
  name: string;
  shortName: string;
  purpose: string;
  deliverables: string[];
  charterUrl?: string;
  resourcesUrl?: string;
  additionalLinks?: { label: string; url: string; external?: boolean }[];
  chairs: { name: string; url: string | null }[];
  contactChairs?: string;
  mailingList?: string;
}

// Static data for all working groups
const WORKING_GROUPS: Record<string, WorkingGroupData> = {
  "wg-analytics": {
    name: "WG-Analytics",
    shortName: "Analytics",
    purpose:
      "The Working Group on Data Analytics and AI aims to establish and promote the sharing, refinement, and adoption of analytics and AI standards for novel sensors and multimodal data integration within the BBQS community. Specifically, the Working Group will strive towards achieving FAIR (Findable, Accessible, Interoperable, Reusable) sharing and reuse of AI and analytics derived results from brain-behavior data.",
    deliverables: [
      "Evaluate and curate relevant ML/AI models and platforms",
      "Assist with aggregating datasets, models, and other ML/AI resources from both within and outside the BBQS consortium",
    ],
    charterUrl:
      "https://docs.google.com/document/d/1WXW1P3-OZguuQq_aXYoFgNDhJrU5ZO8jfyb22STL2io/edit?usp=sharing",
    resourcesUrl: "/resources?search=WG-Analytics",
    chairs: [
      { name: "Kristofer Bouchard", url: "https://biosciences.lbl.gov/profiles/kristofer-e-bouchard/" },
      { name: "Han Yi", url: "https://scholar.google.com/citations?user=MdrCoqAAAAAJ&hl=en" },
    ],
    contactChairs: "wg-chairs@brain-bbqs.org",
    mailingList: "wg-analytics@brain-bbqs.org",
  },
  "wg-devices": {
    name: "WG-Devices",
    shortName: "Devices",
    purpose:
      "The Device WG aims to compile a comprehensive protocol document to define best practices for multimodal data acquisition and device integration. Specifically, this working group will document and generalize challenges and solutions related to hardware, sensors, calibration, and synchronization processes, with an emphasis on compiling and sharing solutions across laboratories.",
    deliverables: [
      "Schedule recurring monthly meetings starting in September to finalize and approve the group's charter",
      "Document the inventory of devices used in BBQS projects",
      "Collaborate with the Standards and Analytics Working Groups to develop protocols and standards for post-recording procedures",
      "Develop a shared repository of protocols for device setup, synchronization, and troubleshooting",
      "Publish a best-practices and tools resource paper",
      "Standardize reporting guidelines for synchronization processes",
      "Promote adoption of the BBQS framework across the research community",
    ],
    resourcesUrl: "/resources?search=WG-Devices",
    chairs: [
      { name: "Alireza Kazemi", url: "https://alirezakazemi.com" },
      { name: "Uros Topalovic", url: "https://scholar.google.com/citations?user=7Q02lPoAAAAJ&hl=en" },
    ],
    mailingList: "wg-devices@brain-bbqs.org",
  },
  "wg-elsi": {
    name: "WG-Ethics, Legal, and Social Issues (WG-ELSI)",
    shortName: "ELSI",
    purpose:
      "The Working Group on Ethical, Legal, and Societal Implications (ELSI) aims to identify and address ELSI issues that emerge from the work in the consortium projects, as well as to help establish and promote the adoption of the data sharing governance framework for the BBQS community. This effort is essential to facilitate FAIR (Findable, Accessible, Interoperable, Reusable) sharing and reuse of brain behavior data and metadata, ensuring consistency, interoperability, and integration of data and metadata to support scientific research and collaboration in an ethical and responsible manner.",
    deliverables: [
      "Meet with the ELSI Scientific Advisory Board to identify areas to prioritize",
      "Conduct workshops on key ELSI topics to discuss with the larger BBQS community",
      "Conduct research on ethical issues to identify and create recommendations for the consortium and the broader community",
      "Share these resources with BBQS consortium members",
    ],
    charterUrl:
      "https://docs.google.com/document/d/1GnGAAeUUrkO5dvk_P3zXjjF0HiiIBGyy/edit?usp=sharing&ouid=117099683135763927535&rtpof=true&sd=true",
    resourcesUrl: "/resources?search=WG-ELSI",
    chairs: [
      { name: "Laura Cabrera", url: "https://rockethics.psu.edu/people/laura-cabrera/" },
    ],
    contactChairs: "wg-chairs@brain-bbqs.org",
    mailingList: "wg-elsi@brain-bbqs.org",
  },
  "wg-standards": {
    name: "WG-Standards",
    shortName: "Standards",
    purpose:
      "The Working Group on Data Standards aims to establish and promote the adoption of data standards for novel sensors and multimodal data integration within the BBQS community. This effort is essential to facilitate FAIR (Findable, Accessible, Interoperable, Reusable) sharing and reuse of brain behavior data, ensuring consistency, interoperability, and integration of data and metadata to support scientific research and collaboration.",
    deliverables: [
      "Inventory Behavior Data Standards: Identify and review existing data standards, publish an organized catalog accessible via the BBQS web portal",
      "Develop Guidelines and Best Practices: Identify fault lines between standards, formulate use-case driven minimum information requirements for BBQS data",
      "Coordinate and Promote Enhancement of Standards: Facilitate community working groups, collaborate with standards bodies, create crosswalks to link metadata fields to ontologies",
      "Facilitate Adoption and Use of BBQS Standards: Create online tutorials, develop curated controlled term sets, develop mechanisms for annotating existing standards",
    ],
    charterUrl:
      "https://docs.google.com/document/d/1WIVI8HZF4-IfZZ61UjCZx2K7NyYx_CaTuIHmhFo7eYw/edit?usp=sharing",
    resourcesUrl: "/resources?search=WG-Standards",
    additionalLinks: [
      { label: "Standards Guidelines", url: "https://docs.google.com/document/d/1vIJ01La9G76FfGywS3IbG4o1GR4qquS31MoJ2B4_4os/edit?usp=sharing", external: true },
      { label: "The Ecosystem of Standards in Neuroscience (SfN 2025 Poster)", url: "https://zenodo.org/records/18333008", external: true },
    ],
    chairs: [
      { name: "Oliver Ruebel", url: "https://crd.lbl.gov/divisions/scidata/computational-biosciences/members/staff/oliver-ruebel-bio/" },
      { name: "Melissa Kline Struhl", url: "https://eccl.mit.edu/team-profiles/melissa-kline-struhl" },
    ],
    contactChairs: "wg-chairs@brain-bbqs.org",
    mailingList: "wg-standards@brain-bbqs.org",
  },
  "wg-cross-species": {
    name: "WG-Cross-Species",
    shortName: "Cross-Species",
    purpose:
      "The Cross-Species Working Group develops tools, methods, and models that use data from, and knowledge about, different species to derive general principles or mechanisms common to multiple species, with attention to both convergence and divergence. It meets bimonthly on the first Wednesday of the month, 3:30-4:30 PM ET, and collaborates with the other working groups to bring a cross-species lens to consortium-wide progress.",
    deliverables: [
      "Study the evolution of behavior across species",
      "Build methods to infer cross-species latent variables from multimodal data",
      "Identify biological signatures of social behavior",
      "Develop models accounting for the different timescales of processes that govern social behavior across species",
      "A cross-species, hypothesis-generating knowledge graph indexing studies by level of analysis and functional domain, so researchers can compare findings across species and spot gaps that point to new experiments",
    ],
    resourcesUrl: "/resources?search=WG-Cross-Species",
    chairs: [
      { name: "Steve Chang", url: null },
      { name: "Dan Sanes", url: null },
    ],
    contactChairs: "wg-chairs@brain-bbqs.org",
    mailingList: "wg-cross-species@brain-bbqs.org",
  },
};

export function getWorkingGroupData(id: string): WorkingGroupData | null {
  return WORKING_GROUPS[id] || null;
}

export function WorkingGroupSummary({ id }: { id: string }) {
  const data = getWorkingGroupData(id);

  if (!data) {
    return <p className="p-6 text-muted-foreground">Working group not found.</p>;
  }

  const summaryContent = (
    <div className="space-y-1">
      {/* Purpose */}
      <SummaryField label="Purpose">
        <p className="text-sm leading-relaxed">{data.purpose}</p>
      </SummaryField>

      {/* Deliverables */}
      {data.deliverables.length > 0 && (
        <SummaryField label="Deliverables">
          <ul className="text-sm space-y-1.5 list-disc list-inside text-foreground">
            {data.deliverables.map((d, i) => (
              <li key={i} className="leading-relaxed">{d}</li>
            ))}
          </ul>
        </SummaryField>
      )}

      {/* Chairs */}
      <SummaryField label="Chairs">
        <div className="flex flex-wrap gap-2">
          {data.chairs.map((chair) =>
            chair.url ? (
              <a
                key={chair.name}
                href={chair.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm text-primary hover:underline font-medium"
              >
                {chair.name}
                <ExternalLink className="h-3 w-3" />
              </a>
            ) : (
              <span key={chair.name} className="text-sm text-muted-foreground italic">
                {chair.name}
              </span>
            )
          )}
        </div>
      </SummaryField>

      {/* Documentation & Resources */}
      {(data.charterUrl || data.resourcesUrl || data.additionalLinks?.length) && (
        <div className="pt-4">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            Documentation & Resources
          </h3>
          <div className="space-y-2">
            {data.charterUrl && (
              <a
                href={data.charterUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-sm text-primary hover:underline font-medium rounded-lg border border-border p-3 hover:bg-accent/50 transition-colors"
              >
                <FileText className="h-4 w-4" />
                Working Group Charter
                <ExternalLink className="h-3 w-3 ml-auto" />
              </a>
            )}
            {data.resourcesUrl && (
              <a
                href={data.resourcesUrl}
                className="flex items-center gap-2 text-sm text-primary hover:underline font-medium rounded-lg border border-border p-3 hover:bg-accent/50 transition-colors"
              >
                <FolderOpen className="h-4 w-4" />
                View Resources
                <LinkIcon className="h-3 w-3 ml-auto" />
              </a>
            )}
            {data.additionalLinks?.map((link) => (
              <a
                key={link.url}
                href={link.url}
                target={link.external ? "_blank" : undefined}
                rel={link.external ? "noopener noreferrer" : undefined}
                className="flex items-center gap-2 text-sm text-primary hover:underline font-medium rounded-lg border border-border p-3 hover:bg-accent/50 transition-colors"
              >
                <LinkIcon className="h-4 w-4" />
                {link.label}
                {link.external && <ExternalLink className="h-3 w-3 ml-auto" />}
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Contact */}
      {(data.contactChairs || data.mailingList) && (
        <div className="pt-4">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            Connect with the Group
          </h3>
          <div className="space-y-2">
            {data.contactChairs && (
              <div className="flex items-center gap-2 text-sm">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Chairs:</span>
                <a href={`mailto:${data.contactChairs}`} className="text-primary hover:underline">
                  {data.contactChairs}
                </a>
              </div>
            )}
            {data.mailingList && (
              <div className="flex items-center gap-2 text-sm">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <span className="text-muted-foreground">Mailing List:</span>
                <a href={`mailto:${data.mailingList}`} className="text-primary hover:underline">
                  {data.mailingList}
                </a>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div>
      <div className="px-6 pt-6 pb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
            <Users className="h-5 w-5 text-primary" />
          </div>
          <div className="flex-1">
            <h2 className="text-xl font-bold text-foreground">{data.name}</h2>
            <p className="text-sm text-muted-foreground">Working Group</p>
          </div>
        </div>
      </div>
      <SummaryTabs
        tabs={[
          {
            id: "summary",
            label: "Summary",
            icon: <FileText className="h-3.5 w-3.5" />,
            content: summaryContent,
          },
        ]}
      />
    </div>
  );
}
