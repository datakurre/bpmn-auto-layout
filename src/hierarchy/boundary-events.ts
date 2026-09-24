import type { Bounds, Point } from '../types';
import type { DirectedGraph } from '../graph/graph';
import { getRefId } from './subprocess-layout';

export interface BoundarySortContext {
  hostBounds: Bounds;
  graph: DirectedGraph;
  boundsMap: Map<string, Bounds>;
}

export function addBoundaryEventEdges(
  graph: DirectedGraph,
  boundaryEvents: any[],
  startOrder = 0
): void {
  for (let i = 0; i < boundaryEvents.length; i++) {
    const bEvent = boundaryEvents[i];
    graph.addNode(bEvent.id, bEvent, startOrder + i);
    const hostId = getRefId(bEvent.attachedToRef);
    if (hostId && graph.getNode(hostId)) {
      graph.addEdge({
        id: `#attach:${bEvent.id}`,
        source: hostId,
        target: bEvent.id,
        data: null,
        order: startOrder + i,
        kind: 'attach',
      });
    }
  }
}

export function sortBoundaryEventsByTarget(events: any[], ctx: BoundarySortContext): void {
  const { hostBounds, graph, boundsMap } = ctx;
  events.sort((a, b) => {
    const targetA = graph.outEdges(a.id)[0]?.target;
    const targetB = graph.outEdges(b.id)[0]?.target;
    const boundsA = targetA ? boundsMap.get(targetA) : undefined;
    const boundsB = targetB ? boundsMap.get(targetB) : undefined;
    const yA = boundsA ? boundsA.y : 0;
    const yB = boundsB ? boundsB.y : 0;
    if (yA !== yB) {
      return yB - yA;
    }
    return a.id.localeCompare(b.id);
  });

  const count = events.length;
  if (count === 1) {
    const x = Math.round(hostBounds.x + (hostBounds.width - 36) / 2);
    const y = Math.round(hostBounds.y + hostBounds.height - 18);
    boundsMap.set(events[0].id, { x, y, width: 36, height: 36 });
    return;
  }

  const minX = hostBounds.x + 10;
  const maxX = hostBounds.x + hostBounds.width - 46;
  const step = (maxX - minX) / (count - 1);
  for (let i = 0; i < count; i++) {
    const x = Math.round(minX + i * step);
    const y = Math.round(hostBounds.y + hostBounds.height - 18);
    boundsMap.set(events[i].id, { x, y, width: 36, height: 36 });
  }
}

export function placeBoundaries(
  boundaryEvents: any[],
  boundsMap: Map<string, Bounds>,
  graph: DirectedGraph
): void {
  const eventsByHost = new Map<string, any[]>();
  for (const b of boundaryEvents) {
    const hostId = b.attachedToRef?.id || b.attachedToRef;
    if (hostId) {
      const list = eventsByHost.get(hostId) || [];
      list.push(b);
      eventsByHost.set(hostId, list);
    }
  }

  for (const [hostId, events] of eventsByHost.entries()) {
    const hostBounds = boundsMap.get(hostId);
    if (hostBounds) {
      sortBoundaryEventsByTarget(events, { hostBounds, graph, boundsMap });
    }
  }
}

export function ensureBoundariesAttached(shapes: Array<{ element: any; bounds: Bounds }>): void {
  const shapesMap = new Map(shapes.map((s) => [s.element.id, s]));
  const eventsByHost = new Map<string, Array<{ element: any; bounds: Bounds }>>();

  for (const s of shapes) {
    if (s.element?.$type === 'bpmn:BoundaryEvent' || s.element?.attachedToRef) {
      const hostId = getRefId(s.element.attachedToRef);
      if (hostId && shapesMap.has(hostId)) {
        const list = eventsByHost.get(hostId) || [];
        list.push(s);
        eventsByHost.set(hostId, list);
      }
    }
  }

  for (const [hostId, events] of eventsByHost.entries()) {
    const hostShape = shapesMap.get(hostId)!;
    const hostBounds = hostShape.bounds;
    const count = events.length;
    const expectedY = Math.round(hostBounds.y + hostBounds.height - 18);

    if (count === 1) {
      events[0].bounds.x = Math.round(hostBounds.x + (hostBounds.width - 36) / 2);
      events[0].bounds.y = expectedY;
      continue;
    }

    events.sort((a, b) => a.bounds.x - b.bounds.x);
    const minX = hostBounds.x + 10;
    const maxX = hostBounds.x + hostBounds.width - 46;
    const step = (maxX - minX) / (count - 1);
    for (let i = 0; i < count; i++) {
      events[i].bounds.x = Math.round(minX + i * step);
      events[i].bounds.y = expectedY;
    }
  }
}

function isSegmentObstructed(a: Point, b: Point, obs: Bounds): boolean {
  if (a.x === b.x) {
    if (a.x <= obs.x || a.x >= obs.x + obs.width) {
      return false;
    }
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);
    return Math.max(minY, obs.y) < Math.min(maxY, obs.y + obs.height);
  }
  if (a.y <= obs.y || a.y >= obs.y + obs.height) {
    return false;
  }
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  return Math.max(minX, obs.x) < Math.min(maxX, obs.x + obs.width);
}

function routeBackwardBoundaryExit(
  sourceBounds: Bounds,
  targetBounds: Bounds,
  filtered: Bounds[]
): Point[] {
  const srcBottom: Point = {
    x: Math.round(sourceBounds.x + sourceBounds.width / 2),
    y: sourceBounds.y + sourceBounds.height,
  };
  const tgtEntry: Point = {
    x: targetBounds.x,
    y: Math.round(targetBounds.y + targetBounds.height / 2),
  };

  if (targetBounds.x + targetBounds.width <= sourceBounds.x) {
    const tgtEast: Point = {
      x: targetBounds.x + targetBounds.width,
      y: tgtEntry.y,
    };
    const corner: Point = { x: srcBottom.x, y: tgtEast.y };
    const directBlocked = filtered.some(
      (obs) =>
        isSegmentObstructed(srcBottom, corner, obs) || isSegmentObstructed(corner, tgtEast, obs)
    );
    if (!directBlocked && tgtEast.y > srcBottom.y) {
      return [srcBottom, corner, tgtEast];
    }
  }
  const minX = Math.min(sourceBounds.x, targetBounds.x);
  const maxX = Math.max(sourceBounds.x + sourceBounds.width, targetBounds.x + targetBounds.width);
  let maxBottomY = Math.max(
    sourceBounds.y + sourceBounds.height,
    targetBounds.y + targetBounds.height
  );
  for (const b of filtered) {
    if (b.x + b.width >= minX && b.x <= maxX) {
      maxBottomY = Math.max(maxBottomY, b.y + b.height);
    }
  }
  const channelY = maxBottomY + 40;
  const stepTgtX = targetBounds.x - 20;

  const dropBlockers = filtered.filter((obs) =>
    isSegmentObstructed(srcBottom, { x: srcBottom.x, y: channelY }, obs)
  );
  if (dropBlockers.length > 0) {
    const minTop = Math.min(...dropBlockers.map((b) => b.y));
    const maxRight = Math.max(...dropBlockers.map((b) => b.x + b.width));
    const stepY = Math.round((srcBottom.y + minTop) / 2);
    const stepX = maxRight + 20;
    return [
      srcBottom,
      { x: srcBottom.x, y: stepY },
      { x: stepX, y: stepY },
      { x: stepX, y: channelY },
      { x: stepTgtX, y: channelY },
      { x: stepTgtX, y: tgtEntry.y },
      tgtEntry,
    ];
  }

  return [
    srcBottom,
    { x: srcBottom.x, y: channelY },
    { x: stepTgtX, y: channelY },
    { x: stepTgtX, y: tgtEntry.y },
    tgtEntry,
  ];
}

export function routeBoundaryExit(
  sourceBounds: Bounds,
  targetBounds: Bounds,
  obstacles?: Bounds[]
): Point[] {
  const srcBottom: Point = {
    x: Math.round(sourceBounds.x + sourceBounds.width / 2),
    y: sourceBounds.y + sourceBounds.height,
  };
  const tgtCenter: Point = {
    x: Math.round(targetBounds.x + targetBounds.width / 2),
    y: Math.round(targetBounds.y + targetBounds.height / 2),
  };
  if (
    targetBounds.y >= sourceBounds.y + sourceBounds.height &&
    Math.abs(srcBottom.x - tgtCenter.x) <= 20
  ) {
    return [srcBottom, { x: srcBottom.x, y: targetBounds.y }];
  }
  const tgtEntry: Point = {
    x: targetBounds.x,
    y: tgtCenter.y,
  };
  const corner = { x: srcBottom.x, y: tgtEntry.y };
  const filtered = (obstacles || []).filter((obs) => obs !== sourceBounds && obs !== targetBounds);
  if (targetBounds.x <= sourceBounds.x) {
    return routeBackwardBoundaryExit(sourceBounds, targetBounds, filtered);
  }

  if (!obstacles || obstacles.length === 0) {
    return [srcBottom, corner, tgtEntry];
  }

  const isDirectBlocked = filtered.some(
    (obs) =>
      isSegmentObstructed(srcBottom, corner, obs) || isSegmentObstructed(corner, tgtEntry, obs)
  );
  if (!isDirectBlocked) {
    return [srcBottom, corner, tgtEntry];
  }

  const vBlockers = filtered.filter((obs) => isSegmentObstructed(srcBottom, corner, obs));
  if (vBlockers.length > 0) {
    const maxBottom = Math.max(srcBottom.y, ...vBlockers.map((b) => b.y + b.height));
    const minTop = Math.min(...vBlockers.map((b) => b.y));
    const maxRight = Math.max(...vBlockers.map((b) => b.x + b.width));
    const stepY = corner.y < srcBottom.y ? maxBottom + 20 : Math.round((srcBottom.y + minTop) / 2);
    const stepX = Math.max(maxRight + 20, srcBottom.x + 20);
    if (stepX < tgtEntry.x) {
      return [
        srcBottom,
        { x: srcBottom.x, y: stepY },
        { x: stepX, y: stepY },
        { x: stepX, y: tgtEntry.y },
        tgtEntry,
      ];
    }
  }

  const hBlockers = filtered.filter((obs) => isSegmentObstructed(corner, tgtEntry, obs));
  if (hBlockers.length > 0) {
    let maxBottom = Math.max(...hBlockers.map((b) => b.y + b.height));
    for (const b of filtered) {
      if (b.x + b.width >= srcBottom.x && b.x <= tgtEntry.x) {
        maxBottom = Math.max(maxBottom, b.y + b.height);
      }
    }
    const detourY = maxBottom + 20;
    const stepX = Math.max(srcBottom.x, targetBounds.x - 20);
    return [
      srcBottom,
      { x: srcBottom.x, y: detourY },
      { x: stepX, y: detourY },
      { x: stepX, y: tgtEntry.y },
      tgtEntry,
    ];
  }

  return [srcBottom, corner, tgtEntry];
}
