import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { WIDGET_CATALOG, normalizeWidgets, DEFAULT_WIDGETS, WidgetSetting } from "@/data/dashboard-widgets";
import { ArrowDown, ArrowUp } from "lucide-react";
import { toast } from "sonner";

export function WorkingGroupDashboardDefaults() {
  const queryClient = useQueryClient();
  const [group, setGroup] = useState<string>("");
  const [draft, setDraft] = useState<WidgetSetting[]>(DEFAULT_WIDGETS);

  const { data: groups = [], isLoading: groupsLoading } = useQuery({
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

  const { data: defaults = [] } = useQuery({
    queryKey: ["wg-dashboard-defaults"],
    queryFn: async () => {
      const { data } = await supabase
        .from("working_group_dashboard_defaults")
        .select("working_group, widgets");
      return data ?? [];
    },
  });

  useEffect(() => {
    if (!group) return;
    const existing = defaults.find((d) => d.working_group === group);
    setDraft(existing ? normalizeWidgets(existing.widgets) : DEFAULT_WIDGETS);
  }, [group, defaults]);

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("working_group_dashboard_defaults")
        .upsert(
          [{ working_group: group, widgets: draft as unknown as Json }],
          { onConflict: "working_group" },
        );
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["wg-dashboard-defaults"] });
      toast.success(`Default layout saved for ${group}`);
    },
    onError: () => toast.error("Could not save the default layout"),
  });

  const move = (index: number, dir: -1 | 1) => {
    const next = [...draft];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setDraft(next);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Working group dashboard defaults</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Pick a working group and set the widgets its members see by default. Members can still
          customize their own dashboard afterwards.
        </p>

        {groupsLoading ? (
          <Skeleton className="h-10 w-64" />
        ) : (
          <Select value={group} onValueChange={setGroup}>
            <SelectTrigger className="w-72">
              <SelectValue placeholder="Select a working group" />
            </SelectTrigger>
            <SelectContent>
              {groups.map((g) => (
                <SelectItem key={g} value={g}>
                  {g}
                  {defaults.some((d) => d.working_group === g) ? " (configured)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {group && (
          <div className="space-y-2">
            {draft.map((w, i) => {
              const def = WIDGET_CATALOG.find((d) => d.key === w.key);
              if (!def) return null;
              return (
                <div key={w.key} className="flex items-center gap-3 rounded-md border border-border p-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground">{def.title}</p>
                    <p className="text-xs text-muted-foreground">{def.description}</p>
                  </div>
                  <Button variant="ghost" size="icon" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">
                    <ArrowUp className="h-4 w-4" />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => move(i, 1)} disabled={i === draft.length - 1} aria-label="Move down">
                    <ArrowDown className="h-4 w-4" />
                  </Button>
                  <Switch
                    checked={w.visible}
                    onCheckedChange={() => {
                      const next = [...draft];
                      next[i] = { ...next[i], visible: !next[i].visible };
                      setDraft(next);
                    }}
                    aria-label={`Show ${def.title}`}
                  />
                </div>
              );
            })}
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              Save default for {group}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}