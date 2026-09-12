import type { DirectedGraph } from './graph';

export function assignLayers(
  graph: DirectedGraph,
  feedbackEdges?: Set<string>
): Map<string, number> {
  const ranks = new Map<string, number>();
  const nodes = graph.getNodes();

  for (const node of nodes) {
    ranks.set(node.id, 0);
  }

  // Calculate in-degree ignoring feedback edges
  const inDegree = new Map<string, number>();
  for (const node of nodes) {
    const validInEdges = graph.inEdges(node.id).filter((e) => !feedbackEdges?.has(e.id));
    inDegree.set(node.id, validInEdges.length);
  }

  const queue: string[] = nodes
    .filter((n) => inDegree.get(n.id)! === 0)
    .map((n) => n.id)
    .sort((a, b) => a.localeCompare(b));

  while (queue.length > 0) {
    queue.sort((a, b) => a.localeCompare(b));
    const currId = queue.shift()!;
    const currRank = ranks.get(currId)!;
    const outEdges = graph.outEdges(currId).filter((e) => !feedbackEdges?.has(e.id));

    for (const edge of outEdges) {
      const targetId = edge.target;
      const nextRank = Math.max(ranks.get(targetId)!, currRank + 1);
      ranks.set(targetId, nextRank);

      const remainingIn = inDegree.get(targetId)! - 1;
      inDegree.set(targetId, remainingIn);

      if (remainingIn === 0) {
        queue.push(targetId);
      }
    }
  }

  return ranks;
}
