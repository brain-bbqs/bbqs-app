import ReactMarkdown from "react-markdown";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { PillarBadge } from "./PillarBadge";
import { countOpenTasks, type RoadmapTheme } from "@/data/roadmap-themes";
import { ExternalLink } from "lucide-react";

interface Props {
  theme: RoadmapTheme | null;
  onOpenChange: (open: boolean) => void;
  openIssuesCount?: number;
}

export function ThemeDrawer({ theme, onOpenChange, openIssuesCount = 0 }: Props) {
  const open = theme !== null;
  const { done, total } = theme ? countOpenTasks(theme.tasks) : { done: 0, total: 0 };
  const githubEditUrl = theme
    ? `https://github.com/brain-bbqs/bbqs-app/tree/main/${theme.githubPath}`
    : "#";
  const githubIssuesUrl = theme
    ? `https://github.com/brain-bbqs/bbqs-app/issues?q=is%3Aissue+label%3A${encodeURIComponent(theme.githubLabel)}`
    : "#";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-2xl overflow-y-auto">
        {theme && (
          <>
            <SheetHeader className="text-left space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <PillarBadge pillar={theme.pillar} />
                <Badge variant="secondary" className="text-[10px]">#{theme.number}</Badge>
                {total > 0 && (
                  <Badge variant="outline" className="text-[10px]">
                    {done} / {total} tasks done
                  </Badge>
                )}
                {openIssuesCount > 0 && (
                  <Badge variant="outline" className="text-[10px]">
                    {openIssuesCount} open GitHub issue{openIssuesCount === 1 ? "" : "s"}
                  </Badge>
                )}
              </div>
              <SheetTitle className="text-xl">{theme.title}</SheetTitle>
              <SheetDescription>{theme.summary}</SheetDescription>
              <div className="flex flex-wrap gap-3 text-xs">
                <a
                  href={githubEditUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  Edit on GitHub <ExternalLink className="w-3 h-3" />
                </a>
                <a
                  href={githubIssuesUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  View labeled issues <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </SheetHeader>

            <Tabs defaultValue="spec" className="mt-6">
              <TabsList>
                <TabsTrigger value="spec">Spec</TabsTrigger>
                <TabsTrigger value="plan">Plan</TabsTrigger>
                <TabsTrigger value="tasks">Tasks</TabsTrigger>
              </TabsList>
              <TabsContent value="spec">
                <article className="prose prose-sm dark:prose-invert max-w-none">
                  <ReactMarkdown>{theme.spec}</ReactMarkdown>
                </article>
              </TabsContent>
              <TabsContent value="plan">
                <article className="prose prose-sm dark:prose-invert max-w-none">
                  <ReactMarkdown>{theme.plan}</ReactMarkdown>
                </article>
              </TabsContent>
              <TabsContent value="tasks">
                <article className="prose prose-sm dark:prose-invert max-w-none">
                  <ReactMarkdown>{theme.tasks}</ReactMarkdown>
                </article>
              </TabsContent>
            </Tabs>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}