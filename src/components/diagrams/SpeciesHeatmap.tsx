import { useMemo, useState } from "react";
import { type MarrProject } from "@/data/marr-projects";
import { useMarrProjects } from "@/hooks/useMarrProjects";
import { cn } from "@/lib/utils";

interface SharedDetail {
  level: string;
  features: string[];
}

interface CellData {
  rowSpecies: string;
  colSpecies: string;
  value: number;
  details: SharedDetail[];
}

export function SpeciesHeatmap() {
  const { projects, loading } = useMarrProjects();
  const [hoveredCell, setHoveredCell] = useState<CellData | null>(null);
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 });

  const { speciesList, matrix } = useMemo(() => {
    const speciesMap = new Map<string, MarrProject[]>();
    for (const p of projects) {
      const existing = speciesMap.get(p.species) || [];
      existing.push(p);
      speciesMap.set(p.species, existing);
    }
    const speciesList = Array.from(speciesMap.keys()).sort();

    const matrix: CellData[][] = speciesList.map((row) =>
      speciesList.map((col) => {
        const rowProjects = speciesMap.get(row) || [];
        const colProjects = speciesMap.get(col) || [];
        const details: SharedDetail[] = [];
        let total = 0;

        for (const level of ["computational", "algorithmic", "implementation"] as const) {
          const rowFeatures = new Set(rowProjects.flatMap((p) => p[level].map((s) => s.toLowerCase())));
          const colFeatures = colProjects.flatMap((p) => p[level]);
          const shared = colFeatures.filter((f) => rowFeatures.has(f.toLowerCase()));
          const unique = [...new Set(shared)];
          if (unique.length > 0) {
            details.push({ level, features: unique });
            total += unique.length;
          }
        }

        return { rowSpecies: row, colSpecies: col, value: total, details };
      })
    );

    return { speciesList, matrix };
  }, [projects]);

  const maxVal = useMemo(
    () => Math.max(...matrix.flat().filter((c) => c.rowSpecies !== c.colSpecies).map((c) => c.value), 1),
    [matrix]
  );

  if (loading) {
    return <div className="flex items-center justify-center h-40 text-muted-foreground">Loading...</div>;
  }

  return (
    <div className="relative">
      <div className="overflow-x-auto">
        <table className="border-collapse">
          <thead>
            <tr>
              <th className="p-2 text-xs text-muted-foreground font-medium sticky left-0 bg-background z-10" />
              {speciesList.map((s) => (
                <th
                  key={s}
                  className="p-1 text-[10px] text-muted-foreground font-medium whitespace-nowrap"
                  style={{ writingMode: "vertical-rl", transform: "rotate(180deg)", minHeight: 80 }}
                >
                  {s}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {speciesList.map((row, ri) => (
              <tr key={row}>
                <td className="p-2 text-xs text-muted-foreground font-medium whitespace-nowrap sticky left-0 bg-background z-10">
                  {row}
                </td>
                {speciesList.map((col, ci) => {
                  const cell = matrix[ri][ci];
                  const isDiag = ri === ci;
                  const intensity = isDiag ? 1 : cell.value / maxVal;

                  return (
                    <td
                      key={col}
                      className={cn(
                        "border border-border/30 transition-all duration-150 cursor-pointer",
                        isDiag ? "bg-primary/20" : ""
                      )}
                      style={{
                        width: 32,
                        height: 32,
                        backgroundColor: isDiag
                          ? undefined
                          : cell.value > 0
                          ? `hsl(var(--primary) / ${Math.max(0.08, intensity * 0.7)})`
                          : undefined,
                      }}
                      onMouseEnter={(e) => {
                        setHoveredCell(cell);
                        setTooltipPos({ x: e.clientX, y: e.clientY });
                      }}
                      onMouseMove={(e) => setTooltipPos({ x: e.clientX, y: e.clientY })}
                      onMouseLeave={() => setHoveredCell(null)}
                    >
                      {cell.value > 0 && !isDiag && (
                        <span className="flex items-center justify-center text-[10px] font-medium text-foreground/70">
                          {cell.value}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {hoveredCell && hoveredCell.rowSpecies !== hoveredCell.colSpecies && (
        <div
          className="fixed z-[9999] pointer-events-none bg-popover/95 backdrop-blur-md border border-border rounded-xl shadow-xl p-3 max-w-xs text-xs"
          style={{ left: tooltipPos.x + 14, top: tooltipPos.y - 10 }}
        >
          <div className="font-semibold text-foreground mb-1.5">
            {hoveredCell.rowSpecies} ↔ {hoveredCell.colSpecies}
          </div>
          {hoveredCell.details.length > 0 ? (
            hoveredCell.details.map((d) => (
              <div key={d.level} className="mt-1">
                <span className="text-muted-foreground uppercase tracking-wider font-medium" style={{ fontSize: "9px" }}>
                  {d.level}
                </span>
                <div className="flex flex-wrap gap-1 mt-0.5">
                  {d.features.map((f) => (
                    <span key={f} className="bg-secondary px-1.5 py-0.5 rounded text-foreground" style={{ fontSize: "10px" }}>
                      {f}
                    </span>
                  ))}
                </div>
              </div>
            ))
          ) : (
            <p className="text-muted-foreground">No shared features</p>
          )}
        </div>
      )}
    </div>
  );
}
