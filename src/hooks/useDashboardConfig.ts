import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import type { Json } from "@/integrations/supabase/types";
import { normalizeWidgets, DEFAULT_WIDGETS, WidgetSetting } from "@/data/dashboard-widgets";

export interface DashboardIdentity {
  investigatorId: string | null;
  workingGroups: string[];
}

export interface DashboardPrefs {
  widgets: WidgetSetting[] | null;
  workingGroups: string[] | null;
  onboarded: boolean;
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
  const memberGroups = identity?.workingGroups ?? [];

  const { data: prefs, isLoading } = useQuery<DashboardPrefs & { widgets: WidgetSetting[] }>({
    queryKey: ["dashboard-layout", user?.id, memberGroups.join("|")],
    enabled: !!user && !identityLoading,
    queryFn: async () => {
      const { data: own } = await supabase
        .from("user_dashboard_layouts")
        .select("widgets, working_groups, onboarded_at")
        .eq("user_id", user!.id)
        .maybeSingle();

      const savedGroups = (own?.working_groups ?? []).filter(Boolean);
      const onboarded = !!own?.onboarded_at;

      if (own?.widgets && Array.isArray(own.widgets) && own.widgets.length) {
        return {
          widgets: normalizeWidgets(own.widgets),
          workingGroups: savedGroups.length ? savedGroups : memberGroups,
          onboarded,
        };
      }
      if (memberGroups.length) {
        const { data: defaults } = await supabase
          .from("working_group_dashboard_defaults")
          .select("working_group, widgets")
          .in("working_group", memberGroups);
        const match = defaults?.find((d) => Array.isArray(d.widgets) && (d.widgets as unknown[]).length);
        if (match) {
          return {
            widgets: normalizeWidgets(match.widgets),
            workingGroups: savedGroups.length ? savedGroups : memberGroups,
            onboarded,
          };
        }
      }
      return {
        widgets: DEFAULT_WIDGETS,
        workingGroups: savedGroups.length ? savedGroups : memberGroups,
        onboarded,
      };
    },
  });

  const save = useMutation({
    mutationFn: async (input: WidgetSetting[] | { widgets: WidgetSetting[]; workingGroups?: string[]; onboarded?: boolean }) => {
      const next = Array.isArray(input) ? input : input.widgets;
      const row: Record<string, unknown> = {
        user_id: user!.id,
        widgets: next as unknown as Json,
      };
      if (!Array.isArray(input) && input.workingGroups) row.working_groups = input.workingGroups;
      if (!Array.isArray(input) && input.onboarded) row.onboarded_at = new Date().toISOString();
      const { error } = await supabase
        .from("user_dashboard_layouts")
        .upsert([row as never], { onConflict: "user_id" });
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
    widgets: prefs?.widgets ?? DEFAULT_WIDGETS,
    workingGroups: prefs?.workingGroups ?? memberGroups,
    memberGroups,
    onboarded: prefs?.onboarded ?? false,
    investigatorId: identity?.investigatorId ?? null,
    isLoading: identityLoading || isLoading,
    save,
    reset,
  };
}