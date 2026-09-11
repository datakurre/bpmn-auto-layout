/**
 * Process-level sequence-flow routing: turns a placed ProcessLayoutResult
 * into a finished waypoint for every flow, independent of BPMN DI
 * serialization.
 *
 * This is the routing/repair pipeline that used to live inline inside
 * di-creation.ts's buildProcessShapesAndEdges, interleaved with moddle
 * object construction. Extracted so route geometry is a value that can be
 * asserted on directly ("this flow takes two bends") without parsing
 * rendered XML, and so di-creation.ts is a translation of finished geometry
 * into DI shapes rather than the place routing decisions are made (#31).
 *
 * `layout` must already be in the coordinate system the caller wants
 * waypoints in -- di-creation.ts passes a dx/dy-shifted view when placing a
 * participant inside a collaboration plane; a standalone process passes its
 * layout unshifted.
 */

import type { NodeLayout, ProcessLayoutResult } from "./layout-types";
import type { ResolvedLayoutOptions } from "./element-dimensions";
import { resolveRoutingPolicy, isOrthogonal } from "./layout-policy";
import { planContainerScopedChannels } from "./channel-planning";
import { computeWaypoints, channelY } from "./edge-routing";
import { repairSegmentCollisions, countRouteHits, validateConnectionPoints } from "./collision-repair";
import { fanOutAttachPoints, ensureOrthogonalWaypoints } from "./label-placement";
import { warn, type LayoutWarning } from "./layout-warnings";
import { ROUTE_DEPARTURE_GAP, CHANNEL_LANE_GAP } from "./element-dimensions";

export type RoutePoint = { x: number; y: number };

/**
 * Order flows for routing by structural span (column + track distance
 * between endpoints), then by source/target id. Routing in document order
 * makes edge-vs-edge avoidance depend on where a flow happens to sit in the
 * source XML: inserting an unrelated flow earlier in the document can
 * renumber later flows and re-route ones that were already fine. Span-then-id
 * order depends only on the graph, so it is stable under unrelated edits
 * (see #10). Short, local flows are routed first, so a long bypass or
 * loop-back's own repair pass already sees them as settled obstacles.
 */
export function orderFlowsForRouting(layout: ProcessLayoutResult): any[] {
  const span = (flow: any): number => {
    const src = layout.nodes.get(flow.sourceRef?.id);
    const tgt = layout.nodes.get(flow.targetRef?.id);
    if (!src || !tgt) return 0;
    return Math.abs(tgt.col - src.col) + Math.abs(tgt.track - src.track);
  };
  return [...layout.allFlows].sort((a, b) => {
    const spanDiff = span(a) - span(b);
    if (spanDiff !== 0) return spanDiff;
    const sourceDiff = (a.sourceRef?.id ?? "").localeCompare(b.sourceRef?.id ?? "");
    if (sourceDiff !== 0) return sourceDiff;
    return (a.targetRef?.id ?? "").localeCompare(b.targetRef?.id ?? "");
  });
}

/**
 * Compute the finished, orthogonal, collision-repaired waypoints for every
 * sequence flow in `layout`. Mutates `layout.channels` as a side effect
 * (the channel plan is part of the finished routing state); does not mutate
 * `layout.nodes` or read/write DOM/moddle state.
 */
export function routeProcessFlows(
  layout: ProcessLayoutResult,
  opts: ResolvedLayoutOptions,
  warnings?: LayoutWarning[],
): Map<string, RoutePoint[]> {
  const routingPolicy = resolveRoutingPolicy(opts.routing);
  const edgeWaypoints = new Map<string, RoutePoint[]>();
  const routingOrder = orderFlowsForRouting(layout);
  const { recorder, resolve } = planContainerScopedChannels(layout.nodes, layout.allFlows);

  // 1. Pre-compute edge waypoints (two passes: record -> resolve channel lanes)
  for (const pass of [recorder, null]) {
    layout.channels = pass ?? resolve();
    edgeWaypoints.clear();
    for (const flow of routingOrder) {
      const src = layout.nodes.get(flow.sourceRef?.id);
      const tgt = layout.nodes.get(flow.targetRef?.id);
      if (!src || !tgt) continue;
      edgeWaypoints.set(
        flow.id,
        repairSegmentCollisions(computeWaypoints(src, tgt, layout, flow), layout, flow, new Map(), routingPolicy),
      );
    }
  }

  fanOutAttachPoints(edgeWaypoints, layout);
  for (const flow of layout.allFlows) {
    const points = edgeWaypoints.get(flow.id);
    const src = layout.nodes.get(flow.sourceRef?.id);
    const tgt = layout.nodes.get(flow.targetRef?.id);
    if (points && src && tgt && !validateConnectionPoints(points, src, tgt)) {
      edgeWaypoints.set(flow.id, repairSegmentCollisions(points, layout, flow, edgeWaypoints, routingPolicy));
    }
  }

  // Post-repair: re-route lower-track merge flows and re-apply collision repair
  for (const flow of routingOrder) {
    const existing = edgeWaypoints.get(flow.id);
    if (!existing) continue;
    const src = layout.nodes.get(flow.sourceRef?.id);
    const tgt = layout.nodes.get(flow.targetRef?.id);
    const isLowerMerge =
      src &&
      tgt &&
      src.track > tgt.track &&
      tgt.element?.$type?.endsWith("Gateway") &&
      !src.element?.$type?.endsWith("Gateway");
    if (isLowerMerge) {
      edgeWaypoints.set(flow.id, computeWaypoints(src, tgt, layout, flow));
      continue;
    }
    if (countRouteHits(existing, layout, flow, edgeWaypoints) === 0 && validateConnectionPoints(existing, src, tgt)) {
      continue;
    }
    edgeWaypoints.set(flow.id, repairSegmentCollisions(existing, layout, flow, edgeWaypoints, routingPolicy));
  }

  // Restore upper-channel bypasses for non-exclusive gateways with an upper-track branch
  for (const flow of layout.allFlows) {
    const src = layout.nodes.get(flow.sourceRef?.id);
    const tgt = layout.nodes.get(flow.targetRef?.id);
    const hasUpperBranch =
      src &&
      tgt &&
      src.track === tgt.track &&
      src.element.$type.endsWith("Gateway") &&
      Array.from(layout.nodes.values()).some(
        (node) =>
          node.id !== src.id &&
          node.id !== tgt.id &&
          !node.isSubProcessChild &&
          node.track === src.track &&
          node.x < tgt.x &&
          node.x + node.width > src.x + src.width &&
          node.y < src.centerY &&
          node.y + node.height > src.centerY,
      ) &&
      layout.allFlows.some((candidate) => {
        if (candidate.id === flow.id || candidate.sourceRef?.id !== src.id) return false;
        const target = layout.nodes.get(candidate.targetRef?.id);
        return target && target.track < src.track;
      });
    if (hasUpperBranch && src && tgt) {
      const upper = channelY(layout, flow, "above", src.centerX, tgt.centerX);
      const restored = [
        { x: src.centerX, y: src.y },
        { x: src.centerX, y: upper },
        { x: tgt.centerX, y: upper },
        { x: tgt.centerX, y: tgt.y },
      ];
      if (validateConnectionPoints(restored, src, tgt)) {
        edgeWaypoints.set(flow.id, restored);
      }
    }
  }

  for (const [flowId, points] of edgeWaypoints) {
    const flow = layout.allFlows.find((candidate) => candidate.id === flowId);
    const source = flow ? layout.nodes.get(flow.sourceRef?.id) : undefined;
    const target = flow ? layout.nodes.get(flow.targetRef?.id) : undefined;
    const orthogonal = ensureOrthogonalWaypoints(points);
    if (!validateConnectionPoints(orthogonal, source, target)) {
      const fallback =
        source && target && source.centerX < target.x
          ? [
              { x: source.x + source.width, y: source.centerY },
              { x: target.x - 30, y: source.centerY },
              { x: target.x - 30, y: target.centerY },
              { x: target.x, y: target.centerY },
            ]
          : source && target && source.centerX > target.x + target.width
            ? [
                { x: source.x, y: source.centerY },
                { x: target.x + target.width + 30, y: source.centerY },
                { x: target.x + target.width + 30, y: target.centerY },
                { x: target.x + target.width, y: target.centerY },
              ]
            : source && target && source.centerY < target.y
              ? [
                  { x: source.centerX, y: source.y + source.height },
                  { x: source.centerX, y: target.y - 30 },
                  { x: target.centerX, y: target.y - 30 },
                  { x: target.centerX, y: target.y },
                ]
              : source && target
                ? [
                    { x: source.centerX, y: source.y },
                    { x: source.centerX, y: target.y + target.height + 30 },
                    { x: target.centerX, y: target.y + target.height + 30 },
                    { x: target.centerX, y: target.y + target.height },
                  ]
                : undefined;
      if (fallback && validateConnectionPoints(fallback, source, target)) {
        const repairedFallback = repairSegmentCollisions(fallback, layout, flow, edgeWaypoints, routingPolicy);
        if (validateConnectionPoints(repairedFallback, source, target)) {
          edgeWaypoints.set(flowId, repairedFallback);
          continue;
        }
        edgeWaypoints.set(flowId, fallback);
        continue;
      }
      // No candidate validated even after every fallback. Per #32's
      // decision the engine always produces a renderable diagram: ship the
      // best geometry available (the fallback if one exists, else the
      // orthogonalized route) with a warning, rather than throwing and
      // leaving the caller with no diagram and no diagnostic at all.
      warn(
        warnings,
        "ROUTE_INVALID_CONNECTION_POINTS",
        flowId,
        `sequence flow ${flowId} has no route whose endpoints validate against both node boundaries; emitted the best available geometry instead`,
      );
      edgeWaypoints.set(flowId, fallback ?? orthogonal);
      continue;
    }
    edgeWaypoints.set(flowId, snapRouteWaypoints(orthogonal, opts.gridSize));
  }

  // Reassert only gateway channel routes. Non-gateway routes have already
  // passed collision repair and validation above; replacing them here would
  // bypass both checks and can route through boundary events or subprocesses.
  for (const flow of layout.allFlows) {
    const src = layout.nodes.get(flow.sourceRef?.id);
    const tgt = layout.nodes.get(flow.targetRef?.id);
    if (
      !src ||
      !tgt ||
      src.track !== tgt.track ||
      !src.element?.$type.endsWith("Gateway") ||
      tgt.x <= src.x + src.width
    ) {
      continue;
    }
    const branches = layout.allFlows
      .filter((candidate) => candidate.id !== flow.id && candidate.sourceRef?.id === src.id)
      .map((candidate) => layout.nodes.get(candidate.targetRef?.id))
      .filter((target): target is NodeLayout => Boolean(target && target.track !== src.track));
    if (branches.length === 0) continue;
    // Depart the gateway's right edge and arrive at the target's left edge
    // horizontally before turning toward the channel -- turning immediately
    // at the boundary reads as sliding along the shape's own edge rather
    // than leaving it, and fails validateConnectionPoints's departure check
    // (#41).
    const gap = Math.min(ROUTE_DEPARTURE_GAP, Math.max(4, (tgt.x - (src.x + src.width)) / 4));
    const buildCandidate = (channelValue: number): RoutePoint[] => [
      { x: src.x + src.width, y: src.centerY },
      { x: src.x + src.width + gap, y: src.centerY },
      { x: src.x + src.width + gap, y: channelValue },
      { x: tgt.x - gap, y: channelValue },
      { x: tgt.x - gap, y: tgt.centerY },
      { x: tgt.x, y: tgt.centerY },
    ];
    // validateConnectionPoints only checks that the endpoints attach to the
    // right side of each node -- it says nothing about what the channel
    // segment in between passes through, so a route that "validates" can
    // still cut straight through the very node it exists to bypass (#41).
    // countRouteHits is what actually tells us the channel is clear. The
    // channel plan hands back one default lane for a flow it never recorded
    // a request for (as this one didn't, at the point the plan was built),
    // so when that lane is already crowded, try the next few lanes out
    // before falling back to per-segment repair.
    const baseChannel = channelY(layout, flow, "below", src.centerX, tgt.centerX);
    let accepted: RoutePoint[] | null = null;
    for (let lane = 0; lane < 6; lane += 1) {
      const candidate = buildCandidate(baseChannel + lane * CHANNEL_LANE_GAP);
      if (
        validateConnectionPoints(candidate, src, tgt) &&
        countRouteHits(candidate, layout, flow, edgeWaypoints) === 0
      ) {
        accepted = candidate;
        break;
      }
    }
    if (accepted) {
      edgeWaypoints.set(flow.id, accepted);
      continue;
    }
    // The channel route can run through a boundary event or subprocess;
    // repair it like every other route, and if it still does not validate
    // or is still not hit-free, keep the previous (already validated)
    // route rather than ship it.
    const repaired = repairSegmentCollisions(buildCandidate(baseChannel), layout, flow, edgeWaypoints, routingPolicy);
    if (
      validateConnectionPoints(repaired, src, tgt) &&
      countRouteHits(repaired, layout, flow, edgeWaypoints) === 0
    ) {
      edgeWaypoints.set(flow.id, repaired);
    }
  }

  // repairSegmentCollisions can return its best candidate even when that
  // candidate still has obstacle hits (no repair strategy reached zero) --
  // previously a silent degradation. Surface it: check every final route
  // once against the same obstacle set repair uses, and warn on whatever
  // still overlaps something (#32).
  if (warnings) {
    for (const flow of layout.allFlows) {
      const points = edgeWaypoints.get(flow.id);
      if (!points) continue;
      if (countRouteHits(points, layout, flow, edgeWaypoints) > 0) {
        warn(
          warnings,
          "ROUTE_INTERSECTS_OBSTACLE",
          flow.id,
          `sequence flow ${flow.id}'s final route still overlaps a node, container, or another route after every repair attempt`,
        );
      }
      // Priority 3 (orthogonal-routing): every earlier pass already builds
      // orthogonal polylines, but nothing re-checks the geometry that
      // actually ships -- a later pass rewriting a route (the label
      // re-repair pass, a fallback) could reintroduce a diagonal segment
      // without anything noticing (#42).
      if (!isOrthogonal(points)) {
        warn(warnings, "ROUTE_NOT_ORTHOGONAL", flow.id, `sequence flow ${flow.id}'s final route has a non-orthogonal segment`);
      }
    }
    // Priority 2 (no-overlaps): no two node shapes may overlap. A
    // subprocess's own children sit inside its bounds by design, so a pair
    // is only a violation when neither is an ancestor container of the
    // other.
    const isAncestor = (ancestorId: string, node: NodeLayout): boolean => {
      let current: NodeLayout | undefined = node;
      while (current?.containerId) {
        if (current.containerId === ancestorId) return true;
        current = layout.nodes.get(current.containerId);
      }
      return false;
    };
    const boxOverlapArea = (a: NodeLayout, b: NodeLayout): number => {
      const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      return w > 0 && h > 0 ? w * h : 0;
    };
    const nodes = [...layout.nodes.values()];
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        if (isAncestor(a.id, b) || isAncestor(b.id, a)) continue;
        if (boxOverlapArea(a, b) > 0) {
          warn(warnings, "SHAPE_OVERLAPS_SHAPE", a.id, `shape ${a.id} overlaps shape ${b.id}`);
        }
      }
    }
  }

  return edgeWaypoints;
}

export function snapRouteWaypoints(points: RoutePoint[], gridSize: number): RoutePoint[] {
  const snapped = points.map((point, index) => {
    // Keep attachment points on the shape boundary. diagram-js snaps the
    // bend location, while the connection endpoint is determined by shape
    // geometry and may therefore be between grid lines.
    if (index === 0 || index === points.length - 1) return point;
    return { x: Math.round(point.x / gridSize) * gridSize, y: Math.round(point.y / gridSize) * gridSize };
  });
  if (
    snapped.every(
      (point, index) => index === 0 || point.x === snapped[index - 1]!.x || point.y === snapped[index - 1]!.y,
    )
  ) {
    return snapped;
  }
  return points;
}
