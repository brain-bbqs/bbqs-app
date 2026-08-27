// Deploy test: 2026-03-18T02
import { Link } from "react-router-dom";
import HeroSection from "@/components/HeroSection";
import { PageMeta } from "@/components/PageMeta";
import { useUserTier } from "@/hooks/useUserTier";
import {
  Users,
  Bot,
  Database,
  FolderOpen,
  Scale,
  Wrench,
  ChevronRight,
  MessageSquare,
} from "lucide-react";

interface NavCard {
  title: string;
  description: string;
  icon: React.ElementType;
  color: string;
  /** adminOnly links are shown to tier 1 and 2 only, matching the sidebar's `adminOnly` flag. */
  links: { label: string; to: string; adminOnly?: boolean }[];
}

const navCards: NavCard[] = [
  {
    title: "Community",
    description: "Connect with researchers, join working groups, and find opportunities.",
    icon: Users,
    color: "hsl(210 70% 55%)",
    links: [
      { label: "People", to: "/investigators" },
      { label: "Working Groups", to: "/working-groups" },
      { label: "Announcements", to: "/announcements" },
      { label: "Job Board", to: "/jobs" },
      { label: "Calendar", to: "/calendar" },
      { label: "SFN 2025", to: "/sfn-2025" },
    ],
  },
  {
    title: "Assistants",
    description: "AI-powered tools for metadata, data archives, and paper extraction.",
    icon: Bot,
    color: "hsl(280 50% 60%)",
    links: [
      { label: "EMBER Assistant", to: "/dandi-assistant" },
    ],
  },
  {
    title: "Tools & Tutorials",
    description: "Software, datasets, benchmarks, resources, and learning materials.",
    icon: Database,
    color: "hsl(38 90% 50%)",
    links: [
      { label: "Resources", to: "/resources" },
      { label: "Tutorials", to: "/tutorials" },
    ],
  },
  {
    title: "Knowledge Base",
    description: "Explore projects, species, publications, and data provenance.",
    icon: FolderOpen,
    color: "hsl(140 60% 45%)",
    links: [
      { label: "Projects", to: "/projects" },
      { label: "Grants", to: "/grants" },
      { label: "RFA-NS-25-016 (NOFO)", to: "https://grants.nih.gov/grants/guide/rfa-files/RFA-NS-25-016.html" },
      { label: "Species", to: "/species" },
      { label: "Publications", to: "/publications" },
      { label: "Data Provenance", to: "/data-provenance" },
    ],
  },
  {
    title: "Legal & Policy",
    description: "Data sharing agreements and compliance information.",
    icon: Scale,
    color: "hsl(0 0% 45%)",
    links: [
      { label: "Data Sharing Policy", to: "/data-sharing-policy" },
    ],
  },
  {
    title: "Engineering",
    description: "Track development progress, suggest features, and view the roadmap.",
    icon: Wrench,
    color: "hsl(200 60% 50%)",
    links: [
      // The roadmap is internal. Suggest a Feature is not, and the card's own description already
      // promises it — without it this card is empty for everyone outside tier 1/2.
      { label: "Roadmap", to: "/roadmap", adminOnly: true },
      { label: "Suggest a Feature", to: "/suggest-feature" },
    ],
  },
];

const Index = () => {
  // Same gate as the sidebar: tier 1 and 2. isCurator is already true for admins.
  const { isCurator } = useUserTier();
  return (
    <div className="min-h-screen bg-background">
      <PageMeta
        title="Home"
        description="BBQS — Brain Behavior Quantification and Synchronization. An NIH-funded consortium advancing computational neuroscience through shared tools, data, and cross-species behavioral analysis."
      />

      {/* Hero */}
      <div className="relative h-[40vh] min-h-[320px]">
        <div className="absolute inset-0 z-0 bg-gradient-to-b from-primary/20 via-accent/10 to-background" />
        <div className="relative z-10 px-6 h-full flex items-center justify-center">
          <HeroSection />
        </div>
      </div>


      {/* BBQS Assistant CTA */}
      <section className="px-4 sm:px-6 mt-6">
        <div className="max-w-5xl mx-auto flex justify-center">
          <a
            href="https://agent.brain-bbqs.org"
            target="_blank"
            rel="noopener noreferrer"
            className="group inline-flex items-center gap-2.5 px-4 py-2 rounded-full border border-primary/30 bg-primary/5 hover:bg-primary/10 hover:border-primary/60 transition-all duration-150 text-sm"
          >
            <MessageSquare className="h-4 w-4 text-primary" />
            <span className="font-medium text-foreground">Talk to the BBQS Agent</span>
            <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/15 text-primary">
              Beta
            </span>
            <ChevronRight className="h-3.5 w-3.5 text-primary opacity-70 group-hover:translate-x-0.5 transition-transform" />
          </a>
        </div>
      </section>

      {/* Navigation Cards */}
      <main className="px-4 sm:px-6 pb-16 mt-8">
        <div className="max-w-5xl mx-auto grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {navCards
            .map((card) => ({ ...card, links: card.links.filter((l) => !l.adminOnly || isCurator) }))
            // A card whose every link was gated has nothing left to offer; hiding it beats showing
            // a heading with no way in.
            .filter((card) => card.links.length > 0)
            .map((card) => (
            <div
              key={card.title}
              className="group relative bg-card border border-border rounded-2xl p-6 hover:shadow-xl transition-all duration-200 hover:border-primary/30"
            >
              {/* Color accent bar */}
              <div
                className="absolute top-0 left-5 right-5 h-1.5 rounded-b-full opacity-70 group-hover:opacity-100 transition-opacity"
                style={{ backgroundColor: card.color }}
              />

              <div className="flex items-start gap-4 mt-3 mb-4">
                <div
                  className="p-3 rounded-xl shrink-0"
                  style={{ backgroundColor: `${card.color}20` }}
                >
                  <card.icon className="h-6 w-6" style={{ color: card.color }} />
                </div>
                <div>
                  <h2 className="font-bold text-foreground text-lg">{card.title}</h2>
                  <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
                    {card.description}
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                {card.links.map((link) => {
                  const isExternal = link.to.startsWith("http");
                  const sharedClassName = "inline-flex items-center gap-1.5 text-sm font-medium px-3.5 py-1.5 rounded-lg border transition-all duration-150 hover:shadow-md hover:-translate-y-0.5 hover:scale-[1.03] cursor-pointer";
                  const sharedStyle = {
                    borderColor: `${card.color}40`,
                    color: card.color,
                    backgroundColor: `${card.color}08`,
                  };
                  const handlers = {
                    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
                      e.currentTarget.style.backgroundColor = `${card.color}22`;
                      e.currentTarget.style.borderColor = card.color;
                      e.currentTarget.style.color = card.color;
                    },
                    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
                      e.currentTarget.style.backgroundColor = `${card.color}08`;
                      e.currentTarget.style.borderColor = `${card.color}40`;
                    },
                  };

                  return isExternal ? (
                    <a
                      key={link.to}
                      href={link.to}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={sharedClassName}
                      style={sharedStyle}
                      {...handlers}
                    >
                      {link.label}
                      <ChevronRight className="h-3.5 w-3.5 opacity-60" />
                    </a>
                  ) : (
                    <Link
                      key={link.to}
                      to={link.to}
                      className={sharedClassName}
                      style={sharedStyle}
                      {...handlers}
                    >
                      {link.label}
                      <ChevronRight className="h-3.5 w-3.5 opacity-60" />
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
};

export default Index;
