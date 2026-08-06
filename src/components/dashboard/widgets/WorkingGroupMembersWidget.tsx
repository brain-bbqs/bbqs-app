import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

interface Props {
  workingGroups: string[];
  investigatorId: string | null;
}

export function WorkingGroupMembersWidget({ workingGroups, investigatorId }: Props) {
  const { data: members = [], isLoading } = useQuery({
    queryKey: ["dashboard-wg-members", workingGroups.join("|")],
    enabled: workingGroups.length > 0,
    queryFn: async () => {
      const { data } = await supabase
        .from("investigators")
        .select("id, name, institution, working_groups")
        .overlaps("working_groups", workingGroups)
        .order("name")
        .limit(60);
      return data ?? [];
    },
  });

  if (!workingGroups.length) {
    return (
      <p className="text-sm text-muted-foreground">
        You aren&apos;t assigned to a working group yet. Ask an admin to add you.
      </p>
    );
  }

  if (isLoading) return <Skeleton className="h-24 w-full" />;

  const others = members.filter((m) => m.id !== investigatorId);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {workingGroups.map((g) => (
          <Badge key={g} variant="outline">{g}</Badge>
        ))}
      </div>
      {others.length === 0 ? (
        <p className="text-sm text-muted-foreground">No other members listed for your groups.</p>
      ) : (
        <ul className="divide-y divide-border max-h-72 overflow-y-auto">
          {others.map((m) => (
            <li key={m.id} className="py-2">
              <p className="text-sm font-medium text-foreground">{m.name}</p>
              {m.institution && <p className="text-xs text-muted-foreground">{m.institution}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}