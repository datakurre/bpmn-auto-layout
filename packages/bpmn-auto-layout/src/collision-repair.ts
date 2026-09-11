/**
 * Segment collision repair and rectilinear routing.
 *
 * These functions run *after* the primary rule-based routing in edge-routing.ts
 * and nudge or re-route any polyline segment that intersects a non-endpoint
 * node or a previously placed edge.
 */

import type { NodeLayout, ProcessLayoutResult } from "./layout-types";
import {
  choosePreferredRoute,
  isOrthogonal,
  routeTurns,
  DEFAULT_ROUTING_POLICY,
  type RoutingPolicy,
} from "./layout-policy";
import {
  CHANNEL_CLEARANCE,
  CHANNEL_LANE_GAP,
  ROUTE_DEPARTURE_GAP,
  ROUTE_BEND_PENALTY,
} from "./element-dimensions";

/** Nudge offsets tried in order: nearest first, both directions. */
const SEGMENT_NUDGES: number[] = (() => {
  const out: number[] = [];
  for (let d = 15; d <= 300; d += 15) out.push(d, -d);
  return out;
})();

/**
 * Near-miss clearance applied when checking whether a segment intersects a
 * node.  Without this a channel can land exactly on a row of tasks' top edge,
 * which is technically outside every box but reads as a line through them.
 */
const SEGMENT_CLEARANCE = 8;

// ---------------------------------------------------------------------------
// Obstacle / segment intersection helpers
// ---------------------------------------------------------------------------

export function segmentHitCount(
  p: { x: number; y: number },
  q: { x: number; y: number },
  obstacles: NodeLayout[],
): number {
  let n = 0;
  for (const o of obstacles) {
    const x0 = o.x - SEGMENT_CLEARANCE;
    const y0 = o.y - SEGMENT_CLEARANCE;
    const x1 = o.x + o.width + SEGMENT_CLEARANCE;
    const y1 = o.y + o.height + SEGMENT_CLEARANCE;
    if (Math.abs(p.y - q.y) < 0.5) {
      if (p.y <= y0 || p.y >= y1) continue;
      if (Math.max(Math.min(p.x, q.x), x0) < Math.min(Math.max(p.x, q.x), x1)) n += 1;
    } else if (Math.abs(p.x - q.x) < 0.5) {
      if (p.x <= x0 || p.x >= x1) continue;
      if (Math.max(Math.min(p.y, q.y), y0) < Math.min(Math.max(p.y, q.y), y1)) n += 1;
    }
  }
  return n;
}

/**
 * Treat the segments of already-placed edges as thin obstacle rectangles so
 * the repair pass avoids routing a new edge directly on top of an existing one.
 */
export function pathObstacles(
  paths: Map<string, Array<{ x: number; y: number }>>,
  excludedFlowId?: string,
): NodeLayout[] {
  const obstacles: NodeLayout[] = [];
  for (const [flowId, points] of paths) {
    if (flowId === excludedFlowId) continue;
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i]!;
      const b = points[i + 1]!;
      const length = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
      // Preserve a central obstacle even for short direct flows. Removing a
      // 40 px departure zone from a 50 px edge left no protected segment, so
      // a later route could cross the only visible part of that connection.
      const trim = Math.min(ROUTE_DEPARTURE_GAP / 4, length / 4);
      const horizontal = Math.abs(a.y - b.y) < 0.5;
      const x = horizontal ? Math.min(a.x, b.x) + trim : a.x - SEGMENT_CLEARANCE / 2;
      const y = horizontal ? a.y - SEGMENT_CLEARANCE / 2 : Math.min(a.y, b.y) + trim;
      const width = horizontal ? length - trim * 2 : SEGMENT_CLEARANCE;
      const height = horizontal ? SEGMENT_CLEARANCE : length - trim * 2;
      obstacles.push({
        id: `${flowId}:${i}`,
        element: { $type: "bpmn:RouteObstacle" },
        col: 0,
        track: 0,
        x,
        y,
        width,
        height,
        centerX: x + width / 2,
        centerY: y + height / 2,
      });
    }
  }
  return obstacles;
}

// ---------------------------------------------------------------------------
// Outward-departure guard
// ---------------------------------------------------------------------------

/**
 * The leg leaving an attach point has to head away from its own node.  Without
 * this, a nudge is free to lift a channel that hangs below a gateway up past
 * the gateway's top — the polyline still misses every *other* element, so it
 * scores as an improvement, while actually being drawn straight through its own
 * source.
 */
export function leavesOutward(
  pts: Array<{ x: number; y: number }>,
  srcNode: NodeLayout | undefined,
  tgtNode: NodeLayout | undefined,
): boolean {
  const ok = (
    attach: { x: number; y: number },
    next: { x: number; y: number },
    node?: NodeLayout,
  ): boolean => {
    if (!node) return true;
    if (Math.abs(attach.y - node.y) < 0.5)
      return Math.abs(next.x - attach.x) < 0.5 && next.y <= attach.y + 0.5;
    if (Math.abs(attach.y - (node.y + node.height)) < 0.5)
      return Math.abs(next.x - attach.x) < 0.5 && next.y >= attach.y - 0.5;
    if (Math.abs(attach.x - node.x) < 0.5)
      return Math.abs(next.y - attach.y) < 0.5 && next.x <= attach.x + 0.5;
    if (Math.abs(attach.x - (node.x + node.width)) < 0.5)
      return Math.abs(next.y - attach.y) < 0.5 && next.x >= attach.x - 0.5;
    return true;
  };
  return ok(pts[0]!, pts[1]!, srcNode) && ok(pts[pts.length - 1]!, pts[pts.length - 2]!, tgtNode);
}

export function validateConnectionPoints(
  points: Array<{ x: number; y: number }>,
  srcNode: NodeLayout | undefined,
  tgtNode: NodeLayout | undefined,
): boolean {
  if (!srcNode || !tgtNode || points.length < 2) return false;
  if (!leavesOutward(points, srcNode, tgtNode)) return false;

  const start = points[0]!;
  const end = points[points.length - 1]!;
  const sourceOnBoundary =
    Math.abs(start.x - srcNode.x) < 0.5 ||
    Math.abs(start.x - (srcNode.x + srcNode.width)) < 0.5 ||
    Math.abs(start.y - srcNode.y) < 0.5 ||
    Math.abs(start.y - (srcNode.y + srcNode.height)) < 0.5;
  const targetOnBoundary =
    Math.abs(end.x - tgtNode.x) < 0.5 ||
    Math.abs(end.x - (tgtNode.x + tgtNode.width)) < 0.5 ||
    Math.abs(end.y - tgtNode.y) < 0.5 ||
    Math.abs(end.y - (tgtNode.y + tgtNode.height)) < 0.5;
  if (!sourceOnBoundary || !targetOnBoundary) return false;
  if (srcNode.track !== tgtNode.track) return true;

  const sourceIsLeft = srcNode.centerX < tgtNode.x;
  const sourceIsRight = srcNode.centerX > tgtNode.x + tgtNode.width;
  const sourceIsAbove = srcNode.centerY < tgtNode.y;
  const sourceIsBelow = srcNode.centerY > tgtNode.y + tgtNode.height;
  const horizontalDominant =
    Math.abs(tgtNode.centerX - srcNode.centerX) >= 1.5 * Math.abs(tgtNode.centerY - srcNode.centerY);
  const verticalDominant =
    Math.abs(tgtNode.centerY - srcNode.centerY) >= 1.5 * Math.abs(tgtNode.centerX - srcNode.centerX);
  if (!horizontalDominant && !verticalDominant) return true;
  const separated =
    sourceIsLeft || sourceIsRight || sourceIsAbove || sourceIsBelow;
  if (!separated) return true;
  if (Math.abs(start.x - srcNode.x) < 0.5 && !sourceIsRight) return false;
  if (Math.abs(start.x - (srcNode.x + srcNode.width)) < 0.5 && !sourceIsLeft) return false;
  if (Math.abs(start.y - srcNode.y) < 0.5 && !sourceIsBelow) return false;
  if (Math.abs(start.y - (srcNode.y + srcNode.height)) < 0.5 && !sourceIsAbove) return false;
  if (Math.abs(end.x - tgtNode.x) < 0.5) return sourceIsLeft;
  if (Math.abs(end.x - (tgtNode.x + tgtNode.width)) < 0.5) return sourceIsRight;
  if (Math.abs(end.y - tgtNode.y) < 0.5) return sourceIsAbove;
  if (Math.abs(end.y - (tgtNode.y + tgtNode.height)) < 0.5) return sourceIsBelow;
  return false;
}

export function normalizeCardinalDeparture(
  pts: Array<{ x: number; y: number }>,
  node: NodeLayout | undefined,
): Array<{ x: number; y: number }> {
  if (!node || pts.length < 2) return pts;
  const attach = pts[0]!;
  const next = pts[1]!;
  if (leavesOutward([attach, next], node, undefined)) return pts;

  let departure: { x: number; y: number };
  let bridge: { x: number; y: number };
  if (Math.abs(attach.y - node.y) < 0.5) {
    departure = { x: attach.x, y: attach.y - ROUTE_DEPARTURE_GAP };
    bridge = { x: next.x, y: departure.y };
  } else if (Math.abs(attach.y - (node.y + node.height)) < 0.5) {
    departure = { x: attach.x, y: attach.y + ROUTE_DEPARTURE_GAP };
    bridge = { x: next.x, y: departure.y };
  } else if (Math.abs(attach.x - node.x) < 0.5) {
    departure = { x: attach.x - ROUTE_DEPARTURE_GAP, y: attach.y };
    bridge = { x: departure.x, y: next.y };
  } else if (Math.abs(attach.x - (node.x + node.width)) < 0.5) {
    departure = { x: attach.x + ROUTE_DEPARTURE_GAP, y: attach.y };
    bridge = { x: departure.x, y: next.y };
  } else {
    return pts;
  }
  return [attach, departure, bridge, ...pts.slice(2)];
}

// ---------------------------------------------------------------------------
// Visibility-graph rectilinear router
// ---------------------------------------------------------------------------

/**
 * Find a short orthogonal route around rectangular obstacles using a small
 * visibility graph rather than a full grid router.  Candidate coordinates come
 * from obstacle edges and the original route, so the result stays angular and
 * has very few bends.  Only used after the normal rule-based route has already
 * collided with an activity.
 */
export function findRectilinearRoute(
  original: Array<{ x: number; y: number }>,
  obstacles: NodeLayout[],
  srcNode: NodeLayout | undefined,
  tgtNode: NodeLayout | undefined,
): Array<{ x: number; y: number }> | null {
  const start = original[0];
  const end = original[original.length - 1];
  if (!start || !end || obstacles.length === 0) return null;

  const xs = new Set<number>(original.map((p) => p.x));
  const ys = new Set<number>(original.map((p) => p.y));
  xs.add(start.x - ROUTE_DEPARTURE_GAP);
  xs.add(start.x + ROUTE_DEPARTURE_GAP);
  ys.add(start.y - ROUTE_DEPARTURE_GAP);
  ys.add(start.y + ROUTE_DEPARTURE_GAP);
  for (const o of obstacles) {
    xs.add(o.x - SEGMENT_CLEARANCE);
    xs.add(o.x + o.width + SEGMENT_CLEARANCE);
    ys.add(o.y - SEGMENT_CLEARANCE);
    ys.add(o.y + o.height + SEGMENT_CLEARANCE);
  }

  const points: Array<{ x: number; y: number }> = [];
  const pointIndex = new Map<string, number>();
  const keyOf = (x: number, y: number): string => `${x}:${y}`;
  const clearPoint = (x: number, y: number): boolean =>
    obstacles.every(
      (o) =>
        x <= o.x - SEGMENT_CLEARANCE ||
        x >= o.x + o.width + SEGMENT_CLEARANCE ||
        y <= o.y - SEGMENT_CLEARANCE ||
        y >= o.y + o.height + SEGMENT_CLEARANCE,
    );

  for (const x of xs) {
    for (const y of ys) {
      if (
        !clearPoint(x, y) &&
        !(x === start.x && y === start.y) &&
        !(x === end.x && y === end.y)
      )
        continue;
      const index = points.length;
      points.push({ x, y });
      pointIndex.set(keyOf(x, y), index);
    }
  }

  const edges = new Map<number, Array<{ to: number; distance: number; direction: 1 | 2 }>>();
  const addVisiblePair = (a: number, b: number): void => {
    const first = points[a]!;
    const second = points[b]!;
    if (segmentHitCount(first, second, obstacles) > 0) return;
    const direction: 1 | 2 = Math.abs(first.y - second.y) < 0.5 ? 1 : 2;
    const distance = Math.abs(first.x - second.x) + Math.abs(first.y - second.y);
    (edges.get(a) ?? edges.set(a, []).get(a)!).push({ to: b, distance, direction });
    (edges.get(b) ?? edges.set(b, []).get(b)!).push({ to: a, distance, direction });
  };

  for (const x of xs) {
    const row = points
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => Math.abs(p.x - x) < 0.5)
      .sort((a, b) => a.p.y - b.p.y);
    for (let i = 0; i + 1 < row.length; i += 1) addVisiblePair(row[i]!.i, row[i + 1]!.i);
  }
  for (const y of ys) {
    const col = points
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => Math.abs(p.y - y) < 0.5)
      .sort((a, b) => a.p.x - b.p.x);
    for (let i = 0; i + 1 < col.length; i += 1) addVisiblePair(col[i]!.i, col[i + 1]!.i);
  }

  const startIndex = pointIndex.get(keyOf(start.x, start.y));
  const endIndex = pointIndex.get(keyOf(end.x, end.y));
  if (startIndex === undefined || endIndex === undefined) return null;

  interface State {
    point: number;
    direction: 0 | 1 | 2;
  }
  const stateKey = (s: State): string => `${s.point}:${s.direction}`;
  const initial: State = { point: startIndex, direction: 0 };
  const distances = new Map<string, number>([[stateKey(initial), 0]]);
  const previous = new Map<string, string>();
  const pending: State[] = [initial];

  while (pending.length > 0) {
    let bestIdx = 0;
    for (let i = 1; i < pending.length; i += 1) {
      if (
        (distances.get(stateKey(pending[i]!)) ?? Infinity) <
        (distances.get(stateKey(pending[bestIdx]!)) ?? Infinity)
      )
        bestIdx = i;
    }
    const current = pending.splice(bestIdx, 1)[0]!;
    const currentKey = stateKey(current);
    const currentDist = distances.get(currentKey)!;
    for (const edge of edges.get(current.point) || []) {
      const nextPoint = points[edge.to]!;
      if (current.point === startIndex) {
        if (
          !leavesOutward([start, nextPoint], srcNode, undefined) ||
          edge.distance < ROUTE_DEPARTURE_GAP
        )
          continue;
      }
      const turnPenalty =
        current.direction !== 0 && current.direction !== edge.direction ? ROUTE_BEND_PENALTY : 0;
      const next: State = { point: edge.to, direction: edge.direction };
      const nextKey = stateKey(next);
      const dist = currentDist + edge.distance + turnPenalty;
      if (dist >= (distances.get(nextKey) ?? Infinity)) continue;
      distances.set(nextKey, dist);
      previous.set(nextKey, currentKey);
      pending.push(next);
    }
  }

  const endStates = [...distances.keys()].filter((k) => k.startsWith(`${endIndex}:`));
  endStates.sort((a, b) => distances.get(a)! - distances.get(b)!);
  for (const endStateKey of endStates) {
    const route: Array<{ x: number; y: number }> = [];
    let cursor: string | undefined = endStateKey;
    while (cursor) {
      const idx = Number(cursor.split(":")[0]);
      route.unshift(points[idx]!);
      cursor = previous.get(cursor);
    }
    if (!leavesOutward(route, srcNode, tgtNode)) continue;
    const simplified = route.filter((p, i) => {
      if (i === 0 || i === route.length - 1) return true;
      const prev = route[i - 1]!;
      const next = route[i + 1]!;
      return !(
        (Math.abs(prev.x - p.x) < 0.5 && Math.abs(p.x - next.x) < 0.5) ||
        (Math.abs(prev.y - p.y) < 0.5 && Math.abs(p.y - next.y) < 0.5)
      );
    });
    return simplified;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Side-approach detour
// ---------------------------------------------------------------------------

/**
 * Rewrites a polyline's last vertical leg so it climbs clear of whatever is
 * between the channel and the target, then enters the target's nearer side.
 */
export function approachFromSide(
  pts: Array<{ x: number; y: number }>,
  tgt: NodeLayout,
  obstacles: NodeLayout[],
  stagger = 0,
): Array<{ x: number; y: number }> | null {
  if (pts.length < 3) return null;
  const pen = pts[pts.length - 2]!;
  const end = pts[pts.length - 1]!;
  if (Math.abs(pen.x - end.x) > 0.5) return null;

  const blocking = obstacles.filter(
    (o) =>
      pen.x > o.x - SEGMENT_CLEARANCE &&
      pen.x < o.x + o.width + SEGMENT_CLEARANCE &&
      Math.max(Math.min(pen.y, end.y), o.y - SEGMENT_CLEARANCE) <
        Math.min(Math.max(pen.y, end.y), o.y + o.height + SEGMENT_CLEARANCE),
  );
  if (blocking.length === 0) return null;

  for (const dir of [1, -1] as const) {
    const bypassX =
      dir === 1
        ? Math.max(...blocking.map((o) => o.x + o.width)) + CHANNEL_CLEARANCE + stagger
        : Math.min(...blocking.map((o) => o.x)) - CHANNEL_CLEARANCE - stagger;
    const entryX = dir === 1 ? tgt.x + tgt.width : tgt.x;
    const candidate = [
      ...pts.slice(0, pts.length - 2).map((p) => ({ ...p })),
      { x: bypassX, y: pen.y },
      { x: bypassX, y: tgt.centerY },
      { x: entryX, y: tgt.centerY },
    ];
    const before = candidate[candidate.length - 4];
    if (before && Math.abs(before.y - pen.y) > 0.5) return null;
    return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main repair entry point
// ---------------------------------------------------------------------------

/**
 * A routed polyline can still run a riser straight through a node that happens
 * to sit in the column it climbs.  Rather than teach each routing case about
 * every element that might be above or below it, nudge the finished polyline:
 * for each interior straight segment that intersects a node it does not
 * connect, try shifting that segment sideways (or up/down) into a clear gap,
 * keeping the polyline orthogonal by moving both of its endpoints.
 */
/**
 * The obstacle set a route between `flow`'s endpoints is judged against:
 * sibling nodes in the same container, already-placed paths in
 * `blockedPaths`, and container boundary strips. Shared by
 * repairSegmentCollisions and countRouteHits so "how many hits does this
 * route have" always means the same thing regardless of which one asks.
 */
function routeObstacles(
  layout: ProcessLayoutResult,
  flow: any,
  blockedPaths: Map<string, Array<{ x: number; y: number }>>,
): NodeLayout[] {
  const endpoints = new Set([flow?.sourceRef?.id, flow?.targetRef?.id]);
  const srcNodeForScope = layout.nodes.get(flow?.sourceRef?.id);
  const internalSubProcessFlow =
    srcNodeForScope?.isSubProcessChild && layout.nodes.get(flow?.targetRef?.id)?.isSubProcessChild;
  const obstacles = Array.from(layout.nodes.values()).filter((n) => {
    if (endpoints.has(n.id)) return false;
    if (internalSubProcessFlow) {
      // An internal flow is only obstructed by its own container's other
      // children -- a top-level node or a sibling subprocess's content
      // lives in a different, non-overlapping coordinate area (#26).
      return (
        n.element?.$type !== "bpmn:SubProcess" &&
        Boolean(n.isSubProcessChild) &&
        n.containerId === srcNodeForScope!.containerId
      );
    }

    // External routes must go around an expanded subprocess as one opaque
    // boundary. Its children are not independently routable in this space.
    return !n.isSubProcessChild;
  });
  obstacles.push(...pathObstacles(blockedPaths, flow?.id));
  obstacles.push(...(layout.containerObstacles ?? []));
  return obstacles;
}

/**
 * Count how many obstacle hits `points` has against the same obstacle set
 * repairSegmentCollisions would use. Lets a caller decide a route is
 * already good without re-running the repair machinery on it (see #10) --
 * useful for skipping a pass over a route a *different* obstacle set might
 * otherwise perturb even though nothing is actually wrong with it.
 */
export function countRouteHits(
  points: Array<{ x: number; y: number }>,
  layout: ProcessLayoutResult,
  flow: any,
  blockedPaths: Map<string, Array<{ x: number; y: number }>> = new Map(),
): number {
  const obstacles = routeObstacles(layout, flow, blockedPaths);
  let n = 0;
  for (let i = 0; i < points.length - 1; i += 1) n += segmentHitCount(points[i]!, points[i + 1]!, obstacles);
  return n;
}

export function repairSegmentCollisions(
  waypoints: Array<{ x: number; y: number }>,
  layout: ProcessLayoutResult,
  flow: any,
  blockedPaths: Map<string, Array<{ x: number; y: number }>> = new Map(),
  routingPolicy: RoutingPolicy = DEFAULT_ROUTING_POLICY,
): Array<{ x: number; y: number }> {
  if (waypoints.length < 2) return waypoints;
  const obstacles = routeObstacles(layout, flow, blockedPaths);

  const hits = (pts: Array<{ x: number; y: number }>): number => {
    let n = 0;
    for (let i = 0; i < pts.length - 1; i += 1) n += segmentHitCount(pts[i]!, pts[i + 1]!, obstacles);
    return n;
  };

  let best = normalizeCardinalDeparture(waypoints, layout.nodes.get(flow?.sourceRef?.id));
  let bestHits = hits(best);

  const srcNode = layout.nodes.get(flow?.sourceRef?.id);
  const tgtNode = layout.nodes.get(flow?.targetRef?.id);
  const meetsRoutingPolicy = (points: Array<{ x: number; y: number }>): boolean =>
    (!routingPolicy.requireOrthogonal || isOrthogonal(points)) &&
    routeTurns(points) >= routingPolicy.minimumTurns;
  if (bestHits === 0 && validateConnectionPoints(best, srcNode, tgtNode) && meetsRoutingPolicy(best)) {
    return best;
  }

  const targetPoints = tgtNode
    ? [
        best[best.length - 1]!,
        { x: tgtNode.centerX, y: tgtNode.y },
        { x: tgtNode.centerX, y: tgtNode.y + tgtNode.height },
        { x: tgtNode.x, y: tgtNode.centerY },
        { x: tgtNode.x + tgtNode.width, y: tgtNode.centerY },
      ]
    : [best[best.length - 1]!];
  const sourcePoints = srcNode
      ? [
          { x: srcNode.x, y: srcNode.centerY },
          { x: srcNode.x + srcNode.width, y: srcNode.centerY },
          { x: srcNode.centerX, y: srcNode.y },
          { x: srcNode.centerX, y: srcNode.y + srcNode.height },
        ]
      : [best[0]!];

  const visibilityRoutes: Array<{ points: Array<{ x: number; y: number }>; hits: number }> = [];
  for (const sourcePoint of sourcePoints) {
      for (const targetPoint of targetPoints) {
        const routeInput = [sourcePoint, targetPoint];
        const candidate = findRectilinearRoute(routeInput, obstacles, srcNode, tgtNode);
        if (
          !candidate ||
          hits(candidate) > 0 ||
          !validateConnectionPoints(candidate, srcNode, tgtNode)
        ) {
          continue;
        }
        visibilityRoutes.push({ points: candidate, hits: hits(candidate) });
      }
  }
  const visibilityRoute = choosePreferredRoute(
    visibilityRoutes.filter((r) => r.hits === 0).map((r) => r.points),
    routingPolicy,
  );
  if (visibilityRoute) return visibilityRoute;
  if (bestHits === 0 && validateConnectionPoints(best, srcNode, tgtNode)) return best;

  const staysOnNode = (idx: number, moved: { x: number; y: number }): boolean => {
    const node = idx === 0 ? srcNode : idx === best.length - 1 ? tgtNode : undefined;
    if (!node) return true;
    return (
      moved.x >= node.x &&
      moved.x <= node.x + node.width &&
      moved.y >= node.y &&
      moved.y <= node.y + node.height
    );
  };

  for (let i = 0; i < best.length - 1 && bestHits > 0; i += 1) {
    const a = best[i]!;
    const b = best[i + 1]!;
    const vertical = Math.abs(a.x - b.x) < 0.5;
    const horizontal = Math.abs(a.y - b.y) < 0.5;
    if (!vertical && !horizontal) continue;
    for (const delta of SEGMENT_NUDGES) {
      const candidate = best.map((p, idx) =>
        idx === i || idx === i + 1
          ? vertical
            ? { x: p.x + delta, y: p.y }
            : { x: p.x, y: p.y + delta }
          : { ...p },
      );
      if (!staysOnNode(i, candidate[i]!) || !staysOnNode(i + 1, candidate[i + 1]!)) continue;
      if (!leavesOutward(candidate, srcNode, tgtNode)) continue;
      const candidateHits = hits(candidate);
      if (candidateHits < bestHits) {
        best = candidate;
        bestHits = candidateHits;
        if (bestHits === 0) break;
      }
    }
  }

  if (bestHits > 0 && tgtNode) {
    const siblings = layout.allFlows.filter((f: any) => f.targetRef?.id === tgtNode.id);
    const rank = Math.max(
      0,
      siblings.findIndex((f: any) => f.id === flow?.id),
    );
    const detour = approachFromSide(best, tgtNode, obstacles, rank * CHANNEL_LANE_GAP);
    if (detour && hits(detour) === 0) return detour;
  }
  return best;
}
