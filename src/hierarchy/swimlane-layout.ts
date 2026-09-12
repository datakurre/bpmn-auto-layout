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
    let laneHeight = LANE_MIN_HEIGHT;

    if (laneElements.length > 0) {
      let minY = Infinity;
      let maxY = -Infinity;
      for (const el of laneElements) {
        minY = Math.min(minY, el.bounds.y);
        maxY = Math.max(maxY, el.bounds.y + el.bounds.height);
      }
      const span = maxY - minY + 40;
      laneHeight = Math.max(LANE_MIN_HEIGHT, span);
    }

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

export function routeMessageFlow(sourceBounds: Bounds, targetBounds: Bounds): Point[] {
  // Source is above target
  if (sourceBounds.y + sourceBounds.height <= targetBounds.y) {
    const srcBottom: Point = {
      x: Math.round(sourceBounds.x + sourceBounds.width / 2),
      y: sourceBounds.y + sourceBounds.height,
    };
    const tgtTop: Point = {
      x: Math.round(targetBounds.x + targetBounds.width / 2),
      y: targetBounds.y,
    };

    if (srcBottom.x === tgtTop.x) {
      return [srcBottom, tgtTop];
    }

    const midY = Math.round((srcBottom.y + tgtTop.y) / 2);
    return [srcBottom, { x: srcBottom.x, y: midY }, { x: tgtTop.x, y: midY }, tgtTop];
  }

  // Source is below target
  const srcTop: Point = {
    x: Math.round(sourceBounds.x + sourceBounds.width / 2),
    y: sourceBounds.y,
  };
  const tgtBottom: Point = {
    x: Math.round(targetBounds.x + targetBounds.width / 2),
    y: targetBounds.y + targetBounds.height,
  };

  if (srcTop.x === tgtBottom.x) {
    return [srcTop, tgtBottom];
  }

  const midY = Math.round((srcTop.y + tgtBottom.y) / 2);
  return [srcTop, { x: srcTop.x, y: midY }, { x: tgtBottom.x, y: midY }, tgtBottom];
}
