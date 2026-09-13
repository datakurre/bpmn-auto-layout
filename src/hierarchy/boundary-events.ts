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
        id: `_attach_${bEvent.id}`,
        source: hostId,
        target: bEvent.id,
        data: null,
        order: startOrder + i,
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

export function routeBoundaryExit(sourceBounds: Bounds, targetBounds: Bounds): Point[] {
  const srcBottom: Point = {
    x: Math.round(sourceBounds.x + sourceBounds.width / 2),
    y: sourceBounds.y + sourceBounds.height,
  };
  const tgtEntry: Point = {
    x: targetBounds.x,
    y: Math.round(targetBounds.y + targetBounds.height / 2),
  };
  return [srcBottom, { x: srcBottom.x, y: tgtEntry.y }, tgtEntry];
}
