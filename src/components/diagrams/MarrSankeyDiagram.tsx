import { useEffect, useRef, useState, useMemo } from "react";
import * as d3 from "d3";
import { sankey, sankeyLinkHorizontal, SankeyNode, SankeyLink } from "d3-sankey";
import { useMarrProjects } from "@/hooks/useMarrProjects";
import type { MarrProject } from "@/data/marr-projects";

interface SNode {
  name: string;
  category: "level" | "project" | "species";
  color: string;
}

interface SLink {
  source: number;
  target: number;
  value: number;
}

const LEVEL_COLORS: Record<string, string> = {
  Computational: "#64b5f6",
  Algorithmic: "#81c784",
  Implementation: "#ffb74d",
};

function buildSankeyData(projects: MarrProject[]) {
  const nodes: SNode[] = [];
  const links: SLink[] = [];

  const speciesSet = new Map<string, number>();
  const speciesColors = [
    "#4fc3f7", "#f06292", "#ce93d8", "#ffb74d", "#81c784",
    "#a1887f", "#4db6ac", "#dce775", "#80deea", "#c5e1a5",
    "#b39ddb", "#ef9a9a", "#e57373", "#ffe082", "#80cbc4",
  ];

  projects.forEach((p) => {
    if (!speciesSet.has(p.species)) {
      const idx = nodes.length;
      const colorIdx = speciesSet.size % speciesColors.length;
      nodes.push({ name: p.species, category: "species", color: speciesColors[colorIdx] });
      speciesSet.set(p.species, idx);
    }
  });

  const projectStartIdx = nodes.length;
  projects.forEach((p) =>
    nodes.push({ name: p.shortName, category: "project", color: p.color })
  );

  const levelStartIdx = nodes.length;
  const levels = ["Computational", "Algorithmic", "Implementation"];
  levels.forEach((l) => nodes.push({ name: l, category: "level", color: LEVEL_COLORS[l] }));

  projects.forEach((p, pi) => {
    const projIdx = projectStartIdx + pi;
    const speciesIdx = speciesSet.get(p.species)!;
    const totalFeatures = p.computational.length + p.algorithmic.length + p.implementation.length;
    links.push({ source: speciesIdx, target: projIdx, value: totalFeatures });

    const levelKeys = ["computational", "algorithmic", "implementation"] as const;
    levelKeys.forEach((lk, li) => {
      const count = p[lk].length;
      if (count > 0) {
        links.push({ source: projIdx, target: levelStartIdx + li, value: count });
      }
    });
  });

  return { nodes, links };
}

export function MarrSankeyDiagram() {
  const { projects, loading } = useMarrProjects();
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; content: string } | null>(null);
  const [dimensions, setDimensions] = useState({ width: 900, height: 700 });

  const data = useMemo(() => buildSankeyData(projects), [projects]);

  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        const w = containerRef.current.clientWidth;
        setDimensions({ width: Math.max(600, w), height: Math.max(500, Math.min(800, w * 0.8)) });
      }
    };
    updateSize();
    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, []);

  useEffect(() => {
    if (!svgRef.current || projects.length === 0) return;

    const { width, height } = dimensions;
    const margin = { top: 10, right: 160, bottom: 10, left: 130 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    const sankeyData = {
      nodes: data.nodes.map((n) => ({ ...n })),
      links: data.links.map((l) => ({ ...l })),
    };

    const sankeyGen = sankey<SNode, SLink>()
      .nodeId((d: any) => d.index)
      .nodeWidth(16)
      .nodePadding(6)
      .nodeSort(null)
      .extent([
        [margin.left, margin.top],
        [margin.left + innerW, margin.top + innerH],
      ]);

    const { nodes, links } = sankeyGen(sankeyData as any) as any;

    svg
      .append("g")
      .attr("fill", "none")
      .selectAll("path")
      .data(links)
      .join("path")
      .attr("d", sankeyLinkHorizontal())
      .attr("stroke", (d: any) => d.source.color)
      .attr("stroke-opacity", (d: any) => {
        if (!hoveredNode) return 0.25;
        return d.source.name === hoveredNode || d.target.name === hoveredNode ? 0.7 : 0.05;
      })
      .attr("stroke-width", (d: any) => Math.max(1, d.width))
      .style("transition", "stroke-opacity 0.2s")
      .on("mouseenter", function (event: MouseEvent, d: any) {
        setHoveredNode(d.source.name);
        const rect = svgRef.current!.getBoundingClientRect();
        setTooltip({
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
          content: `${d.source.name} → ${d.target.name}: ${d.value} features`,
        });
      })
      .on("mouseleave", function () {
        setHoveredNode(null);
        setTooltip(null);
      });

    svg
      .append("g")
      .selectAll("rect")
      .data(nodes)
      .join("rect")
      .attr("x", (d: any) => d.x0)
      .attr("y", (d: any) => d.y0)
      .attr("height", (d: any) => Math.max(1, d.y1 - d.y0))
      .attr("width", (d: any) => d.x1 - d.x0)
      .attr("fill", (d: any) => d.color)
      .attr("stroke", "hsl(var(--border))")
      .attr("stroke-width", 0.5)
      .attr("rx", 2)
      .attr("opacity", (d: any) => {
        if (!hoveredNode) return 0.9;
        if (d.name === hoveredNode) return 1;
        const connected = links.some(
          (l: any) =>
            (l.source.name === hoveredNode && l.target.name === d.name) ||
            (l.target.name === hoveredNode && l.source.name === d.name)
        );
        return connected ? 0.9 : 0.15;
      })
      .style("cursor", "pointer")
      .on("mouseenter", function (_: MouseEvent, d: any) {
        setHoveredNode(d.name);
      })
      .on("mouseleave", function () {
        setHoveredNode(null);
        setTooltip(null);
      });

    svg
      .append("g")
      .selectAll("text")
      .data(nodes)
      .join("text")
      .attr("x", (d: any) => (d.x0 < innerW / 2 + margin.left ? d.x0 - 6 : d.x1 + 6))
      .attr("y", (d: any) => (d.y1 + d.y0) / 2)
      .attr("dy", "0.35em")
      .attr("text-anchor", (d: any) => (d.x0 < innerW / 2 + margin.left ? "end" : "start"))
      .attr("fill", "hsl(var(--foreground))")
      .attr("font-size", (d: any) => (d.category === "project" ? 10 : 12))
      .attr("font-weight", (d: any) => (d.category === "level" ? 600 : 400))
      .attr("opacity", (d: any) => {
        if (!hoveredNode) return 0.9;
        if (d.name === hoveredNode) return 1;
        const connected = links.some(
          (l: any) =>
            (l.source.name === hoveredNode && l.target.name === d.name) ||
            (l.target.name === hoveredNode && l.source.name === d.name)
        );
        return connected ? 0.9 : 0.15;
      })
      .text((d: any) => d.name);
  }, [data, dimensions, hoveredNode, projects]);

  if (loading) {
    return <div className="flex items-center justify-center h-40 text-muted-foreground">Loading...</div>;
  }

  return (
    <div ref={containerRef} className="relative w-full">
      <div className="relative overflow-x-auto">
        <svg
          ref={svgRef}
          width={dimensions.width}
          height={dimensions.height}
          className="w-full"
          style={{ minWidth: 600 }}
        />

        {tooltip && (
          <div
            className="absolute z-50 pointer-events-none bg-popover border border-border rounded-lg shadow-lg px-3 py-2 text-xs text-foreground"
            style={{
              left: Math.min(tooltip.x + 10, dimensions.width - 250),
              top: tooltip.y - 30,
            }}
          >
            {tooltip.content}
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap justify-center gap-4 text-xs text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: LEVEL_COLORS.Computational }} />
          <span><strong>Computational:</strong> What problem is solved</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: LEVEL_COLORS.Algorithmic }} />
          <span><strong>Algorithmic:</strong> What approach is used</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: LEVEL_COLORS.Implementation }} />
          <span><strong>Implementation:</strong> What tools are used</span>
        </div>
      </div>
    </div>
  );
}
