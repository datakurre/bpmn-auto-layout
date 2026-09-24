import { DirectedGraph, isAttachEdge } from './graph';
import { routeOrthogonalEdge } from './orthogonal-router';
import type { Bounds, Point } from '../types';

export interface DummyNodeContext {
  feedbackEdges?: Set<string>;
}

export interface DummyInsertionResult {
  augmentedGraph: DirectedGraph;
  augmentedRanks: Map<string, number>;
  edgeDummyChains: Map<string, string[]>;
}

export function insertDummyNodes(
  graph: DirectedGraph,
  ranks: Map<string, number>,
  ctx?: DummyNodeContext
): DummyInsertionResult {
  const augmentedGraph = new DirectedGraph();
  const augmentedRanks = new Map<string, number>(ranks);
  const edgeDummyChains = new Map<string, string[]>();

  for (const node of graph.getNodes()) {
    augmentedGraph.addNode(node.id, node.data, node.order);
  }

  for (const edge of graph.getEdges()) {
    if (ctx?.feedbackEdges?.has(edge.id) || isAttachEdge(edge)) {
      augmentedGraph.addEdge(edge);
      continue;
    }

    const rU = ranks.get(edge.source);
    const rV = ranks.get(edge.target);
    if (rU === undefined || rV === undefined || rV - rU <= 1) {
      augmentedGraph.addEdge(edge);
      continue;
    }

    const chain: string[] = [];
    let prevNodeId = edge.source;
    for (let r = rU + 1; r < rV; r++) {
      const dummyId = `_dummy_${edge.id}_${r}`;
      augmentedGraph.addNode(
        dummyId,
        { $type: '__dummy__', isDummy: true, originalEdgeId: edge.id, rank: r },
        edge.order
      );
      augmentedRanks.set(dummyId, r);
      chain.push(dummyId);

      augmentedGraph.addEdge({
        id: `#dummy:${edge.id}:${r}`,
        source: prevNodeId,
        target: dummyId,
        data: null,
        order: edge.order,
        kind: 'dummy',
      });
      prevNodeId = dummyId;
    }

    augmentedGraph.addEdge({
      id: `#dummy:${edge.id}:${rV}`,
      source: prevNodeId,
      target: edge.target,
      data: null,
      order: edge.order,
      kind: 'dummy',
    });

    edgeDummyChains.set(edge.id, chain);
  }

  return { augmentedGraph, augmentedRanks, edgeDummyChains };
}

export function alignMergeNodeTrack(
  _nodeId: string,
  inEdges: Array<{ source: string }>,
  tracks: Map<string, number>
): number {
  const parentTracks = inEdges.map((e) => tracks.get(e.source) ?? 0);
  const avg = parentTracks.reduce((a, b) => a + b, 0) / parentTracks.length;
  if (Number.isInteger(avg)) {
    return avg;
  }
  const integerParent = parentTracks.find((t) => Number.isInteger(t));
  if (integerParent !== undefined && Math.abs(integerParent - avg) <= 1) {
    return integerParent;
  }
  return Math.round(avg);
}

/**
 * Routes an edge through the reserved corridor of its dummy node chain instead
 * of jumping straight from source to target. `anchors` is the ordered list of
 * points to pass through: the flow's own exit point, the center of each dummy
 * node bounds along the way, then the flow's own entry point.
 *
 * NOT wired into the layout pipeline (see #81) -- and not just pending a
 * straightening sweep. `computeFlatTracks` already runs one
 * (`refineDummyTracksWithBarycenterSweeps`, two forward/backward passes), and
 * it works: a chain's dummies do land on a straight line between their real
 * endpoints. That still doesn't help, because a multi-rank edge's target is
 * -- by construction of `assignLayers`' longest-path ranking -- essentially
 * always a merge point: a node only ends up several ranks past one
 * particular parent when some *other*, typically longer, incoming path
 * pushed its rank up, and that other path usually joins at the very node the
 * bypass also targets. A merge target's track is deliberately the average of
 * every one of its parents (`alignMergeNodeTrack`), not slaved to any one of
 * them, so the straightened chain lines up with a track the target was never
 * going to sit on. Verified exhaustively: every dummy-chain edge in the full
 * fixture corpus (curated + regression + generated) targets a merge node,
 * with zero exceptions, and a synthetic single-incoming-edge bypass target
 * produces byte-identical output whether routed through the corridor or
 * direct -- the corridor is never wrong, just provably inert.
 *
 * Making this pay off would mean biasing merge-track alignment toward one
 * preferred parent instead of averaging all of them -- a change to how every
 * merge in every diagram looks, not a narrow follow-up to this function.
 */
export function routeEdgeThroughDummyChain(anchors: Point[], allBounds?: Bounds[]): Point[] {
  let waypoints: Point[] = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    const from = pointToBounds(anchors[i]);
    const to = pointToBounds(anchors[i + 1]);
    const segment = routeOrthogonalEdge(from, to, allBounds);
    waypoints = waypoints.length > 0 ? [...waypoints, ...segment.slice(1)] : segment;
  }
  return simplifyCollinearWaypoints(waypoints);
}

function pointToBounds(point: Point): Bounds {
  return { x: point.x, y: point.y, width: 0, height: 0 };
}

export function boundsCenter(bounds: Bounds): Point {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

function simplifyCollinearWaypoints(points: Point[]): Point[] {
  if (points.length < 3) {
    return points;
  }
  const result: Point[] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const prev = result[result.length - 1];
    const curr = points[i];
    const next = points[i + 1];
    const collinearHorizontal = prev.y === curr.y && curr.y === next.y;
    const collinearVertical = prev.x === curr.x && curr.x === next.x;
    if (collinearHorizontal || collinearVertical) {
      continue;
    }
    result.push(curr);
  }
  result.push(points[points.length - 1]);
  return result;
}
