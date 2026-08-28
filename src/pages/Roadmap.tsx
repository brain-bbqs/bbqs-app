import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import {
  ExternalLink,
  RefreshCw,
  Circle,
  CheckCircle2,
  Bug,
  Sparkles,
  ListTodo,
  ChevronDown,
  Search,
  Milestone as MilestoneIcon,
  Rocket,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ThemeCard } from "@/components/roadmap/ThemeCard";
import { ThemeDrawer } from "@/components/roadmap/ThemeDrawer";

import { RoadmapTimeline } from "@/components/roadmap/RoadmapTimeline";
import {
  ROADMAP_THEMES,
  STATUS_LABEL,
  type RoadmapTheme,
  type ThemeStatus,
} from "@/data/roadmap-themes";

interface RoadmapMilestone {
  id: number;
  number: number;
  title: string;
  description: string | null;
  state: string;
  dueOn: string | null;
  createdAt: string;
  url: string;
  openIssues: number;
  closedIssues: number;
  progress: number;
}

interface RoadmapIssue {
  id: number;
  number: number;
  title: string;
  state: string;
  url: string;
  labels: Array<{ name: string; color: string }>;
  issueType: string | null;
  milestoneNumber: number | null;
  milestoneTitle: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

interface RoadmapData {
  milestones: RoadmapMilestone[];
  issues: RoadmapIssue[];
}

type IssueType = "all" | "bug" | "feature" | "task";

const TYPE_CONFIG: Record<
  Exclude<IssueType, "all">,
  {
    label: string;
    icon: typeof Bug;
    color: string;
    bgColor: string;
  }
> = {
  bug: {
    label: "Bugs",
    icon: Bug,
    color: "text-destructive",
    bgColor: "bg-destructive/10",
  },
  feature: {
    label: "Features",
    icon: Sparkles,
    color: "text-primary",
    bgColor: "bg-primary/10",
  },
  task: {
    label: "Tasks",
    icon: ListTodo,
    color: "text-amber-500",
    bgColor: "bg-amber-500/10",
  },
};

async function fetchRoadmap(): Promise<RoadmapData> {
  const { data, error } = await supabase.functions.invoke("github-roadmap");

  if (error) {
    throw new Error(error.message || "Failed to fetch roadmap");
  }

  return {
    milestones: data.milestones || [],
    issues: data.issues || [],
  };
}

function getIssueType(issue: RoadmapIssue): Exclude<IssueType, "all"> {
  // First check the issueType field from GitHub's issue type
  if (issue.issueType) {
    const t = issue.issueType.toLowerCase();
    if (t === "bug") return "bug";
    if (t === "feature" || t === "enhancement") return "feature";
    if (t === "task") return "task";
  }

  // Fallback to labels
  const labelNames = (issue.labels || []).map((l) => l.name.toLowerCase());
  if (labelNames.includes("bug")) return "bug";
  if (labelNames.includes("feature") || labelNames.includes("enhancement"))
    return "feature";

  return "task";
}

function isTypeLabel(labelName: string): boolean {
  const n = labelName.toLowerCase();
  return ["bug", "feature", "enhancement", "task"].includes(n);
}

function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const normalized = hex.replace("#", "").trim();
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return null;
  const r = parseInt(normalized.slice(0, 2), 16) / 255;
  const g = parseInt(normalized.slice(2, 4), 16) / 255;
  const b = parseInt(normalized.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;

  let h = 0;
  if (delta !== 0) {
    if (max === r) h = ((g - b) / delta) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }

  const l = (max + min) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));
  return {
    h: Math.round(h),
    s: Math.round(s * 100),
    l: Math.round(l * 100),
  };
}

function formatQuarter(dateString: string | null): string {
  if (!dateString) return "TBD";
  const date = new Date(dateString);
  const quarter = Math.floor(date.getMonth() / 3) + 1;
  return `Q${quarter} ${date.getFullYear()}`;
}

// Milestone Timeline Component
function MilestoneTimeline({
  milestones,
}: {
  milestones: RoadmapMilestone[];
}) {
  if (milestones.length === 0) return null;

  // Calculate overall progress
  const totalOpen = milestones.reduce((sum, m) => sum + m.openIssues, 0);
  const totalClosed = milestones.reduce((sum, m) => sum + m.closedIssues, 0);
  const overallProgress =
    totalOpen + totalClosed > 0
      ? Math.round((totalClosed / (totalOpen + totalClosed)) * 100)
      : 0;

  return (
    <div className="mb-8 rounded-xl border bg-card p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10">
            <Rocket className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-semibold text-lg">Journey to Self-Automation</h2>
            <p className="text-sm text-muted-foreground">
              {overallProgress}% complete · {totalClosed} of {totalOpen + totalClosed} tasks done
            </p>
          </div>
        </div>
      </div>

      {/* Overall Progress Bar */}
      <div className="mb-6">
        <Progress value={overallProgress} className="h-2" />
      </div>

      {/* Timeline */}
      <div className="relative">
        {/* Timeline line */}
        <div className="absolute top-4 left-0 right-0 h-0.5 bg-border" />

        {/* Milestone points */}
        <div className="relative flex justify-between">
          {milestones.map((milestone, index) => {
            const isComplete = milestone.state === "closed" || milestone.progress === 100;
            const isCurrent = !isComplete && index === milestones.findIndex(m => m.state !== "closed" && m.progress < 100);

            return (
              <a
                key={milestone.id}
                href={milestone.url}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  "group flex flex-col items-center text-center transition-colors",
                  "hover:text-primary"
                )}
                style={{ flex: 1 }}
              >
                {/* Node */}
                <div
                  className={cn(
                    "relative z-10 w-8 h-8 rounded-full border-2 flex items-center justify-center transition-colors",
                    isComplete
                      ? "bg-primary border-primary text-primary-foreground"
                      : isCurrent
                      ? "bg-background border-primary text-primary"
                      : "bg-background border-muted-foreground/30 text-muted-foreground"
                  )}
                >
                  {isComplete ? (
                    <CheckCircle2 className="w-4 h-4" />
                  ) : (
                    <MilestoneIcon className="w-4 h-4" />
                  )}
                </div>

                {/* Label */}
                <div className="mt-3 max-w-[120px]">
                  <p
                    className={cn(
                      "text-sm font-medium truncate",
                      isComplete && "text-muted-foreground",
                      isCurrent && "text-primary"
                    )}
                  >
                    {milestone.title}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {formatQuarter(milestone.dueOn)}
                  </p>
                  <Badge
                    variant="secondary"
                    className={cn(
                      "mt-1 text-xs",
                      isCurrent && "bg-primary/10 text-primary"
                    )}
                  >
                    {milestone.progress}%
                  </Badge>
                </div>
              </a>
            );
          })}

          {/* Final goal */}
          <div className="flex flex-col items-center text-center" style={{ flex: 1 }}>
            <div className="relative z-10 w-8 h-8 rounded-full border-2 border-dashed border-muted-foreground/50 flex items-center justify-center bg-background">
              <Rocket className="w-4 h-4 text-muted-foreground" />
            </div>
            <div className="mt-3 max-w-[120px]">
              <p className="text-sm font-medium text-muted-foreground">
                Self-Automation
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">Ultimate Goal</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function IssueRow({ issue }: { issue: RoadmapIssue }) {
  const isClosed = issue.state === "closed";
  const labels = (issue.labels || []).filter((l) => !isTypeLabel(l.name));

  return (
    <a
      href={issue.url}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex items-center gap-3 py-2.5 px-3 hover:bg-muted/50 transition-colors rounded-md"
    >
      <div
        className={cn(
          "flex-shrink-0",
          isClosed ? "text-muted-foreground" : "text-primary"
        )}
      >
        {isClosed ? (
          <CheckCircle2 className="w-4 h-4" />
        ) : (
          <Circle className="w-4 h-4" />
        )}
      </div>

      <span
        className={cn(
          "flex-1 text-sm",
          isClosed && "text-muted-foreground line-through"
        )}
      >
        {issue.title}
      </span>

      <div className="hidden sm:flex gap-1.5">
        {labels.slice(0, 2).map((label) => {
          const hsl = hexToHsl(label.color);
          const borderColor = hsl
            ? `hsl(${hsl.h} ${hsl.s}% ${hsl.l}% / 0.9)`
            : undefined;
          const foregroundColor = hsl
            ? `hsl(${hsl.h} ${hsl.s}% ${hsl.l}% / 0.95)`
            : undefined;
          const bgColor = hsl
            ? `hsl(${hsl.h} ${hsl.s}% ${hsl.l}% / 0.12)`
            : undefined;
          return (
            <Badge
              key={label.name}
              variant="outline"
              className="text-xs py-0"
              style={{
                borderColor,
                color: foregroundColor,
                backgroundColor: bgColor,
              }}
            >
              {label.name}
            </Badge>
          );
        })}
      </div>

      <span className="text-xs text-muted-foreground">#{issue.number}</span>
      <ExternalLink className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
    </a>
  );
}

function TypeSection({
  type,
  issues,
  defaultOpen = true,
  allowEmpty = false,
}: {
  type: Exclude<IssueType, "all">;
  issues: RoadmapIssue[];
  defaultOpen?: boolean;
  allowEmpty?: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const config = TYPE_CONFIG[type];
  const Icon = config.icon;

  const openCount = issues.filter((i) => i.state === "open").length;
  const closedCount = issues.filter((i) => i.state === "closed").length;

  if (issues.length === 0 && !allowEmpty) return null;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger asChild>
        <button
          className={cn(
            "w-full flex items-center justify-between p-4 rounded-lg border transition-colors",
            "hover:bg-muted/30",
            isOpen && "rounded-b-none border-b-0"
          )}
        >
          <div className="flex items-center gap-3">
            <div className={cn("p-2 rounded-md", config.bgColor)}>
              <Icon className={cn("w-5 h-5", config.color)} />
            </div>
            <div className="text-left">
              <h3 className="font-semibold">{config.label}</h3>
              <p className="text-xs text-muted-foreground">
                {openCount} open · {closedCount} closed
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{issues.length}</Badge>
            <ChevronDown
              className={cn(
                "w-4 h-4 text-muted-foreground transition-transform",
                isOpen && "rotate-180"
              )}
            />
          </div>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border border-t-0 rounded-b-lg p-2 space-y-0.5">
          {issues.length === 0 ? (
            <div className="py-6 px-3 text-sm text-muted-foreground">
              No issues of type{" "}
              <span className="font-medium text-foreground">{config.label}</span>{" "}
              yet.
            </div>
          ) : (
            issues.map((issue) => <IssueRow key={issue.id} issue={issue} />)
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export default function Roadmap() {
  const [filter, setFilter] = useState<IssueType>("all");
  const [search, setSearch] = useState("");
  const [activeTheme, setActiveTheme] = useState<RoadmapTheme | null>(null);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["roadmap"],
    queryFn: fetchRoadmap,
    staleTime: 5 * 60 * 1000,
  });

  const milestones = data?.milestones || [];
  const issues = data?.issues || [];

  const visibleIssues = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return issues;
    return issues.filter((i) => {
      const inTitle = i.title?.toLowerCase().includes(q);
      const inNumber =
        `#${i.number}`.includes(q) || `${i.number}`.includes(q);
      const inLabels = (i.labels || []).some((l) =>
        l.name.toLowerCase().includes(q)
      );
      return inTitle || inNumber || inLabels;
    });
  }, [issues, search]);

  const groupedIssues = {
    bug: visibleIssues.filter((i) => getIssueType(i) === "bug"),
    feature: visibleIssues.filter((i) => getIssueType(i) === "feature"),
    task: visibleIssues.filter((i) => getIssueType(i) === "task"),
  };

  const openCount = visibleIssues.filter((i) => i.state === "open").length;
  const closedCount = visibleIssues.filter((i) => i.state === "closed").length;

  const typesToShow =
    filter === "all"
      ? (["feature", "bug", "task"] as const)
      : ([filter] as const);

  const openIssuesByLabel = useMemo(() => {
    const map = new Map<string, number>();
    for (const issue of issues) {
      if (issue.state !== "open") continue;
      for (const l of issue.labels || []) {
        map.set(l.name.toLowerCase(), (map.get(l.name.toLowerCase()) ?? 0) + 1);
      }
    }
    return map;
  }, [issues]);

  const themesByStatus: Record<ThemeStatus, typeof ROADMAP_THEMES> = {
    now: ROADMAP_THEMES.filter((t) => t.status === "now"),
    next: ROADMAP_THEMES.filter((t) => t.status === "next"),
    later: ROADMAP_THEMES.filter((t) => t.status === "later"),
  };

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-8 max-w-6xl">
        {/* Header */}
        <div className="mb-6">
          <div className="flex items-start justify-between mb-2 gap-4 flex-wrap">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <h1 className="text-2xl font-bold">Development Roadmap</h1>
                <Badge variant="outline" className="text-[10px] uppercase tracking-wide border-primary/40 text-primary">
                  Public · Open source
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground max-w-2xl">
                What we're building, in the open. Every theme below has a public Spec, Plan,
                and Tasks file — PRs from anyone welcome.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => refetch()}
                disabled={isFetching}
              >
                <RefreshCw
                  className={cn("w-4 h-4 mr-2", isFetching && "animate-spin")}
                />
                Refresh
              </Button>
              <a
                href="https://github.com/brain-bbqs/website/issues"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Button variant="outline" size="sm">
                  <ExternalLink className="w-4 h-4 mr-2" />
                  GitHub
                </Button>
              </a>
            </div>
          </div>
        </div>

        <Tabs defaultValue="themes" className="mb-6">
          <TabsList>
            <TabsTrigger value="themes">Themes</TabsTrigger>
            <TabsTrigger value="execution">Execution (GitHub)</TabsTrigger>
          </TabsList>

          <TabsContent value="themes" className="mt-6 space-y-8">
            <RoadmapTimeline
              openIssuesByLabel={openIssuesByLabel}
              onOpenTheme={(t) => setActiveTheme(t)}
            />
          </TabsContent>

          <TabsContent value="execution" className="mt-6">
            {isLoading && (
              <div className="space-y-4 animate-pulse">
                <div className="rounded-xl border p-6">
                  <div className="h-6 bg-muted rounded w-48 mb-4" />
                  <div className="h-2 bg-muted rounded w-full mb-6" />
                </div>
              </div>
            )}
            {error && (
              <div className="text-center py-12 rounded-lg border">
                <p className="text-destructive mb-4">
                  {error instanceof Error ? error.message : "Failed to load roadmap"}
                </p>
                <Button variant="outline" onClick={() => refetch()}>
                  Try again
                </Button>
              </div>
            )}
            {data && (
              <>
                <MilestoneTimeline milestones={milestones} />
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-4 text-sm text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                      <Circle className="w-3 h-3 text-primary" />
                      {openCount} Open
                    </span>
                    <span className="flex items-center gap-1.5">
                      <CheckCircle2 className="w-3 h-3 text-muted-foreground" />
                      {closedCount} Closed
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="relative w-[220px] hidden sm:block">
                      <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                      <Input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search issues…"
                        className="pl-9"
                      />
                    </div>
                    <Select value={filter} onValueChange={(v) => setFilter(v as IssueType)}>
                      <SelectTrigger className="w-[140px]">
                        <SelectValue placeholder="Filter by type" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All Types</SelectItem>
                        <SelectItem value="feature">Features</SelectItem>
                        <SelectItem value="bug">Bugs</SelectItem>
                        <SelectItem value="task">Tasks</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-4">
                  {typesToShow.map((type) => (
                    <TypeSection
                      key={type}
                      type={type}
                      issues={groupedIssues[type]}
                      defaultOpen={filter !== "all" || type === "feature"}
                      allowEmpty={filter === "all" || filter === type}
                    />
                  ))}
                  {visibleIssues.length === 0 && (
                    <div className="text-center py-12 rounded-lg border">
                      <ListTodo className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
                      <h2 className="text-xl font-semibold mb-2">No matching issues</h2>
                      <p className="text-muted-foreground">Try clearing your search or adjusting the type filter.</p>
                    </div>
                  )}
                </div>
              </>
            )}
          </TabsContent>
        </Tabs>

        <ThemeDrawer
          theme={activeTheme}
          onOpenChange={(o) => !o && setActiveTheme(null)}
          openIssuesCount={
            activeTheme
              ? openIssuesByLabel.get(activeTheme.githubLabel.toLowerCase()) ?? 0
              : 0
          }
        />

      </div>
    </div>
  );
}
