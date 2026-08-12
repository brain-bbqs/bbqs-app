import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { supabase } from "@/integrations/supabase/client";
import { Skeleton } from "@/components/ui/skeleton";

export function SpeciesCoverageWidget() {
  const { data = [], isLoading } = useQuery({
    queryKey: ["dashboard-species-coverage"],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data } = await supabase.from("species").select("taxonomy_class");
      const counts = new Map<string, number>();
      (data ?? []).forEach((s) => {
        const k = (s.taxonomy_class || "Unclassified").trim();
        counts.set(k, (counts.get(k) ?? 0) + 1);
      });
      return [...counts.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8);
    },
  });

  if (isLoading) return <Skeleton className="h-56 w-full" />;
  if (!data.length) return <p className="text-sm text-muted-foreground">No species recorded yet.</p>;

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 12, left: 8, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
        <XAxis type="number" stroke="hsl(var(--muted-foreground))" fontSize={12} allowDecimals={false} tickLine={false} axisLine={false} />
        <YAxis type="category" dataKey="name" width={92} stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
        <Tooltip
          cursor={{ fill: "hsl(var(--muted) / 0.4)" }}
          contentStyle={{
            background: "hsl(var(--popover))",
            border: "1px solid hsl(var(--border))",
            borderRadius: 8,
            color: "hsl(var(--popover-foreground))",
            fontSize: 12,
          }}
          formatter={(value: number) => [value, "Species"]}
        />
        <Bar dataKey="count" fill="hsl(var(--accent))" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}