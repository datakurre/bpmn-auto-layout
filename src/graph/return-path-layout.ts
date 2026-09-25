import { isAttachEdge, type DirectedGraph } from './graph';

export interface ReturnPathAnalysis {
  returnGateways: Map<string, string>;
  returnNodes: Set<string>;
}

export interface ReturnPathLayerOptions {
  feedbackEdges: Set<string>;
  nodeToLane?: Map<string, number>;
}

interface ReturnRankParams {
  targetRank: number;
  sourceRank: number;
  rLane: number;
  hasReturnSuccessors?: boolean;
}

interface IntermediateContext {
  returnGateways: Map<string, string>;
  ranks: Map<string, number>;
  nodeToLane?: Map<string, number>;
  feedbackEdges?: Set<string>;
}

interface FeedbackContext {
  feedbackEdges: Set<string>;
  returnGateways: Map<string, string>;
}

export function canReachEndEvent(
  startId: string,
  graph: DirectedGraph,
  feedbackEdges: Set<string>
): boolean {
  const visited = new Set<string>();
  const queue = [startId];

  while (queue.length > 0) {
    const curr = queue.shift()!;
    if (visited.has(curr)) {
      continue;
    }
    visited.add(curr);

    const node = graph.getNode(curr);
    if (node?.data?.$type === 'bpmn:EndEvent') {
      return true;
    }

    for (const e of graph.outEdges(curr)) {
      if (!feedbackEdges.has(e.id) && !isAttachEdge(e) && !visited.has(e.target)) {
        queue.push(e.target);
      }
    }
  }

  return false;
}

export function detectReturnPathElements(
  graph: DirectedGraph,
  feedbackEdges: Set<string>
): ReturnPathAnalysis {
  const returnGateways = new Map<string, string>();

  for (const node of graph.getNodes()) {
    if (!node.data?.$type?.endsWith('Gateway')) {
      continue;
    }
    const outEdges = graph.outEdges(node.id).filter((e) => !isAttachEdge(e));
    if (outEdges.length === 1 && feedbackEdges.has(outEdges[0].id)) {
      returnGateways.set(node.id, outEdges[0].target);
    }
  }

  const returnNodes = new Set<string>();
  const hasEndEvent = graph.getNodes().some((n) => n.data?.$type === 'bpmn:EndEvent');
  if (!hasEndEvent) {
    return { returnGateways, returnNodes };
  }
  for (const gwId of returnGateways.keys()) {
    const visited = new Set<string>([gwId]);
    const queue = [gwId];
    while (queue.length > 0) {
      const curr = queue.shift()!;
      for (const e of graph.inEdges(curr)) {
        if (isAttachEdge(e)) {
          continue;
        }
        const predId = e.source;
        if (visited.has(predId)) {
          continue;
        }
        visited.add(predId);
        if (!canReachEndEvent(predId, graph, feedbackEdges)) {
          returnNodes.add(predId);
          queue.push(predId);
        }
      }
    }
  }

  return { returnGateways, returnNodes };
}

function alignReturnGatewayRanks(
  returnGateways: Map<string, string>,
  ranks: Map<string, number>,
  nodeToLane?: Map<string, number>
): void {
  for (const [gwId, targetId] of returnGateways.entries()) {
    const targetRank = ranks.get(targetId);
    if (targetRank === undefined) {
      continue;
    }
    const gwLane = nodeToLane?.get(gwId);
    const targetLane = nodeToLane?.get(targetId);
    if (gwLane !== targetLane) {
      ranks.set(gwId, targetRank);
    }
  }
}

function getLaneOccupiedRanks(occupiedRanks: Map<number, Set<number>>, lane: number): Set<number> {
  let set = occupiedRanks.get(lane);
  if (!set) {
    set = new Set<number>();
    occupiedRanks.set(lane, set);
  }
  return set;
}

function findAvailableReturnRank(
  params: ReturnRankParams,
  occupiedRanks: Map<number, Set<number>>
): number {
  const laneOccupied = getLaneOccupiedRanks(occupiedRanks, params.rLane);
  const candidates: number[] = [];

  for (let r = params.targetRank + 1; r < params.sourceRank; r++) {
    if (!laneOccupied.has(r)) {
      candidates.push(r);
    }
  }

  if (candidates.length > 0) {
    if (params.hasReturnSuccessors) {
      return candidates[candidates.length - 1];
    }
    const midIdx = Math.floor((candidates.length - 1) / 2);
    return candidates[midIdx];
  }

  return Math.max(params.targetRank, params.sourceRank - 1);
}

function orderReturnNodes(returnNodes: Set<string>, graph: DirectedGraph): string[] {
  const ordered: string[] = [];
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) {
      return;
    }
    visited.add(id);
    for (const e of graph.inEdges(id)) {
      if (returnNodes.has(e.source)) {
        visit(e.source);
      }
    }
    ordered.push(id);
  };
  for (const id of returnNodes) {
    visit(id);
  }
  return ordered;
}

export function resolveReturnTargetId(
  rId: string,
  graph: DirectedGraph,
  ctx: { returnNodes: Set<string>; returnGateways: Map<string, string> }
): string {
  const seen = new Set<string>([rId]);
  let curr = rId;
  for (;;) {
    // Every return node was discovered through a non-attach outgoing edge.
    const edge = graph.outEdges(curr).find((e) => !isAttachEdge(e))!;
    if (ctx.returnNodes.has(edge.target) && !seen.has(edge.target)) {
      seen.add(edge.target);
      curr = edge.target;
      continue;
    }
    return ctx.returnGateways.get(edge.target) ?? edge.target;
  }
}

function alignIntermediateReturnNodeRanks(
  returnNodes: Set<string>,
  graph: DirectedGraph,
  ctx: IntermediateContext
): void {
  const occupiedRanks = new Map<number, Set<number>>();
  for (const node of graph.getNodes()) {
    if (!returnNodes.has(node.id)) {
      const lane = ctx.nodeToLane?.get(node.id) ?? 0;
      const r = ctx.ranks.get(node.id);
      if (r !== undefined) {
        getLaneOccupiedRanks(occupiedRanks, lane).add(r);
      }
    }
  }

  for (const rId of orderReturnNodes(returnNodes, graph)) {
    const inEdges = graph.inEdges(rId).filter((e) => !isAttachEdge(e));
    if (inEdges.length === 0) {
      continue;
    }
    const sourceRanks = inEdges
      .map((e) => ctx.ranks.get(e.source))
      .filter((r): r is number => r !== undefined);
    if (sourceRanks.length === 0) {
      continue;
    }
    const sourceRank = Math.min(...sourceRanks);
    const rLane = ctx.nodeToLane?.get(rId) ?? 0;
    const targetId = resolveReturnTargetId(rId, graph, {
      returnNodes,
      returnGateways: ctx.returnGateways,
    });
    const targetRank = ctx.ranks.get(targetId) ?? 0;
    const outEdges = graph.outEdges(rId).filter((e) => !isAttachEdge(e));
    const hasReturnSuccessors = outEdges.some((e) => returnNodes.has(e.target));

    const chosenRank = findAvailableReturnRank(
      { targetRank, sourceRank, rLane, hasReturnSuccessors },
      occupiedRanks
    );
    ctx.ranks.set(rId, chosenRank);
    getLaneOccupiedRanks(occupiedRanks, rLane).add(chosenRank);
  }
}

export function isReturnNode(nodeId: string, returnNodes?: Set<string>): boolean {
  return Boolean(returnNodes?.has(nodeId));
}

export function isReturnGateway(gwId: string, returnGateways?: Map<string, string>): boolean {
  return Boolean(returnGateways?.has(gwId));
}

function updateReturnFeedbackEdges(
  graph: DirectedGraph,
  ranks: Map<string, number>,
  ctx: FeedbackContext
): void {
  for (const e of graph.getEdges()) {
    if (isAttachEdge(e)) {
      continue;
    }
    const sRank = ranks.get(e.source);
    const tRank = ranks.get(e.target);
    if (sRank === undefined || tRank === undefined) {
      continue;
    }
    if (sRank > tRank) {
      ctx.feedbackEdges.add(e.id);
    } else if (sRank === tRank) {
      if (ctx.returnGateways.has(e.source) && ctx.returnGateways.get(e.source) === e.target) {
        ctx.feedbackEdges.delete(e.id);
      }
    }
  }
}

export function alignReturnPathLayers(
  graph: DirectedGraph,
  ranks: Map<string, number>,
  options: ReturnPathLayerOptions
): ReturnPathAnalysis {
  const analysis = detectReturnPathElements(graph, options.feedbackEdges);
  if (analysis.returnGateways.size === 0) {
    return analysis;
  }

  alignReturnGatewayRanks(analysis.returnGateways, ranks, options.nodeToLane);
  alignIntermediateReturnNodeRanks(analysis.returnNodes, graph, {
    ranks,
    returnGateways: analysis.returnGateways,
    nodeToLane: options.nodeToLane,
    feedbackEdges: options.feedbackEdges,
  });
  updateReturnFeedbackEdges(graph, ranks, {
    feedbackEdges: options.feedbackEdges,
    returnGateways: analysis.returnGateways,
  });

  return analysis;
}
