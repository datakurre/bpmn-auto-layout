import type { DirectedGraph } from './graph';

export function findFeedbackEdges(graph: DirectedGraph): Set<string> {
  const feedbackEdges = new Set<string>();
  const state = new Map<string, number>(); // 0: UNVISITED, 1: VISITING, 2: VISITED

  const nodes = graph.getNodes();
  for (const node of nodes) {
    state.set(node.id, 0);
  }

  function dfs(uId: string): void {
    state.set(uId, 1);
    const outEdges = graph.outEdges(uId).sort((a, b) => a.target.localeCompare(b.target));

    for (const edge of outEdges) {
      const vId = edge.target;
      const vState = state.get(vId) || 0;

      if (vState === 1) {
        // Back-edge detected
        feedbackEdges.add(edge.id);
      } else if (vState === 0) {
        dfs(vId);
      }
    }

    state.set(uId, 2);
  }

  // Start DFS from nodes with in-degree 0 first, then any unvisited
  const startNodes = nodes
    .filter((n) => graph.inEdges(n.id).length === 0)
    .concat(nodes.filter((n) => graph.inEdges(n.id).length > 0));

  for (const node of startNodes) {
    if ((state.get(node.id) || 0) === 0) {
      dfs(node.id);
    }
  }

  return feedbackEdges;
}
