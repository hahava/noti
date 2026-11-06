import { useEffect, useRef, useState } from "react";
import { drag } from "d3-drag";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { select } from "d3-selection";
import { zoom, zoomIdentity, type ZoomTransform } from "d3-zoom";
import { workspaceApi, type GraphData } from "./api";

/**
 * 그래프 뷰: 워크스페이스의 페이지(점)와 링크(선)를 한 화면에 그린다. (Obsidian 의 그래프와 같은 개념)
 * 링크 = 본문 속 하위 페이지 블록·@멘션, 캔버스에 올린 페이지 카드.
 * 사이드바에서 여는 전체 화면 레이어이고, 점을 누르면 그 페이지로 이동한다.
 */

type Node = SimulationNodeDatum & GraphData["nodes"][number] & { degree: number };
type Link = SimulationLinkDatum<Node>;

const radiusOf = (node: Node) => 5 + Math.sqrt(node.degree) * 3;

export function GraphView({
  currentPageId,
  onSelectPage,
  onClose,
}: {
  currentPageId?: string;
  onSelectPage: (pageId: string) => void;
  onClose: () => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [data, setData] = useState<GraphData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const highlightRef = useRef<(text: string) => void>(() => undefined);

  useEffect(() => {
    workspaceApi
      .getGraph()
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : "그래프를 불러오지 못했습니다."));
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const svgElement = svgRef.current;
    if (!data || !svgElement) return;
    const width = svgElement.clientWidth || 800;
    const height = svgElement.clientHeight || 600;

    const degree = new Map<string, number>();
    for (const link of data.links) {
      degree.set(link.source, (degree.get(link.source) ?? 0) + 1);
      degree.set(link.target, (degree.get(link.target) ?? 0) + 1);
    }
    const nodes: Node[] = data.nodes.map((node) => ({ ...node, degree: degree.get(node.id) ?? 0 }));
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const links: Link[] = data.links
      .filter((link) => nodeById.has(link.source) && nodeById.has(link.target))
      .map((link) => ({ source: link.source, target: link.target }));
    const neighbors = new Map<string, Set<string>>();
    for (const link of data.links) {
      if (!neighbors.has(link.source)) neighbors.set(link.source, new Set());
      if (!neighbors.has(link.target)) neighbors.set(link.target, new Set());
      neighbors.get(link.source)!.add(link.target);
      neighbors.get(link.target)!.add(link.source);
    }

    const svg = select(svgElement);
    svg.selectAll("*").remove();
    const root = svg.append("g");

    const linkSel = root
      .append("g")
      .attr("class", "graph-links")
      .selectAll<SVGLineElement, Link>("line")
      .data(links)
      .join("line")
      .attr("class", "graph-link");

    const nodeSel = root
      .append("g")
      .selectAll<SVGGElement, Node>("g")
      .data(nodes, (node) => node.id)
      .join("g")
      .attr("class", (node) =>
        ["graph-node", node.kind === "canvas" ? "graph-node--canvas" : "", node.id === currentPageId ? "graph-node--current" : ""]
          .filter(Boolean)
          .join(" "),
      )
      .style("cursor", "pointer");

    nodeSel
      .filter((node) => node.kind !== "canvas")
      .append("circle")
      .attr("r", radiusOf);
    nodeSel
      .filter((node) => node.kind === "canvas")
      .append("rect")
      .attr("x", (node) => -radiusOf(node))
      .attr("y", (node) => -radiusOf(node))
      .attr("width", (node) => radiusOf(node) * 2)
      .attr("height", (node) => radiusOf(node) * 2)
      .attr("rx", 3);
    nodeSel
      .append("text")
      .attr("class", "graph-label")
      .attr("dy", (node) => radiusOf(node) + 13)
      .attr("text-anchor", "middle")
      .text((node) => `${node.icon ? `${node.icon} ` : ""}${node.title}`);

    // 점에 올리면 이웃만 강조
    const focus = (id: string | null) => {
      const near = id ? neighbors.get(id) ?? new Set<string>() : null;
      nodeSel.classed("is-dimmed", (node) => Boolean(near && node.id !== id && !near.has(node.id)));
      nodeSel.classed("is-focused", (node) => node.id === id);
      linkSel.classed("is-dimmed", (link) => {
        if (!id) return false;
        const source = (link.source as Node).id;
        const target = (link.target as Node).id;
        return source !== id && target !== id;
      });
    };
    nodeSel.on("mouseenter", (_event, node) => focus(node.id)).on("mouseleave", () => focus(null));
    nodeSel.on("click", (event: MouseEvent, node) => {
      if (event.defaultPrevented) return; // 드래그 끝
      onSelectPage(node.id);
    });

    // 이름 검색: 맞는 점만 진하게
    highlightRef.current = (text: string) => {
      const needle = text.trim().toLowerCase();
      nodeSel.classed("is-match", (node) => Boolean(needle) && node.title.toLowerCase().includes(needle));
      nodeSel.classed("is-dimmed", (node) => Boolean(needle) && !node.title.toLowerCase().includes(needle));
    };

    const simulation = forceSimulation<Node>(nodes)
      .force(
        "link",
        forceLink<Node, Link>(links)
          .id((node) => node.id)
          .distance(70)
          .strength(0.6),
      )
      .force("charge", forceManyBody<Node>().strength(-180))
      .force("collide", forceCollide<Node>().radius((node) => radiusOf(node) + 6))
      .force("center", forceCenter(width / 2, height / 2))
      // 연결이 없는 페이지도 화면 밖으로 흩어지지 않게 가운데로 약하게 당긴다
      .force("x", forceX(width / 2).strength(0.04))
      .force("y", forceY(height / 2).strength(0.04));

    const render = () => {
      linkSel
        .attr("x1", (link) => (link.source as Node).x ?? 0)
        .attr("y1", (link) => (link.source as Node).y ?? 0)
        .attr("x2", (link) => (link.target as Node).x ?? 0)
        .attr("y2", (link) => (link.target as Node).y ?? 0);
      nodeSel.attr("transform", (node) => `translate(${node.x ?? 0},${node.y ?? 0})`);
    };
    // 열 때는 배치를 미리 계산해 바로 보여 준다 (점이 날아다니며 자리 잡는 과정 없이). 끌 때만 다시 움직인다.
    simulation.stop();
    for (let i = 0; i < 300; i += 1) simulation.tick();
    render();
    simulation.on("tick", render);

    nodeSel.call(
      drag<SVGGElement, Node>()
        .on("start", (event, node) => {
          if (!event.active) simulation.alphaTarget(0.25).restart();
          node.fx = node.x;
          node.fy = node.y;
        })
        .on("drag", (event, node) => {
          node.fx = event.x;
          node.fy = event.y;
        })
        .on("end", (event, node) => {
          if (!event.active) simulation.alphaTarget(0);
          node.fx = null;
          node.fy = null;
        }),
    );

    // 확대·이동. 많이 줄이면 이름을 숨긴다.
    const applyTransform = (transform: ZoomTransform) => {
      root.attr("transform", transform.toString());
      svg.classed("graph-svg--far", transform.k < 0.6);
    };
    const zoomBehavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.15, 4])
      .on("zoom", (event) => applyTransform(event.transform));
    svg.call(zoomBehavior).on("dblclick.zoom", null);
    svg.call(zoomBehavior.transform, zoomIdentity);

    // 전체가 화면에 들어오게 맞춘다
    if (nodes.length > 0) {
      const xs = nodes.map((n) => n.x ?? 0);
      const ys = nodes.map((n) => n.y ?? 0);
      const pad = 80;
      const minX = Math.min(...xs) - pad;
      const maxX = Math.max(...xs) + pad;
      const minY = Math.min(...ys) - pad;
      const maxY = Math.max(...ys) + pad;
      const scale = Math.min(1.8, width / Math.max(maxX - minX, 1), height / Math.max(maxY - minY, 1));
      svg.call(
        zoomBehavior.transform,
        zoomIdentity.translate(width / 2, height / 2).scale(scale).translate(-(minX + maxX) / 2, -(minY + maxY) / 2),
      );
    }

    return () => {
      simulation.stop();
      svg.on(".zoom", null);
    };
  }, [data, currentPageId, onSelectPage]);

  useEffect(() => highlightRef.current(query), [query, data]);

  return (
    <div className="graph-overlay" role="dialog" aria-label="그래프 뷰">
      <header className="graph-overlay__header">
        <strong>그래프</strong>
        {data && (
          <span className="graph-overlay__meta">
            페이지 {data.nodes.length} · 링크 {data.links.length}
          </span>
        )}
        <input
          className="graph-overlay__search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="페이지 이름으로 찾기"
          aria-label="페이지 이름으로 찾기"
        />
        <span className="graph-overlay__legend">
          <span className="graph-legend graph-legend--page" /> 페이지
          <span className="graph-legend graph-legend--canvas" /> 캔버스
          <span className="graph-legend graph-legend--current" /> 지금 페이지
        </span>
        <button type="button" className="ds-btn ds-btn--ghost graph-overlay__close" onClick={onClose} aria-label="그래프 닫기">
          닫기 <kbd>Esc</kbd>
        </button>
      </header>
      {error && <div className="graph-overlay__message">{error}</div>}
      {!error && !data && <div className="graph-overlay__message">불러오는 중…</div>}
      {data && data.nodes.length === 0 && <div className="graph-overlay__message">아직 페이지가 없습니다.</div>}
      <svg ref={svgRef} className="graph-svg" />
      <footer className="graph-overlay__hint">점을 누르면 그 페이지로 이동 · 끌어서 옮기기 · 스크롤로 확대</footer>
    </div>
  );
}
