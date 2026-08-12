import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Skeleton } from "@/components/ui/skeleton";

const TILES = [
  { table: "grants", label: "Projects & grants", to: "/projects" },
  { table: "investigators", label: "Investigators", to: "/investigators" },
  { table: "publications", label: "Publications", to: "/publications" },
  { table: "species", label: "Species", to: "/species" },
  { table: "resources", label: "Resources", to: "/resources" },
] as const;

export function ConsortiumOverviewWidget() {
  const { data, isLoading } = useQuery({
    queryKey: ["consortium-overview-counts"],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const entries = await Promise.all(
        TILES.map(async (t) => {
          const { count } = await supabase
            .from(t.table)
            .select("id", { count: "exact", head: true });
          return [t.table, count ?? 0] as const;
        }),
      );
      return Object.fromEntries(entries) as Record<string, number>;
    },
  });

  if (isLoading) return <Skeleton className="h-24 w-full" />;

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {TILES.map((t) => (
        <Link
          key={t.table}
          to={t.to}
          className="rounded-lg border border-border bg-card p-3 transition-colors hover:border-primary/50"
        >
          <p className="text-2xl font-bold text-foreground tabular-nums">
            {(data?.[t.table] ?? 0).toLocaleString()}
          </p>
          <p className="text-xs text-muted-foreground">{t.label}</p>
        </Link>
      ))}
    </div>
  );
}