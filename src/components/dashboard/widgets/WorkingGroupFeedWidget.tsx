import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Skeleton } from "@/components/ui/skeleton";
import { format } from "date-fns";

export function WorkingGroupFeedWidget({ workingGroups }: { workingGroups: string[] }) {
  const { data: items = [], isLoading } = useQuery({
    queryKey: ["dashboard-wg-feed"],
    queryFn: async () => {
      const { data } = await supabase
        .from("announcements")
        .select("id, title, content, link, created_at")
        .order("created_at", { ascending: false })
        .limit(30);
      return data ?? [];
    },
  });

  if (isLoading) return <Skeleton className="h-24 w-full" />;

  const terms = workingGroups
    .map((g) => g.replace(/^WG-/i, "").toLowerCase())
    .filter((t) => t.length > 2);

  const scored = items
    .map((a) => {
      const hay = `${a.title} ${a.content ?? ""}`.toLowerCase();
      return { ...a, relevant: terms.some((t) => hay.includes(t)) };
    })
    .sort((a, b) => Number(b.relevant) - Number(a.relevant))
    .slice(0, 8);

  if (!scored.length) {
    return <p className="text-sm text-muted-foreground">No announcements yet.</p>;
  }

  return (
    <ul className="space-y-3 max-h-80 overflow-y-auto">
      {scored.map((a) => (
        <li key={a.id} className="rounded-md border border-border p-3">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-medium text-foreground">{a.title}</p>
            {a.relevant && (
              <span className="shrink-0 text-[10px] uppercase tracking-wide text-accent-foreground bg-accent px-1.5 py-0.5 rounded">
                Your group
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{a.content}</p>
          <p className="text-[11px] text-muted-foreground mt-1">
            {format(new Date(a.created_at), "MMM d, yyyy")}
          </p>
        </li>
      ))}
    </ul>
  );
}