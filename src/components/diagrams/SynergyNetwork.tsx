import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import * as d3 from "d3";
import {
  SYNERGY_TYPE_COLORS,
  type SynergyNode,
  type SynergyLink,
} from "@/data/marr-synergies";
import { useMarrProjects } from "@/hooks/useMarrProjects";
import { SynergyTooltip } from "./synergy/SynergyTooltip";
import { SynergyLegend } from "./synergy/SynergyLegend";
import { SynergyFilters, type FilterType } from "./synergy/SynergyFilters";
import { SynergyStats } from "./synergy/SynergyStats";

interface TooltipData {
  x: number;
  y: number;
  nodeId?: string;
  relId?: string;
}

interface SimNode extends d3.SimulationNodeDatum {
  id: string;
  data: SynergyNode;
}

interface SimLink extends d3.SimulationLinkDatum<SimNode> {
  data: SynergyLink;
  index?: number;
}

export function SynergyNetwork() {
  const { synergyNodes, synergyLinks, loading } = useMarrProjects();
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [filter, setFilter] = useState<FilterType>("all");
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  const filteredLinks = useMemo(
    () => synergyLinks.filter((l) => filter === "all" || l.synergyType === filter),
    [filter, synergyLinks]
  );

  const connectedIds = useMemo(() => {
    const ids = new Set<string>();
    filteredLinks.forEach((l) => {
      ids.add(l.source);
      ids.add(l.target);
    });
    return ids;
  }, [filteredLinks]);

  const neighborsOf = useCallback(
    (nodeId: string) => {
      const s = new Set<string>();
      s.add(nodeId);
      filteredLinks.forEach((l) => {
        if (l.source === nodeId || l.target === nodeId) {
          s.add(l.source);
          s.add(l.target);
        }
      });
      return s;
    },
    [filteredLinks]
  );

  const highlightSet = useMemo(
    () => (hoveredNodeId ? neighborsOf(hoveredNodeId) : null),
    [hoveredNodeId, neighborsOf]
  );

  const findNode = (id: string) => synergyNodes.find((n) => n.id === id);
  const findLink = (relId: string) => {
    const idx = parseInt(relId.replace("rel-", ""), 10);
    return filteredLinks[idx];
  };

  const tooltipNode = tooltip?.nodeId ? findNode(tooltip.nodeId) : null;
  const tooltipLink = tooltip?.relId ? findLink(tooltip.relId) : null;

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || synergyNodes.length === 0) return;

    const width = 900;
    const height = 620;

    const d3svg = d3.select(svg);
    d3svg.selectAll("*").remove();

    const g = d3svg.append("g");

    const zoom = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.3, 4])
      .on("zoom", (event) => {
        g.attr("transform", event.transform);
      });

    d3svg.call(zoom);

    const simNodes: SimNode[] = synergyNodes.map((n) => ({
      id: n.id,
      data: n,
    }));

    const nodeMap = new Map(simNodes.map((n) => [n.id, n]));

    const simLinks: SimLink[] = filteredLinks.map((l) => ({
      source: nodeMap.get(l.source)!,
      target: nodeMap.get(l.target)!,
      data: l,
    })).filter(l => l.source && l.target);

    const simulation = d3
      .forceSimulation(simNodes)
      .force(
        "link",
        d3.forceLink<SimNode, SimLink>(simLinks).id((d) => d.id).distance(70)
      )
      .force("charge", d3.forceManyBody().strength(-150))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collision", d3.forceCollide().radius(22))
      .force("x", d3.forceX(width / 2).strength(0.08))
      .force("y", d3.forceY(height / 2).strength(0.08));

    const link = g
      .append("g")
      .selectAll("line")
      .data(simLinks)
      .join("line")
      .attr("stroke", (d) => SYNERGY_TYPE_COLORS[d.data.synergyType])
      .attr("stroke-opacity", 0.6)
      .attr("stroke-width", 3);

    const node = g
      .append("g")
      .selectAll<SVGCircleElement, SimNode>("circle")
      .data(simNodes)
      .join("circle")
      .attr("r", (d) =>
        d.data.grantType === "U01" ? 16 : d.data.grantType === "U24" || d.data.grantType === "R24" ? 14 : 10
      )
      .attr("fill", (d) => d.data.color)
      .attr("stroke", "#1e293b")
      .attr("stroke-width", 1.5)
      .attr("cursor", "grab")
      .style("filter", "drop-shadow(0 2px 4px rgba(0,0,0,0.3))");

    const label = g
      .append("g")
      .selectAll("text")
      .data(simNodes)
      .join("text")
      .text((d) => d.data.shortName)
      .attr("font-size", 8)
      .attr("fill", "#cbd5e1")
      .attr("text-anchor", "middle")
      .attr("dy", (d) => {
        const r = d.data.grantType === "U01" ? 16 : d.data.grantType === "U24" || d.data.grantType === "R24" ? 14 : 10;
        return r + 14;
      })
      .attr("pointer-events", "none");

    const drag = d3.drag<SVGCircleElement, SimNode>()
      .on("start", (event, d) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on("drag", (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on("end", (event, d) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });

    node.call(drag);

    node
      .on("mouseenter", (event, d) => {
        setHoveredNodeId(d.id);
        setTooltip({ x: event.clientX, y: event.clientY, nodeId: d.id });
      })
      .on("mousemove", (event, d) => {
        setTooltip({ x: event.clientX, y: event.clientY, nodeId: d.id });
      })
      .on("mouseleave", () => {
        setHoveredNodeId(null);
        setTooltip(null);
      });

    link
      .on("mouseenter", (event, d) => {
        const idx = simLinks.indexOf(d);
        setTooltip({ x: event.clientX, y: event.clientY, relId: `rel-${idx}` });
      })
      .on("mousemove", (event, d) => {
        const idx = simLinks.indexOf(d);
        setTooltip({ x: event.clientX, y: event.clientY, relId: `rel-${idx}` });
      })
      .on("mouseleave", () => {
        setTooltip(null);
      });

    simulation.on("tick", () => {
      link
        .attr("x1", (d) => (d.source as SimNode).x!)
        .attr("y1", (d) => (d.source as SimNode).y!)
        .attr("x2", (d) => (d.target as SimNode).x!)
        .attr("y2", (d) => (d.target as SimNode).y!);

      node.attr("cx", (d) => d.x!).attr("cy", (d) => d.y!);

      label.attr("x", (d) => d.x!).attr("y", (d) => d.y!);
    });

    return () => {
      simulation.stop();
    };
  }, [filteredLinks, synergyNodes]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;

    const d3svg = d3.select(svg);

    d3svg.selectAll<SVGCircleElement, SimNode>("circle").attr("opacity", (d) => {
      if (filter !== "all" && !connectedIds.has(d.id)) return 0.15;
      if (highlightSet && !highlightSet.has(d.id)) return 0.15;
      return 1;
    });

    d3svg.selectAll<SVGLineElement, SimLink>("line").attr("stroke-opacity", (d) => {
      if (highlightSet) {
        const src = typeof d.source === "object" ? (d.source as SimNode).id : d.source;
        const tgt = typeof d.target === "object" ? (d.target as SimNode).id : d.target;
        if (!(highlightSet.has(src as string) && highlightSet.has(tgt as string))) return 0.05;
      }
      return 0.6;
    });

    d3svg.selectAll<SVGTextElement, SimNode>("text").attr("opacity", (d) => {
      if (filter !== "all" && !connectedIds.has(d.id)) return 0.15;
      if (highlightSet && !highlightSet.has(d.id)) return 0.15;
      return 1;
    });
  }, [highlightSet, filter, connectedIds]);

  if (loading) {
    return <div className="flex items-center justify-center h-40 text-muted-foreground">Loading synergy data...</div>;
  }

  return (
    <div ref={containerRef} className="relative w-full space-y-4">
      <SynergyStats
        totalNodes={synergyNodes.length}
        totalEdges={synergyLinks.length}
        filteredEdges={filteredLinks.length}
        connectedNodes={connectedIds.size}
        filter={filter}
      />

      <SynergyFilters filter={filter} onFilterChange={setFilter} />

      <div
        className="rounded-xl overflow-hidden border border-border shadow-lg bg-[#0f172a]"
        style={{ height: 620, width: "100%", position: "relative" }}
      >
        <svg
          ref={svgRef}
          width="100%"
          height="100%"
          viewBox="0 0 900 620"
          style={{ display: "block" }}
        />

        <SynergyTooltip
          tooltip={tooltip}
          tooltipNode={tooltipNode}
          tooltipLink={tooltipLink}
          findNode={findNode}
        />
      </div>

      <SynergyLegend />
    </div>
  );
}
