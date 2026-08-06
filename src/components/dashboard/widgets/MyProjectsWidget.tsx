import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

interface Props {
  investigatorId: string | null;
}

export function MyProjectsWidget({ investigatorId }: Props) {
  const { data: grants = [], isLoading } = useQuery({
    queryKey: ["dashboard-my-grants", investigatorId],
    enabled: !!investigatorId,
    queryFn: async () => {
      const { data: links } = await supabase
        .from("grant_investigators")
        .select("grant_id, role")
        .eq("investigator_id", investigatorId!);
      const ids = [...new Set((links ?? []).map((l) => l.grant_id).filter(Boolean))];
      if (!ids.length) return [];
      const { data } = await supabase
        .from("grants")
        .select("id, grant_number, title")
        .in("id", ids as string[]);
      const roleById = new Map((links ?? []).map((l) => [l.grant_id, l.role]));
      return (data ?? []).map((g) => ({ ...g, role: roleById.get(g.id) as string | undefined }));
    },
  });

  if (!investigatorId) {
    return (
      <p className="text-sm text-muted-foreground">
        Your account isn&apos;t linked to an investigator record yet, so no grants can be shown.
      </p>
    );
  }

  if (isLoading) return <Skeleton className="h-24 w-full" />;

  if (!grants.length) {
    return <p className="text-sm text-muted-foreground">No grants are linked to your record.</p>;
  }

  return (
    <ul className="space-y-2">
      {grants.map((g) => (
        <li key={g.id} className="flex items-start justify-between gap-3 rounded-md border border-border p-3">
          <div className="min-w-0">
            <Link
              to={`/projects/${g.grant_number}/profile`}
              className="text-sm font-medium text-foreground hover:underline line-clamp-2"
            >
              {g.title}
            </Link>
            <p className="text-xs text-muted-foreground mt-0.5">{g.grant_number}</p>
          </div>
          {g.role && <Badge variant="secondary" className="shrink-0 capitalize">{g.role.replace(/_/g, " ")}</Badge>}
        </li>
      ))}
    </ul>
  );
}