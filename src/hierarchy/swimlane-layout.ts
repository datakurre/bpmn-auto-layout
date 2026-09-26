import type { Bounds, Point } from '../types';
import { LANE_MIN_HEIGHT } from '../di-constants';
import { verticalSegmentHitsBox } from '../graph/obstacles';

export interface LaneLayoutResult {
  lanes: Array<{ element: any; bounds: Bounds }>;
  totalHeight: number;
}

export interface LaneLayoutOptions {
  startX: number;
  startY: number;
  totalWidth: number;
  edges?: Array<{ element: any; waypoints: Point[]; isFeedback?: boolean }>;
}

function buildNodeToLaneMap(
  rawLanes: any[],
  shapes: Array<{ element: any; bounds: Bounds }>
): Map<string, string> {
  const nodeToLane = new Map<string, string>();

  for (const lane of rawLanes) {
    const refs = lane.flowNodeRef || [];
    for (const ref of refs) {
      const refId = ref.id || ref;
      nodeToLane.set(refId, lane.id);
    }
  }

  for (const s of shapes) {
    if (s.element?.$type === 'bpmn:BoundaryEvent' && !nodeToLane.has(s.element.id)) {
      const hostId = s.element.attachedToRef?.id || s.element.attachedToRef;
      const hostLane = nodeToLane.get(hostId);
      if (hostLane) {
        nodeToLane.set(s.element.id, hostLane);
      }
    }
  }

  return nodeToLane;
}

export function layoutProcessLanes(
  process: any,
  shapes: Array<{ element: any; bounds: Bounds }>,
  options: LaneLayoutOptions
): LaneLayoutResult {
  const laneSets = process.laneSets || [];
  if (laneSets.length === 0 || !laneSets[0].lanes || laneSets[0].lanes.length === 0) {
    return { lanes: [], totalHeight: 0 };
  }

  const rawLanes = laneSets[0].lanes;
  const nodeToLane = buildNodeToLaneMap(rawLanes, shapes);

  const extents = rawLanes.map((lane: any) => {
    const laneElements = shapes.filter((s) => nodeToLane.get(s.element.id) === lane.id);
    const laneNodeIds = new Set(laneElements.map((s) => s.element.id));
    return computeSingleLaneExtent(laneElements, laneNodeIds, options.edges);
  });

  const laneDividers = computeLaneDividers(extents, options.startY);
  const laneResults: Array<{ element: any; bounds: Bounds }> = [];
  let prevY = options.startY;

  for (let i = 0; i < rawLanes.length; i++) {
    const dividerY = laneDividers[i];
    laneResults.push({
      element: rawLanes[i],
      bounds: {
        x: options.startX,
        y: prevY,
        width: options.totalWidth,
        height: dividerY - prevY,
      },
    });
    prevY = dividerY;
  }

  return {
    lanes: laneResults,
    totalHeight: prevY - options.startY,
  };
}

interface LaneContentExtent {
  hasContent: boolean;
  minY: number;
  maxY: number;
}

function computeSingleLaneExtent(
  laneElements: Array<{ bounds: Bounds }>,
  laneNodeIds: Set<string>,
  edges: Array<{ element: any; waypoints: Point[]; isFeedback?: boolean }> | undefined
): LaneContentExtent {
  if (laneElements.length === 0) {
    return { hasContent: false, minY: Infinity, maxY: -Infinity };
  }

  let minY = Infinity;
  let maxY = -Infinity;
  for (const el of laneElements) {
    minY = Math.min(minY, el.bounds.y);
    maxY = Math.max(maxY, el.bounds.y + el.bounds.height);
  }

  if (edges) {
    for (const e of edges) {
      const srcId = e.element.sourceRef?.id || e.element.sourceRef;
      const tgtId = e.element.targetRef?.id || e.element.targetRef;
      const isIntraLane = laneNodeIds.has(srcId) && laneNodeIds.has(tgtId);
      const isFeedbackFromLane = Boolean(e.isFeedback) && laneNodeIds.has(srcId);
      if (isIntraLane || isFeedbackFromLane) {
        for (const wp of e.waypoints) {
          minY = Math.min(minY, wp.y);
          maxY = Math.max(maxY, wp.y);
        }
      }
    }
  }

  return { hasContent: true, minY, maxY };
}

function computeLaneDividers(extents: LaneContentExtent[], startY: number): number[] {
  const n = extents.length;
  const dividers: number[] = [];
  let prevY = startY;

  for (let i = 0; i < n - 1; i++) {
    const curr = extents[i];
    const next = extents[i + 1];

    let minBottom = prevY + LANE_MIN_HEIGHT;
    if (curr.hasContent) {
      minBottom = Math.max(minBottom, curr.maxY + 20);
    }

    let dividerY = minBottom;
    if (curr.hasContent && next.hasContent) {
      const idealMid = Math.round((curr.maxY + next.minY) / 2);
      dividerY = Math.max(minBottom, idealMid);
      const maxDivider = next.minY - 20;
      if (maxDivider >= minBottom) {
        dividerY = Math.min(dividerY, maxDivider);
      }
    }

    dividers.push(dividerY);
    prevY = dividerY;
  }

  const last = extents[n - 1];
  let lastBottom = prevY + LANE_MIN_HEIGHT;
  if (last?.hasContent) {
    lastBottom = Math.max(lastBottom, last.maxY + 25);
  }
  dividers.push(lastBottom);

  return dividers;
}

export interface MessageFlowRouteOptions {
  obstacles?: Bounds[];
  interPoolChannelY?: number;
  targetPortX?: number;
  sourcePortX?: number;
}

export function isMessageCorridorBlocked(
  x: number,
  yRange: [number, number],
  ctx: { ignore: Bounds[]; obstacles?: Bounds[] }
): boolean {
  if (!ctx.obstacles) {
    return false;
  }
  const [y1, y2] = yRange;
  const span = { start: y1, end: y2 };
  return ctx.obstacles.some((b) => {
    if (ctx.ignore.includes(b)) {
      return false;
    }
    const enclosesAny = ctx.ignore.some(
      (ig) =>
        ig.x >= b.x - 5 &&
        ig.x + ig.width <= b.x + b.width + 5 &&
        ig.y >= b.y - 5 &&
        ig.y + ig.height <= b.y + b.height + 5
    );
    if (enclosesAny) {
      return false;
    }
    return verticalSegmentHitsBox(x, span, b);
  });
}

/** Keeps a straight message flow off the rounded corners of the shape it leaves/enters. */
const MESSAGE_PORT_EDGE_INSET = 10;

/**
 * An x at which a vertical message flow can leave `source` and enter `target`
 * without a jog, or undefined when the shapes don't overlap enough.
 *
 * A port fixed by the caller (a pool's spread port, or a target port spread
 * among several incoming flows) is kept when the other shape can meet it;
 * when both ports are fixed the caller already chose, so there's nothing to
 * slide. With neither fixed, use the point of the overlap nearest the
 * source's center.
 */
function findSharedStraightX(
  source: Bounds,
  target: Bounds,
  ports: { sourcePortX?: number; targetPortX?: number }
): number | undefined {
  const lo = Math.max(source.x, target.x) + MESSAGE_PORT_EDGE_INSET;
  const hi = Math.min(source.x + source.width, target.x + target.width) - MESSAGE_PORT_EDGE_INSET;
  if (lo > hi) {
    return undefined;
  }
  const { sourcePortX, targetPortX } = ports;
  if (sourcePortX !== undefined && targetPortX !== undefined) {
    return undefined;
  }
  const fixed = sourcePortX ?? targetPortX;
  if (fixed !== undefined) {
    return fixed >= lo && fixed <= hi ? fixed : undefined;
  }
  const sourceCenter = Math.round(source.x + source.width / 2);
  return Math.min(hi, Math.max(lo, sourceCenter));
}

export function routeMessageFlow(
  sourceBounds: Bounds,
  targetBounds: Bounds,
  options?: MessageFlowRouteOptions | Bounds[]
): Point[] {
  const opts: MessageFlowRouteOptions = Array.isArray(options)
    ? { obstacles: options }
    : (options ?? {});
  const ignore = [sourceBounds, targetBounds];

  const isAbove = sourceBounds.y + sourceBounds.height <= targetBounds.y;
  const srcY = isAbove ? sourceBounds.y + sourceBounds.height : sourceBounds.y;
  const tgtY = isAbove ? targetBounds.y : targetBounds.y + targetBounds.height;

  const srcX = opts.sourcePortX ?? Math.round(sourceBounds.x + sourceBounds.width / 2);
  const srcPort: Point = { x: srcX, y: srcY };
  const tgtX = opts.targetPortX ?? Math.round(targetBounds.x + targetBounds.width / 2);
  const tgtPort: Point = { x: tgtX, y: tgtY };

  // A message flow doesn't have to leave its source at the center: when the
  // two shapes overlap horizontally, run straight at an x inside both instead
  // of stepping sideways just to leave from the middle of the edge.
  const straightX = findSharedStraightX(sourceBounds, targetBounds, {
    sourcePortX: opts.sourcePortX,
    targetPortX: opts.targetPortX,
  });
  if (straightX !== undefined) {
    const blocked = isMessageCorridorBlocked(straightX, [srcY, tgtY], {
      ignore,
      obstacles: opts.obstacles,
    });
    if (!blocked) {
      return [
        { x: straightX, y: srcY },
        { x: straightX, y: tgtY },
      ];
    }
  }

  if (srcPort.x === tgtPort.x) {
    const blocked = isMessageCorridorBlocked(srcPort.x, [srcPort.y, tgtPort.y], {
      ignore,
      obstacles: opts.obstacles,
    });
    if (!blocked) {
      return [srcPort, tgtPort];
    }
  }

  const midY = opts.interPoolChannelY ?? Math.round((srcPort.y + tgtPort.y) / 2);
  const blocked = isMessageCorridorBlocked(srcPort.x, [srcPort.y, midY], {
    ignore,
    obstacles: opts.obstacles,
  });

  if (blocked) {
    const srcRight: Point = {
      x: sourceBounds.x + sourceBounds.width,
      y: Math.round(sourceBounds.y + sourceBounds.height / 2),
    };
    const stepX = sourceBounds.x + sourceBounds.width + 20;
    return [
      srcRight,
      { x: stepX, y: srcRight.y },
      { x: stepX, y: midY },
      { x: tgtPort.x, y: midY },
      tgtPort,
    ];
  }

  return [srcPort, { x: srcPort.x, y: midY }, { x: tgtPort.x, y: midY }, tgtPort];
}
