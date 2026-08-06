import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PageMeta } from "@/components/PageMeta";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/contexts/AuthContext";
import { useProfile } from "@/hooks/useProfile";
import { useDashboardConfig } from "@/hooks/useDashboardConfig";
import { WIDGET_CATALOG, getWidgetDef, WidgetSetting } from "@/data/dashboard-widgets";
import { MyProjectsWidget } from "@/components/dashboard/widgets/MyProjectsWidget";
import { DashboardHero } from "@/components/dashboard/DashboardHero";
import { WorkingGroupMembersWidget } from "@/components/dashboard/widgets/WorkingGroupMembersWidget";
import { WorkingGroupFeedWidget } from "@/components/dashboard/widgets/WorkingGroupFeedWidget";
import { ArrowDown, ArrowUp, LayoutDashboard, RotateCcw, Settings2 } from "lucide-react";
import { toast } from "sonner";

export default function Dashboard() {
  const { user, loading: authLoading } = useAuth();
  const { profile } = useProfile();
  const { widgets, workingGroups, investigatorId, isLoading, save, reset } = useDashboardConfig();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<WidgetSetting[]>(widgets);

  useEffect(() => {
    if (!editing) setDraft(widgets);
  }, [widgets, editing]);

  if (!authLoading && !user) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-16 text-center">
        <PageMeta title="Dashboard" description="Your personalized BBQS dashboard." />
        <h1 className="text-2xl font-bold text-foreground mb-2">Sign in to see your dashboard</h1>
        <p className="text-sm text-muted-foreground mb-6">
          Your dashboard shows the projects and working group activity tied to your account.
        </p>
        <Button asChild><Link to="/auth">Sign in</Link></Button>
      </div>
    );
  }

  const move = (index: number, dir: -1 | 1) => {
    const next = [...draft];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setDraft(next);
  };

  const toggle = (index: number) => {
    const next = [...draft];
    next[index] = { ...next[index], visible: !next[index].visible };
    setDraft(next);
  };

  const onSave = async () => {
    try {
      await save.mutateAsync(draft);
      setEditing(false);
      toast.success("Dashboard layout saved");
    } catch {
      toast.error("Could not save your layout");
    }
  };

  const onReset = async () => {
    try {
      await reset.mutateAsync();
      setEditing(false);
      toast.success("Reset to your working group default");
    } catch {
      toast.error("Could not reset your layout");
    }
  };

  const renderWidget = (key: string) => {
    switch (key) {
      case "my_projects":
        return <MyProjectsWidget investigatorId={investigatorId} />;
      case "working_group_members":
        return <WorkingGroupMembersWidget workingGroups={workingGroups} investigatorId={investigatorId} />;
      case "working_group_feed":
        return <WorkingGroupFeedWidget workingGroups={workingGroups} />;
      default:
        return null;
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <PageMeta title="Dashboard" description="Your personalized BBQS dashboard of projects and working group activity." />

      <DashboardHero
        investigatorId={investigatorId}
        workingGroups={workingGroups}
        fullName={profile?.full_name}
        email={profile?.email ?? user?.email}
      />

      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
          <LayoutDashboard className="h-5 w-5 text-primary" />
          My dashboard
        </h2>
        <div className="flex gap-2">
          {editing && (
            <Button variant="ghost" onClick={onReset} disabled={reset.isPending}>
              <RotateCcw className="mr-2 h-4 w-4" /> Reset
            </Button>
          )}
          <Button variant={editing ? "default" : "outline"} onClick={editing ? onSave : () => setEditing(true)} disabled={save.isPending}>
            <Settings2 className="mr-2 h-4 w-4" />
            {editing ? "Save layout" : "Customize"}
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : editing ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Choose your widgets</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {draft.map((w, i) => {
              const def = getWidgetDef(w.key);
              if (!def) return null;
              const Icon = def.icon;
              return (
                <div key={w.key} className="flex items-center gap-3 rounded-md border border-border p-3">
                  <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
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
                  <Switch checked={w.visible} onCheckedChange={() => toggle(i)} aria-label={`Show ${def.title}`} />
                </div>
              );
            })}
            <p className="text-xs text-muted-foreground pt-2">
              {WIDGET_CATALOG.length} widgets available. Resetting restores your working group default.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {draft.filter((w) => w.visible).map((w) => {
            const def = getWidgetDef(w.key);
            if (!def) return null;
            const Icon = def.icon;
            return (
              <Card key={w.key}>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Icon className="h-4 w-4 text-primary" />
                    {def.title}
                  </CardTitle>
                </CardHeader>
                <CardContent>{renderWidget(w.key)}</CardContent>
              </Card>
            );
          })}
          {draft.every((w) => !w.visible) && (
            <p className="text-sm text-muted-foreground">
              All widgets are hidden. Use Customize to add some back.
            </p>
          )}
        </div>
      )}
    </div>
  );
}