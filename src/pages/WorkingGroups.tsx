import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageMeta } from "@/components/PageMeta";
import { ExternalLink, BarChart3, Cpu, Scale, BookOpen, PawPrint, Users } from "lucide-react";
import { useEntitySummary } from "@/contexts/EntitySummaryContext";
import type { LucideIcon } from "lucide-react";

const WG_COLORS = [
  { bg: "bg-emerald-500/10", border: "border-emerald-500/30", accent: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400", icon: BarChart3 },
  { bg: "bg-violet-500/10", border: "border-violet-500/30", accent: "bg-violet-500", text: "text-violet-600 dark:text-violet-400", icon: Cpu },
  { bg: "bg-amber-500/10", border: "border-amber-500/30", accent: "bg-amber-500", text: "text-amber-600 dark:text-amber-400", icon: Scale },
  { bg: "bg-sky-500/10", border: "border-sky-500/30", accent: "bg-sky-500", text: "text-sky-600 dark:text-sky-400", icon: BookOpen },
  { bg: "bg-orange-500/10", border: "border-orange-500/30", accent: "bg-orange-500", text: "text-orange-600 dark:text-orange-400", icon: PawPrint },
];

interface WGData {
  name: string;
  shortName: string;
  entityId: string; // key into WorkingGroupSummary data
  description: string;
  chairs: { name: string; url: string | null }[];
}

const workingGroups: WGData[] = [
  {
    name: "WG-Analytics",
    shortName: "Analytics",
    entityId: "wg-analytics",
    description: "Developing shared analytical frameworks, pipelines, and computational methods for cross-project neural data analysis.",
    chairs: [
      { name: "Kristofer Bouchard", url: "https://biosciences.lbl.gov/profiles/kristofer-e-bouchard/" },
      { name: "Han Yi", url: "https://scholar.google.com/citations?user=MdrCoqAAAAAJ&hl=en" },
    ],
  },
  {
    name: "WG-Devices",
    shortName: "Devices",
    entityId: "wg-devices",
    description: "Compiling best practices for multimodal data acquisition, device integration, calibration, and synchronization across laboratories.",
    chairs: [
      { name: "Alireza Kazemi", url: "https://alirezakazemi.com" },
      { name: "Uros Topalovic", url: "https://scholar.google.com/citations?user=7Q02lPoAAAAJ&hl=en" },
    ],
  },
  {
    name: "WG-Ethics, Legal, and Social Issues (WG-ELSI)",
    shortName: "ELSI",
    entityId: "wg-elsi",
    description: "Addressing ethical, legal, and social implications of brain research, ensuring responsible innovation and data governance.",
    chairs: [
      { name: "Laura Cabrera", url: "https://rockethics.psu.edu/people/laura-cabrera/" },
    ],
  },
  {
    name: "WG-Standards",
    shortName: "Standards",
    entityId: "wg-standards",
    description: "Establishing and promoting adoption of data standards for novel sensors and multimodal data integration to facilitate FAIR sharing.",
    chairs: [
      { name: "Oliver Ruebel", url: "https://crd.lbl.gov/divisions/scidata/computational-biosciences/members/staff/oliver-ruebel-bio/" },
      { name: "Melissa Kline Struhl", url: "https://eccl.mit.edu/team-profiles/melissa-kline-struhl" },
    ],
  },
  {
    name: "WG-Cross-Species",
    shortName: "Cross-Species",
    entityId: "wg-cross-species",
    description: "Developing tools, methods, and models that use data from, and knowledge about, different species to derive general principles or mechanisms common to multiple species, with attention to both convergence and divergence.",
    chairs: [
      { name: "Steve Chang", url: null },
      { name: "Dan Sanes", url: null },
    ],
  },
];

const WorkingGroups = () => {
  const { open } = useEntitySummary();

  return (
    <div className="min-h-screen bg-background">
      <PageMeta title="Working Groups | BBQS" description="BBQS consortium working groups" />

      <div className="relative overflow-hidden border-b border-border">
        <div className="absolute inset-0 bg-gradient-to-br from-primary/8 via-transparent to-accent/5" />
        <div className="relative max-w-5xl mx-auto px-6 py-10">
          <div className="flex items-center gap-4">
            <div className="h-14 w-14 rounded-2xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center shadow-lg shadow-primary/10 border border-primary/10">
              <Users className="h-7 w-7 text-primary" />
            </div>
            <div>
              <h1 className="text-3xl font-bold text-foreground tracking-tight">Working Groups</h1>
              <p className="text-muted-foreground mt-1">Cross-organizational teams driving consortium goals</p>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-5xl mx-auto px-6 py-8 space-y-10">
        {/* Why Working Groups */}
        <section>
          <h2 className="text-xl font-semibold text-foreground mb-3">Why working groups?</h2>
          <p className="text-muted-foreground leading-relaxed">
            Working groups are essential to the success of a consortium project, as they bring together a range of experts from different organizations to focus on specific tasks. Each group works on a particular area of the project, collaborating to find solutions and share knowledge. By dividing the project into smaller, more manageable parts, working groups help ensure that work moves forward smoothly and deadlines are met.
          </p>
        </section>

        {/* Working Group Cards */}
        <section>
          <h2 className="text-xl font-semibold text-foreground mb-6">Active Working Groups</h2>
          <div className="grid gap-5 md:grid-cols-2">
            {workingGroups.map((wg, i) => {
              const color = WG_COLORS[i % WG_COLORS.length];
              const Icon = color.icon;
              return (
                <Card
                  key={wg.name}
                  className={`group overflow-hidden hover:shadow-lg transition-all duration-300 ${color.border} border cursor-pointer`}
                  onClick={() =>
                    open({
                      type: "working_group",
                      id: wg.entityId,
                      label: wg.name,
                    })
                  }
                >
                  <div className={`h-1.5 ${color.accent}`} />
                  <CardHeader className={`${color.bg} pb-3`}>
                    <div className="flex items-center gap-3">
                      <div className={`h-10 w-10 rounded-xl ${color.bg} flex items-center justify-center border ${color.border}`}>
                        <Icon className={`h-5 w-5 ${color.text}`} />
                      </div>
                      <div>
                        <CardTitle className="text-lg leading-tight">{wg.shortName}</CardTitle>
                        <p className={`text-xs font-medium ${color.text}`}>{wg.name}</p>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="pt-4 space-y-4">
                    <p className="text-sm text-muted-foreground leading-relaxed">{wg.description}</p>

                    <div>
                      <p className="text-xs font-semibold text-foreground/60 uppercase tracking-wider mb-2">Chairs</p>
                      <div className="flex flex-wrap gap-2">
                        {wg.chairs.map((member) =>
                          member.url ? (
                            <a
                              key={member.name}
                              href={member.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={`inline-flex items-center gap-1 text-sm ${color.text} hover:underline font-medium`}
                              onClick={(e) => e.stopPropagation()}
                            >
                              {member.name}
                              <ExternalLink className="w-3 h-3" />
                            </a>
                          ) : (
                            <span key={member.name} className="text-sm text-muted-foreground italic">
                              {member.name}
                            </span>
                          )
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
};

export default WorkingGroups;
