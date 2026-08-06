import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { normalizeWidgets, DEFAULT_WIDGETS, WidgetSetting } from "@/data/dashboard-widgets";

export interface DashboardIdentity {
  investigatorId: string | null;
  workingGroups: string[];
}

/** Resolve the signed-in user's investigator record + working groups. */
export function useDashboardIdentity() {
  const { user } = useAuth();
  return useQuery<DashboardIdentity>({
    queryKey: ["dashboard-identity", user?.id, user?.email],
    enabled: !!user,
    staleTime: 60_000,
    queryFn: async () => {
      let { data } = await supabase
        .from("investigators")
        .select("id, working_groups")
        .eq("user_id", user!.id)
        .limit(1)
        .maybeSingle();
      if (!data && user?.email) {
        ({ data } = await supabase
          .from("investigators")
          .select("id, working_groups")
          .ilike("email", user.email)
          .limit(1)
          .maybeSingle());
      }
      return {
        investigatorId: data?.id ?? null,
        workingGroups: (data?.working_groups ?? []).filter(Boolean),
      };
    },
  });
}

/**
 * Layout resolution order:
 *   1. the user's saved layout
 *   2. the admin-set default for their first working group
 *   3. the built-in default (all widgets visible)
 */
export function useDashboardConfig() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: identity, isLoading: identityLoading } = useDashboardIdentity();
  const groups = identity?.workingGroups ?? [];

  const { data: widgets, isLoading } = useQuery<WidgetSetting[]>({
    queryKey: ["dashboard-layout", user?.id, groups.join("|")],
    enabled: !!user && !identityLoading,
    queryFn: async () => {
      const { data: own } = await supabase
        .from("user_dashboard_layouts")
        .select("widgets")
        .eq("user_id", user!.id)
        .maybeSingle();
      if (own?.widgets && Array.isArray(own.widgets) && own.widgets.length) {
        return normalizeWidgets(own.widgets);
      }
      if (groups.length) {
        const { data: defaults } = await supabase
          .from("working_group_dashboard_defaults")
          .select("working_group, widgets")
          .in("working_group", groups);
        const match = defaults?.find((d) => Array.isArray(d.widgets) && (d.widgets as unknown[]).length);
        if (match) return normalizeWidgets(match.widgets);
      }
      return DEFAULT_WIDGETS;
    },
  });

  const save = useMutation({
    mutationFn: async (next: WidgetSetting[]) => {
      const { error } = await supabase
        .from("user_dashboard_layouts")
        .upsert({ user_id: user!.id, widgets: next }, { onConflict: "user_id" });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dashboard-layout"] });
    },
  });

  const reset = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("user_dashboard_layouts")
        .delete()
        .eq("user_id", user!.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["dashboard-layout"] });
    },
  });

  return {
    widgets: widgets ?? DEFAULT_WIDGETS,
    workingGroups: groups,
    investigatorId: identity?.investigatorId ?? null,
    isLoading: identityLoading || isLoading,
    save,
    reset,
  };
}