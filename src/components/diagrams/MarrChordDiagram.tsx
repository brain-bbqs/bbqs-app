import { useEffect, useRef, useState, useCallback } from "react";
import * as d3 from "d3";
import { buildConnectionMatrix, type MarrProject } from "@/data/marr-projects";
import { useMarrProjects } from "@/hooks/useMarrProjects";
import { cn } from "@/lib/utils";

type MarrLevel = "computational" | "algorithmic" | "implementation" | "all";

interface TooltipData {
  x: number;
  y: number;
  source: MarrProject;
  target: MarrProject;
  shared: { level: string; features: string[] }[];
}

export function MarrChordDiagram() {
  const { projects, loading } = useMarrProjects();
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [level, setLevel] = useState<MarrLevel>("all");
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [dimensions, setDimensions] = useState({ width: 700, height: 700 });

  // Responsive sizing
  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        const w = Math.min(containerRef.current.clientWidth, 650);
        setDimensions({ width: w, height: w });
      }
    };
    updateSize();
    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, []);

  const drawChord = useCallback(() => {
    if (!svgRef.current || projects.length === 0) return;

    const { width, height } = dimensions;
    const padding = 120;
    const svgWidth = width + padding * 2;
    const svgHeight = height + padding * 2;
    const outerRadius = Math.min(width, height) * 0.36;
    const innerRadius = outerRadius - 18;

    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const matrix = buildConnectionMatrix(projects, level);

    const augmented = matrix.map((row, i) =>
      row.map((val, j) => (i === j ? projects[i][level === "all" ? "algorithmic" : level].length * 0.5 : val))
    );

    const chord = d3.chord().padAngle(0.06).sortSubgroups(d3.descending);
    const chords = chord(augmented);

    const arc = d3.arc<d3.ChordGroup>()
      .innerRadius(innerRadius)
      .outerRadius(outerRadius);

    const ribbon = d3.ribbon<d3.Chord, d3.ChordSubgroup>()
      .radius(innerRadius);

    const g = svg
      .attr("viewBox", `0 0 ${svgWidth} ${svgHeight}`)
      .append("g")
      .attr("transform", `translate(${svgWidth / 2},${svgHeight / 2})`);

    const group = g
      .append("g")
      .selectAll("g")
      .data(chords.groups)
      .join("g");

    group
      .append("path")
      .attr("d", arc as any)
      .attr("fill", (d) => projects[d.index].color)
      .attr("stroke", "hsl(var(--border))")
      .attr("stroke-width", 0.5)
      .style("cursor", "pointer")
      .style("opacity", (d) =>
        hoveredIndex === null ? 0.85 : d.index === hoveredIndex ? 1 : 0.2
      )
      .on("mouseenter", (_, d) => setHoveredIndex(d.index))
      .on("mouseleave", () => setHoveredIndex(null));

    group
      .append("text")
      .each((d: any) => {
        d.angle = (d.startAngle + d.endAngle) / 2;
      })
      .attr("dy", "0.35em")
      .attr("transform", (d: any) => {
        const angle = d.angle;
        const rotate = (angle * 180) / Math.PI - 90;
        const flip = angle > Math.PI;
        return `rotate(${rotate}) translate(${outerRadius + 8}) ${flip ? "rotate(180)" : ""}`;
      })
      .attr("text-anchor", (d: any) => (d.angle > Math.PI ? "end" : "start"))
      .attr("fill", "hsl(var(--foreground))")
      .attr("font-size", Math.max(10, outerRadius * 0.065))
      .style("opacity", (d) =>
        hoveredIndex === null ? 1 : d.index === hoveredIndex ? 1 : 0.15
      )
      .text((d) => projects[d.index].shortName);

    g.append("g")
      .attr("fill-opacity", 0.4)
      .selectAll("path")
      .data(chords.filter(d => d.source.index !== d.target.index))
      .join("path")
      .attr("d", ribbon as any)
      .attr("fill", (d) => projects[d.source.index].color)
      .attr("stroke", "none")
      .style("cursor", "pointer")
      .style("mix-blend-mode", "normal")
      .style("opacity", (d) => {
        if (hoveredIndex === null) return 0.25;
        return d.source.index === hoveredIndex || d.target.index === hoveredIndex ? 0.85 : 0.03;
      })
      .on("mouseenter", function (event, d) {
        const src = projects[d.source.index];
        const tgt = projects[d.target.index];
        const shared = getSharedFeatures(src, tgt);
        const rect = svgRef.current!.getBoundingClientRect();
        setTooltip({
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
          source: src,
          target: tgt,
          shared,
        });
        d3.select(this).style("opacity", 0.9).attr("stroke", "hsl(var(--foreground))").attr("stroke-width", 0.5);
      })
      .on("mouseleave", function () {
        setTooltip(null);
        d3.select(this).style("opacity", hoveredIndex === null ? 0.25 : 0.03).attr("stroke", "none");
      });
  }, [projects, level, hoveredIndex, dimensions]);

  useEffect(() => {
    drawChord();
  }, [drawChord]);

  if (loading) {
    return <div className="flex items-center justify-center h-40 text-muted-foreground">Loading...</div>;
  }

  return (
    <div ref={containerRef} className="relative w-full">
      <div className="flex flex-wrap justify-center gap-2 mb-4">
        {(["all", "computational", "algorithmic", "implementation"] as MarrLevel[]).map((l) => (
          <button
            key={l}
            onClick={() => setLevel(l)}
            className={cn(
              "px-3 py-1.5 rounded-full text-xs font-medium transition-colors",
              level === l
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-secondary-foreground hover:bg-secondary/80"
            )}
          >
            {l === "all" ? "All Levels" : l.charAt(0).toUpperCase() + l.slice(1)}
          </button>
        ))}
      </div>

      <div className="relative">
        <svg ref={svgRef} className="w-full" style={{ maxHeight: "800px" }} />

        {tooltip && (
          <div
            className="absolute z-50 pointer-events-none bg-popover border border-border rounded-lg shadow-lg p-3 max-w-xs text-xs"
            style={{
              left: Math.min(tooltip.x + 10, dimensions.width - 250),
              top: tooltip.y - 10,
            }}
          >
            <div className="font-semibold text-foreground mb-1">
              {tooltip.source.shortName} ↔ {tooltip.target.shortName}
            </div>
            {tooltip.shared.map((s) => (
              <div key={s.level} className="mt-1.5">
                <span className="text-muted-foreground font-medium uppercase tracking-wider" style={{ fontSize: "10px" }}>
                  {s.level}
                </span>
                <div className="flex flex-wrap gap-1 mt-0.5">
                  {s.features.map((f) => (
                    <span key={f} className="bg-secondary px-1.5 py-0.5 rounded text-foreground" style={{ fontSize: "10px" }}>
                      {f}
                    </span>
                  ))}
                </div>
              </div>
            ))}
            {tooltip.shared.length === 0 && (
              <p className="text-muted-foreground mt-1">No shared features at this level</p>
            )}
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-col sm:flex-row justify-center gap-4 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-full bg-blue-400" />
          <span><strong>Computational:</strong> What problem is solved</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-full bg-green-400" />
          <span><strong>Algorithmic:</strong> What approach is used</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-full bg-orange-400" />
          <span><strong>Implementation:</strong> What tools are used</span>
        </div>
      </div>
    </div>
  );
}

function getSharedFeatures(
  a: MarrProject,
  b: MarrProject
): { level: string; features: string[] }[] {
  const results: { level: string; features: string[] }[] = [];
  const normalize = (s: string) => s.toLowerCase().trim();

  for (const level of ["computational", "algorithmic", "implementation"] as const) {
    const setA = new Set(a[level].map(normalize));
    const shared = b[level].filter((f) => setA.has(normalize(f)));
    if (shared.length > 0) {
      results.push({ level, features: shared });
    }
  }

  return results;
}
