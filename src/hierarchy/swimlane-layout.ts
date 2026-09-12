import type { Bounds, Point } from '../types';
import { LANE_MIN_HEIGHT } from '../di-constants';

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
  const laneResults: Array<{ element: any; bounds: Bounds }> = [];
  const nodeToLane = new Map<string, string>();

  for (const lane of rawLanes) {
    const refs = lane.flowNodeRef || [];
    for (const ref of refs) {
      const refId = ref.id || ref;
      nodeToLane.set(refId, lane.id);
    }
  }

  let currentY = options.startY;

  for (const lane of rawLanes) {
    const laneElements = shapes.filter((s) => nodeToLane.get(s.element.id) === lane.id);
    const laneNodeIds = new Set(laneElements.map((s) => s.element.id));
    const laneFeedbackEdges =
      options.edges?.filter((e) => {
        const srcId = e.element.sourceRef?.id || e.element.sourceRef;
        return Boolean(e.isFeedback) && laneNodeIds.has(srcId);
      }) || [];

    const laneHeight = computeSingleLaneHeight(laneElements, laneFeedbackEdges, currentY);

    laneResults.push({
      element: lane,
      bounds: {
        x: options.startX,
        y: currentY,
        width: options.totalWidth,
        height: laneHeight,
      },
    });

    currentY += laneHeight;
  }

  return {
    lanes: laneResults,
    totalHeight: currentY - options.startY,
  };
}

function computeSingleLaneHeight(
  laneElements: Array<{ bounds: Bounds }>,
  laneFeedbackEdges: Array<{ waypoints: Point[] }>,
  currentY: number
): number {
  if (laneElements.length === 0) {
    return LANE_MIN_HEIGHT;
  }

  let minY = Infinity;
  let maxY = -Infinity;
  for (const el of laneElements) {
    minY = Math.min(minY, el.bounds.y);
    maxY = Math.max(maxY, el.bounds.y + el.bounds.height);
  }
  let maxEdgeY = -Infinity;
  for (const edge of laneFeedbackEdges) {
    for (const wp of edge.waypoints) {
      maxEdgeY = Math.max(maxEdgeY, wp.y);
    }
  }

  if (maxEdgeY > -Infinity) {
    return Math.max(LANE_MIN_HEIGHT, maxEdgeY - currentY + 30);
  }
  return Math.max(LANE_MIN_HEIGHT, maxY - minY + 40);
}

export interface MessageFlowRouteOptions {
  obstacles?: Bounds[];
  interPoolChannelY?: number;
  targetPortX?: number;
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
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);
  return ctx.obstacles.some(
    (b) =>
      !ctx.ignore.includes(b) && x > b.x && x < b.x + b.width && b.y + b.height > minY && b.y < maxY
  );
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

  // Source is above target
  if (sourceBounds.y + sourceBounds.height <= targetBounds.y) {
    const srcBottom: Point = {
      x: Math.round(sourceBounds.x + sourceBounds.width / 2),
      y: sourceBounds.y + sourceBounds.height,
    };
    const tgtX = opts.targetPortX ?? Math.round(targetBounds.x + targetBounds.width / 2);
    const tgtTop: Point = {
      x: tgtX,
      y: targetBounds.y,
    };

    if (srcBottom.x === tgtTop.x) {
      return [srcBottom, tgtTop];
    }

    const midY = opts.interPoolChannelY ?? Math.round((srcBottom.y + tgtTop.y) / 2);
    const blocked = isMessageCorridorBlocked(srcBottom.x, [srcBottom.y, midY], {
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
        { x: tgtTop.x, y: midY },
        tgtTop,
      ];
    }

    return [srcBottom, { x: srcBottom.x, y: midY }, { x: tgtTop.x, y: midY }, tgtTop];
  }

  // Source is below target
  const srcTop: Point = {
    x: Math.round(sourceBounds.x + sourceBounds.width / 2),
    y: sourceBounds.y,
  };
  const tgtX = opts.targetPortX ?? Math.round(targetBounds.x + targetBounds.width / 2);
  const tgtBottom: Point = {
    x: tgtX,
    y: targetBounds.y + targetBounds.height,
  };

  if (srcTop.x === tgtBottom.x) {
    return [srcTop, tgtBottom];
  }

  const midY = opts.interPoolChannelY ?? Math.round((srcTop.y + tgtBottom.y) / 2);
  const blocked = isMessageCorridorBlocked(srcTop.x, [srcTop.y, midY], {
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
      { x: tgtBottom.x, y: midY },
      tgtBottom,
    ];
  }

  return [srcTop, { x: srcTop.x, y: midY }, { x: tgtBottom.x, y: midY }, tgtBottom];
}
