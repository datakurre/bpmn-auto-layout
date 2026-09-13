import { DirectedGraph } from './graph';

export interface DummyNodeContext {
  feedbackEdges?: Set<string>;
}

export function insertDummyNodes(
  graph: DirectedGraph,
  ranks: Map<string, number>,
  ctx?: DummyNodeContext
): { augmentedGraph: DirectedGraph; augmentedRanks: Map<string, number> } {
  const augmentedGraph = new DirectedGraph();
  const augmentedRanks = new Map<string, number>(ranks);

  for (const node of graph.getNodes()) {
    augmentedGraph.addNode(node.id, node.data, node.order);
  }

  for (const edge of graph.getEdges()) {
    if (ctx?.feedbackEdges?.has(edge.id) || edge.id.startsWith('_attach_')) {
      augmentedGraph.addEdge(edge);
      continue;
    }

    const rU = ranks.get(edge.source);
    const rV = ranks.get(edge.target);
    if (rU === undefined || rV === undefined || rV - rU <= 1) {
      augmentedGraph.addEdge(edge);
      continue;
    }

    let prevNodeId = edge.source;
    for (let r = rU + 1; r < rV; r++) {
      const dummyId = `_dummy_${edge.id}_${r}`;
      augmentedGraph.addNode(
        dummyId,
        { $type: '__dummy__', isDummy: true, originalEdgeId: edge.id, rank: r },
        edge.order
      );
      augmentedRanks.set(dummyId, r);

      augmentedGraph.addEdge({
        id: `_dummy_edge_${edge.id}_${r}`,
        source: prevNodeId,
        target: dummyId,
        data: null,
        order: edge.order,
      });
      prevNodeId = dummyId;
    }

    augmentedGraph.addEdge({
      id: `_dummy_edge_${edge.id}_${rV}`,
      source: prevNodeId,
      target: edge.target,
      data: null,
      order: edge.order,
    });
  }

  return { augmentedGraph, augmentedRanks };
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
