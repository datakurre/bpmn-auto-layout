import type { DirectedGraph } from './graph';
import { getElementDimensions, DEFAULT_GRID_SPACING } from '../di-constants';
import type { AutoLayoutOptions, Bounds } from '../types';

export interface CoordinateOptions extends AutoLayoutOptions {
  feedbackEdges?: Set<string>;
  nodeToLane?: Map<string, number>;
}

interface TrackContext {
  tracks: Map<string, number>;
  graph: DirectedGraph;
  feedbackEdges?: Set<string>;
}

interface ColConfig {
  maxRank: number;
  startX: number;
  gridSpacing: number;
}

export function assignCoordinates(
  graph: DirectedGraph,
  ranks: Map<string, number>,
  options?: CoordinateOptions
): Map<string, Bounds> {
  const nodes = graph.getNodes();
  const gridSpacing = options?.gridSpacing ?? DEFAULT_GRID_SPACING;
  const hasLanes = Boolean(options?.nodeToLane && options.nodeToLane.size > 0);
  const startX = hasLanes ? 180 : 100;

  const { rankGroups, maxRank } = groupNodesByRank(nodes, ranks);
  const { colWidths, colX } = computeColumnPositions(graph, rankGroups, {
    maxRank,
    startX,
    gridSpacing,
  });

  const tracks = hasLanes
    ? computeLaneAwareTracks(graph, ranks, options!)
    : computeFlatTracks(graph, ranks, options?.feedbackEdges);

  return computeFinalBounds(nodes, tracks, { colWidths, colX, ranks });
}

function groupNodesByRank(
  nodes: Array<{ id: string }>,
  ranks: Map<string, number>
): { rankGroups: Map<number, string[]>; maxRank: number } {
  const maxRank = Math.max(0, ...ranks.values());
  const rankGroups = new Map<number, string[]>();
  for (let r = 0; r <= maxRank; r++) {
    rankGroups.set(r, []);
  }
  for (const node of nodes) {
    const rank = ranks.get(node.id)!;
    rankGroups.get(rank)!.push(node.id);
  }
  return { rankGroups, maxRank };
}

interface ColInfo {
  colWidths: Map<number, number>;
  colX: Map<number, number>;
  ranks: Map<string, number>;
}

function computeFinalBounds(
  nodes: Array<{ id: string; data?: any }>,
  tracks: Map<string, number>,
  colInfo: ColInfo
): Map<string, Bounds> {
  const boundsMap = new Map<string, Bounds>();
  const centerY = 140;
  const trackSpacing = 120;

  for (const node of nodes) {
    const rank = colInfo.ranks.get(node.id) || 0;
    const dim = getElementDimensions(node.data.$type);
    const w = node.data?.customWidth ?? dim.width;
    const h = node.data?.customHeight ?? dim.height;
    const colWidth = colInfo.colWidths.get(rank)!;
    const x = colInfo.colX.get(rank)! + (colWidth - w) / 2;

    const track = tracks.get(node.id)!;
    const trackY = centerY + track * trackSpacing;
    const y = Math.round(trackY - h / 2);

    boundsMap.set(node.id, { x, y, width: w, height: h });
  }

  return boundsMap;
}

function computeColumnPositions(
  graph: DirectedGraph,
  rankGroups: Map<number, string[]>,
  config: ColConfig
): { colWidths: Map<number, number>; colX: Map<number, number> } {
  const colWidths = new Map<number, number>();
  for (let r = 0; r <= config.maxRank; r++) {
    const nodeIds = rankGroups.get(r)!;
    let maxWidth = 36;
    for (const id of nodeIds) {
      const node = graph.getNode(id)!;
      const dim = getElementDimensions(node.data.$type);
      const w = node.data?.customWidth ?? dim.width;
      maxWidth = Math.max(maxWidth, w);
    }
    colWidths.set(r, maxWidth);
  }

  const colX = new Map<number, number>();
  let currentX = config.startX;
  for (let r = 0; r <= config.maxRank; r++) {
    colX.set(r, currentX);
    const w = colWidths.get(r)!;
    currentX += w + config.gridSpacing;
  }

  return { colWidths, colX };
}

function computeFlatTracks(
  graph: DirectedGraph,
  ranks: Map<string, number>,
  feedbackEdges?: Set<string>
): Map<string, number> {
  const tracks = new Map<string, number>();
  const maxRank = Math.max(...ranks.values(), 0);
  const ctx: TrackContext = { tracks, graph, feedbackEdges };

  for (let r = 0; r <= maxRank; r++) {
    const nodesInRank = graph.getNodes().filter((n) => (ranks.get(n.id) || 0) === r);
    for (const node of nodesInRank) {
      const inEdges = graph
        .inEdges(node.id)
        .filter((e) => !feedbackEdges?.has(e.id) && !e.id.startsWith('_attach_'));
      tracks.set(node.id, calculateSingleNodeTrack(node, inEdges, ctx));
    }
    resolveRankCollisions(nodesInRank, tracks);
  }

  return tracks;
}

function computeLaneAwareTracks(
  graph: DirectedGraph,
  ranks: Map<string, number>,
  options: CoordinateOptions
): Map<string, number> {
  const nodeToLane = options.nodeToLane!;
  const feedbackEdges = options.feedbackEdges;
  const maxLane = Math.max(0, ...Array.from(nodeToLane.values()));
  const maxRank = Math.max(...ranks.values(), 0);
  const laneTrackCounts = new Map<number, number>();
  const localTracks = new Map<string, number>();

  for (let l = 0; l <= maxLane; l++) {
    const laneNodes = graph.getNodes().filter((n) => (nodeToLane.get(n.id) ?? 0) === l);
    const ctx: TrackContext = { tracks: localTracks, graph, feedbackEdges };

    for (let r = 0; r <= maxRank; r++) {
      const nodesInRank = laneNodes.filter((n) => (ranks.get(n.id) || 0) === r);
      for (const node of nodesInRank) {
        const inEdges = graph
          .inEdges(node.id)
          .filter(
            (e) =>
              !feedbackEdges?.has(e.id) &&
              !e.id.startsWith('_attach_') &&
              (nodeToLane.get(e.source) ?? 0) === l
          );
        localTracks.set(node.id, calculateSingleNodeTrack(node, inEdges, ctx));
      }
      resolveRankCollisions(nodesInRank, localTracks);
    }

    const count = normalizeLaneTracks(laneNodes, localTracks);
    laneTrackCounts.set(l, count);
  }

  const laneStartTrack = computeLaneStartOffsets(maxLane, laneTrackCounts);
  const globalTracks = new Map<string, number>();
  for (const node of graph.getNodes()) {
    const lane = nodeToLane.get(node.id) ?? 0;
    const start = laneStartTrack.get(lane)!;
    globalTracks.set(node.id, start + (localTracks.get(node.id) || 0));
  }
  return globalTracks;
}

function normalizeLaneTracks(
  laneNodes: Array<{ id: string }>,
  localTracks: Map<string, number>
): number {
  let minT = 0;
  for (const n of laneNodes) {
    minT = Math.min(minT, localTracks.get(n.id)!);
  }
  if (minT < 0) {
    for (const n of laneNodes) {
      localTracks.set(n.id, localTracks.get(n.id)! - minT);
    }
  }
  let maxT = 0;
  for (const n of laneNodes) {
    maxT = Math.max(maxT, localTracks.get(n.id)!);
  }
  return laneNodes.length === 0 ? 1 : maxT + 1;
}

function computeLaneStartOffsets(
  maxLane: number,
  laneTrackCounts: Map<number, number>
): Map<number, number> {
  const offsets = new Map<number, number>();
  offsets.set(0, 0);
  for (let l = 1; l <= maxLane; l++) {
    const prev = offsets.get(l - 1)!;
    const count = laneTrackCounts.get(l - 1)!;
    offsets.set(l, prev + count);
  }
  return offsets;
}

function calculateSingleNodeTrack(
  node: { id: string; data?: any },
  inEdges: Array<{ id: string; source: string; target: string }>,
  ctx: TrackContext
): number {
  if (node.data?.$type === 'bpmn:BoundaryEvent') {
    const hostId = node.data?.attachedToRef?.id || node.data?.attachedToRef;
    return (ctx.tracks.get(hostId) || 0) + 1;
  }
  if (inEdges.length === 0) {
    return 0;
  }
  if (inEdges.length === 1) {
    return calculateSingleParentTrack(node.id, inEdges[0].source, ctx);
  }
  let sum = 0;
  for (const e of inEdges) {
    sum += ctx.tracks.get(e.source) || 0;
  }
  return Math.round(sum / inEdges.length);
}

function calculateSingleParentTrack(nodeId: string, parentId: string, ctx: TrackContext): number {
  const parentNode = ctx.graph.getNode(parentId);
  if (parentNode?.data?.$type === 'bpmn:BoundaryEvent') {
    const hostId = parentNode.data?.attachedToRef?.id || parentNode.data?.attachedToRef;
    return (ctx.tracks.get(hostId) || 0) + 1;
  }
  const parentTrack = ctx.tracks.get(parentId) || 0;
  const siblings = ctx.graph
    .outEdges(parentId)
    .filter((e) => !ctx.feedbackEdges?.has(e.id) && !e.id.startsWith('_attach_'));
  if (siblings.length <= 1) {
    return parentTrack;
  }
  const siblingIndex = siblings.findIndex((e) => e.target === nodeId);
  const count = siblings.length;
  const offset = siblingIndex - (count - 1) / 2;
  return parentTrack + offset;
}

function resolveRankCollisions(
  nodesInRank: Array<{ id: string; data?: any }>,
  tracks: Map<string, number>
): void {
  const regularNodes = nodesInRank.filter((n) => n.data?.$type !== 'bpmn:BoundaryEvent');
  regularNodes.sort((a, b) => {
    const tA = tracks.get(a.id) || 0;
    const tB = tracks.get(b.id) || 0;
    if (tA !== tB) {
      return tA - tB;
    }
    return a.id.localeCompare(b.id);
  });

  for (let i = 1; i < regularNodes.length; i++) {
    const prevId = regularNodes[i - 1].id;
    const currId = regularNodes[i].id;
    const prevTrack = tracks.get(prevId) || 0;
    let currTrack = tracks.get(currId) || 0;

    if (currTrack <= prevTrack) {
      currTrack = prevTrack + 1;
      tracks.set(currId, currTrack);
    }
  }
}
