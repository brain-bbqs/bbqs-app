import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { supabase } from "@/integrations/supabase/client";
import { Skeleton } from "@/components/ui/skeleton";

export function FundingByYearWidget() {
  const { data = [], isLoading } = useQuery({
    queryKey: ["dashboard-funding-by-year"],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data } = await supabase
        .from("grants")
        .select("fiscal_year, award_amount")
        .not("fiscal_year", "is", null);
      const byYear = new Map<number, { amount: number; grants: number }>();
      (data ?? []).forEach((g) => {
        const y = g.fiscal_year as number;
        const prev = byYear.get(y) ?? { amount: 0, grants: 0 };
        byYear.set(y, { amount: prev.amount + (g.award_amount ?? 0), grants: prev.grants + 1 });
      });
      return [...byYear.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([year, v]) => ({ year: String(year), millions: +(v.amount / 1_000_000).toFixed(2), grants: v.grants }));
    },
  });

  if (isLoading) return <Skeleton className="h-56 w-full" />;
  if (!data.length) return <p className="text-sm text-muted-foreground">No funding years recorded yet.</p>;

  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
        <XAxis dataKey="year" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
        <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} unit="M" />
        <Tooltip
          cursor={{ fill: "hsl(var(--muted) / 0.4)" }}
          contentStyle={{
            background: "hsl(var(--popover))",
            border: "1px solid hsl(var(--border))",
            borderRadius: 8,
            color: "hsl(var(--popover-foreground))",
            fontSize: 12,
          }}
          formatter={(value: number, name) =>
            name === "millions" ? [`$${value}M`, "Awarded"] : [value, "Grants"]
          }
        />
        <Bar dataKey="millions" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}