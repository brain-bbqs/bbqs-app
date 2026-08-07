import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { WIDGET_CATALOG, WidgetSetting, DEFAULT_WIDGETS } from "@/data/dashboard-widgets";
import { ArrowDown, ArrowUp, Sparkles } from "lucide-react";

interface Props {
  initialGroups: string[];
  saving?: boolean;
  onComplete: (widgets: WidgetSetting[], groups: string[]) => void;
  onSkip?: () => void;
  title?: string;
  description?: string;
  submitLabel?: string;
}

export function DashboardSetup({
  initialGroups,
  saving,
  onComplete,
  onSkip,
  title = "Set up your dashboard",
  description = "Pick the working groups you follow and the widgets you want to see. You can change this anytime from your dashboard.",
  submitLabel = "Save & open my dashboard",
}: Props) {
  const [groups, setGroups] = useState<string[]>(initialGroups);
  const [widgets, setWidgets] = useState<WidgetSetting[]>(DEFAULT_WIDGETS);

  const { data: allGroups = [], isLoading } = useQuery({
    queryKey: ["all-working-groups"],
    queryFn: async () => {
      const { data } = await supabase
        .from("investigators")
        .select("working_groups")
        .not("working_groups", "is", null);
      const set = new Set<string>();
      (data ?? []).forEach((r) => (r.working_groups ?? []).forEach((g) => g && set.add(g)));
      return [...set].sort();
    },
  });

  const toggleGroup = (g: string) =>
    setGroups((prev) => (prev.includes(g) ? prev.filter((x) => x !== g) : [...prev, g]));

  const move = (index: number, dir: -1 | 1) => {
    const next = [...widgets];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setWidgets(next);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-foreground">Working groups you follow</h3>
          {isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {allGroups.map((g) => (
                <label
                  key={g}
                  className="flex cursor-pointer items-center gap-3 rounded-md border border-border p-3 text-sm"
                >
                  <Checkbox checked={groups.includes(g)} onCheckedChange={() => toggleGroup(g)} />
                  <span className="min-w-0 flex-1 text-foreground">{g}</span>
                  {initialGroups.includes(g) && (
                    <span className="text-xs text-muted-foreground">member</span>
                  )}
                </label>
              ))}
              {!allGroups.length && (
                <p className="text-sm text-muted-foreground">No working groups available yet.</p>
              )}
            </div>
          )}
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">Widgets on your dashboard</h3>
          {widgets.map((w, i) => {
            const def = WIDGET_CATALOG.find((d) => d.key === w.key);
            if (!def) return null;
            const Icon = def.icon;
            return (
              <div key={w.key} className="flex items-center gap-3 rounded-md border border-border p-3">
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">{def.title}</p>
                  <p className="text-xs text-muted-foreground">{def.description}</p>
                </div>
                <Button variant="ghost" size="icon" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => move(i, 1)}
                  disabled={i === widgets.length - 1}
                  aria-label="Move down"
                >
                  <ArrowDown className="h-4 w-4" />
                </Button>
                <Switch
                  checked={w.visible}
                  onCheckedChange={() => {
                    const next = [...widgets];
                    next[i] = { ...next[i], visible: !next[i].visible };
                    setWidgets(next);
                  }}
                  aria-label={`Show ${def.title}`}
                />
              </div>
            );
          })}
        </section>

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => onComplete(widgets, groups)} disabled={saving}>
            {submitLabel}
          </Button>
          {onSkip && (
            <Button variant="ghost" onClick={onSkip} disabled={saving}>
              Skip for now
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
