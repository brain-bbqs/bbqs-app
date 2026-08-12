import { useQuery } from "@tanstack/react-query";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { supabase } from "@/integrations/supabase/client";
import { Skeleton } from "@/components/ui/skeleton";

export function PublicationsTrendWidget() {
  const { data = [], isLoading } = useQuery({
    queryKey: ["dashboard-publications-trend"],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data } = await supabase.from("publications").select("year").not("year", "is", null);
      const byYear = new Map<number, number>();
      (data ?? []).forEach((p) => {
        const y = p.year as number;
        byYear.set(y, (byYear.get(y) ?? 0) + 1);
      });
      return [...byYear.entries()]
        .sort((a, b) => a[0] - b[0])
        .slice(-10)
        .map(([year, count]) => ({ year: String(year), count }));
    },
  });

  if (isLoading) return <Skeleton className="h-56 w-full" />;
  if (!data.length) return <p className="text-sm text-muted-foreground">No publication years recorded yet.</p>;

  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
        <defs>
          <linearGradient id="pubTrendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.5} />
            <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
        <XAxis dataKey="year" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
        <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} allowDecimals={false} />
        <Tooltip
          contentStyle={{
            background: "hsl(var(--popover))",
            border: "1px solid hsl(var(--border))",
            borderRadius: 8,
            color: "hsl(var(--popover-foreground))",
            fontSize: 12,
          }}
          formatter={(value: number) => [value, "Publications"]}
        />
        <Area type="monotone" dataKey="count" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#pubTrendFill)" />
      </AreaChart>
    </ResponsiveContainer>
  );
}