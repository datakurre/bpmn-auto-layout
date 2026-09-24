import type { DirectedGraph } from './graph';
import {
  getElementDimensions,
  DEFAULT_GRID_SPACING,
  POOL_X,
  GRID_START_X_WITH_LANES,
  MIN_COLUMN_WIDTH,
  MIN_TRACK_HALF_HEIGHT,
  BOUNDARY_TRACK_PADDING,
} from '../di-constants';
import { alignMergeNodeTrack } from './dummy-nodes';
import type { AutoLayoutOptions, Bounds } from '../types';

export interface CoordinateOptions extends AutoLayoutOptions {
  feedbackEdges?: Set<string>;
  nodeToLane?: Map<string, number>;
}

interface TrackContext {
  tracks: Map<string, number>;
  graph: DirectedGraph;
  feedbackEdges?: Set<string>;
  nodeToLane?: Map<string, number>;
}

interface ColConfig {
  maxRank: number;
  startX: number;
  gridSpacing: number;
  widthBudget?: number;
}

export function assignCoordinates(
  graph: DirectedGraph,
  ranks: Map<string, number>,
  options?: CoordinateOptions
): Map<string, Bounds> {
  const nodes = graph.getNodes();
  const gridSpacing = options?.gridSpacing ?? DEFAULT_GRID_SPACING;
  const hasLanes = Boolean(options?.nodeToLane && options.nodeToLane.size > 0);
  const startX = hasLanes ? GRID_START_X_WITH_LANES : POOL_X;

  const { rankGroups, maxRank } = groupNodesByRank(nodes, ranks);
  const { colWidths, colX, rankRows } = computeColumnPositions(graph, rankGroups, {
    maxRank,
    startX,
    gridSpacing,
    widthBudget: hasLanes ? undefined : options?.widthBudget,
  });

  const tracks = hasLanes
    ? computeLaneAwareTracks(graph, ranks, options!)
    : computeFlatTracks(graph, ranks, options?.feedbackEdges);

  return computeFinalBounds(nodes, tracks, { colWidths, colX, ranks, rankRows, graph });
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
  rankRows: Map<number, number>;
  graph?: DirectedGraph;
}

interface TrackExtent {
  top: number;
  bottom: number;
}

interface TrackYContext {
  nodes: Array<{ id: string; data?: any }>;
  tracks: Map<string, number>;
  colInfo: ColInfo;
  rowOffsets: Map<number, number>;
}

function collectTrackExtents(ctx: TrackYContext): Map<number, TrackExtent> {
  const extents = new Map<number, TrackExtent>();
  const graph = ctx.colInfo.graph;

  for (const node of ctx.nodes) {
    const rank = ctx.colInfo.ranks.get(node.id) || 0;
    const row = ctx.colInfo.rankRows.get(rank) || 0;
    const baseTrack = ctx.tracks.get(node.id) || 0;
    const rowOffset = ctx.rowOffsets.get(row) || 0;
    const track = baseTrack + rowOffset;

    const dim = node.data?.isDummy
      ? { width: 0, height: 0 }
      : getElementDimensions(node.data?.$type);
    const h = node.data?.customHeight ?? dim.height;
    const hasBottomBoundary = Boolean(
      graph && graph.outEdges(node.id).some((e) => e.id.startsWith('_attach_'))
    );
    const topHalf = Math.max(MIN_TRACK_HALF_HEIGHT, Math.ceil(h / 2));
    const bottomHalf = Math.max(
      MIN_TRACK_HALF_HEIGHT,
      Math.ceil(h / 2) + (hasBottomBoundary ? BOUNDARY_TRACK_PADDING : 0)
    );

    const existing = extents.get(track);
    if (!existing) {
      extents.set(track, { top: topHalf, bottom: bottomHalf });
    } else {
      existing.top = Math.max(existing.top, topHalf);
      existing.bottom = Math.max(existing.bottom, bottomHalf);
    }
  }
  return extents;
}

function computeTrackYPositions(ctx: TrackYContext): Map<number, number> {
  const extents = collectTrackExtents(ctx);
  const sortedTracks = Array.from(extents.keys()).sort((a, b) => a - b);
  const trackYMap = new Map<number, number>();

  const baseIdx = Math.max(
    0,
    sortedTracks.findIndex((t) => t >= 0)
  );
  const baseTrack = sortedTracks[baseIdx];
  trackYMap.set(baseTrack, 140 + baseTrack * 120);

  for (let i = baseIdx + 1; i < sortedTracks.length; i++) {
    const prevTrack = sortedTracks[i - 1];
    const currTrack = sortedTracks[i];
    const prevExt = extents.get(prevTrack)!;
    const currExt = extents.get(currTrack)!;
    const emptyTrackSpan = Math.max(0, currTrack - prevTrack - 1);
    const step = prevExt.bottom + 40 + currExt.top + emptyTrackSpan * 120;
    trackYMap.set(currTrack, trackYMap.get(prevTrack)! + step);
  }

  for (let i = baseIdx - 1; i >= 0; i--) {
    const nextTrack = sortedTracks[i + 1];
    const currTrack = sortedTracks[i];
    const nextExt = extents.get(nextTrack)!;
    const currExt = extents.get(currTrack)!;
    const emptyTrackSpan = Math.max(0, nextTrack - currTrack - 1);
    const step = nextExt.top + 40 + currExt.bottom + emptyTrackSpan * 120;
    trackYMap.set(currTrack, trackYMap.get(nextTrack)! - step);
  }

  return trackYMap;
}

function computeRowTrackOffsets(
  nodes: Array<{ id: string }>,
  tracks: Map<string, number>,
  colInfo: ColInfo
): Map<number, number> {
  const rowOffsets = new Map<number, number>();
  const rowMinTrack = new Map<number, number>();
  const rowMaxTrack = new Map<number, number>();

  for (const node of nodes) {
    const rank = colInfo.ranks.get(node.id) || 0;
    const row = colInfo.rankRows.get(rank) || 0;
    const track = tracks.get(node.id) || 0;
    rowMinTrack.set(row, Math.min(rowMinTrack.get(row) ?? track, track));
    rowMaxTrack.set(row, Math.max(rowMaxTrack.get(row) ?? track, track));
  }

  const maxRow = Math.max(0, ...Array.from(colInfo.rankRows.values()));
  rowOffsets.set(0, 0);
  for (let r = 1; r <= maxRow; r++) {
    const prevMax = rowMaxTrack.get(r - 1)!;
    const currMin = rowMinTrack.get(r)!;
    const prevOffset = rowOffsets.get(r - 1)!;
    const offset = prevOffset + (prevMax - currMin) + 2.0;
    rowOffsets.set(r, offset);
  }
  return rowOffsets;
}

function computeFinalBounds(
  nodes: Array<{ id: string; data?: any }>,
  tracks: Map<string, number>,
  colInfo: ColInfo
): Map<string, Bounds> {
  const boundsMap = new Map<string, Bounds>();
  const rowOffsets = computeRowTrackOffsets(nodes, tracks, colInfo);
  const trackYMap = computeTrackYPositions({ nodes, tracks, colInfo, rowOffsets });

  for (const node of nodes) {
    const rank = colInfo.ranks.get(node.id) || 0;
    const row = colInfo.rankRows.get(rank) || 0;
    const dim = node.data?.isDummy
      ? { width: 0, height: 0 }
      : getElementDimensions(node.data?.$type);
    const w = node.data?.customWidth ?? dim.width;
    const h = node.data?.customHeight ?? dim.height;
    const colWidth = colInfo.colWidths.get(rank)!;
    const x = colInfo.colX.get(rank)! + (colWidth - w) / 2;

    const baseTrack = tracks.get(node.id)!;
    const rowOffset = rowOffsets.get(row)!;
    const track = baseTrack + rowOffset;
    const trackY = trackYMap.get(track)!;
    const y = Math.round(trackY - h / 2);

    boundsMap.set(node.id, { x, y, width: w, height: h });
  }

  return boundsMap;
}

function computeColumnPositions(
  graph: DirectedGraph,
  rankGroups: Map<number, string[]>,
  config: ColConfig
): {
  colWidths: Map<number, number>;
  colX: Map<number, number>;
  rankRows: Map<number, number>;
} {
  const colWidths = new Map<number, number>();
  for (let r = 0; r <= config.maxRank; r++) {
    const nodeIds = rankGroups.get(r)!;
    let maxWidth = 0;
    for (const id of nodeIds) {
      const node = graph.getNode(id)!;
      const dim = node.data?.isDummy
        ? { width: 0, height: 0 }
        : getElementDimensions(node.data?.$type);
      const w = node.data?.customWidth ?? dim.width;
      maxWidth = Math.max(maxWidth, w);
    }
    colWidths.set(r, Math.max(MIN_COLUMN_WIDTH, maxWidth));
  }

  const colX = new Map<number, number>();
  const rankRows = new Map<number, number>();
  let currentX = config.startX;
  let currentRow = 0;

  for (let r = 0; r <= config.maxRank; r++) {
    const w = colWidths.get(r)!;
    if (config.widthBudget && r > 0 && currentX + w - config.startX > config.widthBudget) {
      currentRow += 1;
      currentX = config.startX;
    }
    rankRows.set(r, currentRow);
    colX.set(r, currentX);
    currentX += w + config.gridSpacing;
  }

  return { colWidths, colX, rankRows };
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
    resolveRankCollisions(nodesInRank, tracks, graph);
  }

  refineDummyTracksWithBarycenterSweeps({ graph, ranks, ctx }, maxRank);

  return tracks;
}

const DUMMY_TRACK_SWEEP_ITERATIONS = 2;

interface SweepContext {
  graph: DirectedGraph;
  ranks: Map<string, number>;
  ctx: TrackContext;
}

/**
 * Dummy nodes are free virtual routing points reserved along the corridor of a
 * multi-rank edge; nudging them toward the barycenter of their neighbors (a
 * forward/backward Sugiyama-style sweep) straightens their chain and reduces
 * bends without perturbing the placement of any real BPMN element.
 */
function refineDummyTracksWithBarycenterSweeps(sweep: SweepContext, maxRank: number): void {
  const hasDummyNodes = sweep.graph.getNodes().some((n) => n.data?.isDummy);
  if (!hasDummyNodes) {
    return;
  }

  for (let iter = 0; iter < DUMMY_TRACK_SWEEP_ITERATIONS; iter++) {
    for (let r = maxRank - 1; r >= 0; r--) {
      sweepRankDummyBarycenter(sweep, r, 'out');
    }
    for (let r = 0; r <= maxRank; r++) {
      sweepRankDummyBarycenter(sweep, r, 'in');
    }
  }
}

function sweepRankDummyBarycenter(
  sweep: SweepContext,
  rank: number,
  direction: 'in' | 'out'
): void {
  const { graph, ranks, ctx } = sweep;
  const nodesInRank = graph.getNodes().filter((n) => (ranks.get(n.id) || 0) === rank);
  const dummiesInRank = nodesInRank.filter((n) => n.data?.isDummy);
  if (dummiesInRank.length === 0) {
    return;
  }

  for (const node of dummiesInRank) {
    // Each dummy node has exactly one in-edge and one out-edge by construction
    // (see insertDummyNodes), and neither is ever a feedback edge.
    const neighborEdges = direction === 'out' ? graph.outEdges(node.id) : graph.inEdges(node.id);
    const neighborIds = neighborEdges.map((e) => (direction === 'out' ? e.target : e.source));
    // The full forward pass above already assigned a track to every node.
    const neighborTracks = neighborIds.map((id) => ctx.tracks.get(id)!);
    const barycenter = neighborTracks.reduce((a, b) => a + b, 0) / neighborTracks.length;
    ctx.tracks.set(node.id, barycenter);
  }
  resolveRankCollisions(nodesInRank, ctx.tracks, graph);
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
    const ctx: TrackContext = { tracks: localTracks, graph, feedbackEdges, nodeToLane };

    for (let r = 0; r <= maxRank; r++) {
      const nodesInRank = laneNodes.filter((n) => (ranks.get(n.id) || 0) === r);
      nodesInRank.sort((a, b) => {
        const aIsTarget = graph
          .inEdges(a.id)
          .some((e) => graph.getNode(e.source)?.data?.$type === 'bpmn:BoundaryEvent');
        const bIsTarget = graph
          .inEdges(b.id)
          .some((e) => graph.getNode(e.source)?.data?.$type === 'bpmn:BoundaryEvent');
        return Number(aIsTarget) - Number(bIsTarget);
      });
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
      resolveRankCollisions(nodesInRank, localTracks, graph);
    }

    const count = normalizeLaneTracks(laneNodes, localTracks);
    const hasFeedback = graph
      .getEdges()
      .some((e) => Boolean(feedbackEdges?.has(e.id)) && nodeToLane.get(e.source) === l);
    laneTrackCounts.set(l, hasFeedback ? count + 1 : count);
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

function getReturnNodeTrack(nodeId: string, ctx: TrackContext): number {
  const outEdges = ctx.graph.outEdges(nodeId).filter((e) => !e.id.startsWith('_attach_'));
  for (const outEdge of outEdges) {
    const targetInEdges = ctx.graph
      .inEdges(outEdge.target)
      .filter((e) => !e.id.startsWith('_attach_'));
    const hasBoundarySibling = targetInEdges.some(
      (e) => ctx.graph.getNode(e.source)?.data?.$type === 'bpmn:BoundaryEvent'
    );
    if (hasBoundarySibling) {
      return 2;
    }
  }
  return 1;
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
    const hasIncomingFeedback = ctx.graph
      .inEdges(node.id)
      .some((e) => ctx.feedbackEdges?.has(e.id));
    if (hasIncomingFeedback) {
      return getReturnNodeTrack(node.id, ctx);
    }
    return 0;
  }
  if (inEdges.length === 1) {
    return calculateSingleParentTrack(node.id, inEdges[0].source, ctx);
  }
  return alignMergeNodeTrack(node.id, inEdges, ctx.tracks);
}

function getBranchExtents(nodeId: string, graph: DirectedGraph): { up: number; down: number } {
  const outEdges = graph.outEdges(nodeId).filter((e) => !e.id.startsWith('_attach_'));
  const attachCount = graph
    .outEdges(nodeId)
    .filter((e) => e.id.startsWith('_attach_') && graph.outEdges(e.target).length > 0).length;

  if (outEdges.length <= 1) {
    return { up: 0, down: attachCount };
  }
  const center = Math.floor((outEdges.length - 1) / 2);
  return {
    up: center,
    down: outEdges.length - 1 - center + attachCount,
  };
}

function getSiblingBranchOffset(
  siblings: Array<{ target: string }>,
  siblingIndex: number,
  graph: DirectedGraph
): number {
  if (siblings.length === 2) {
    const hasBottom0 = graph.outEdges(siblings[0].target).some((e) => e.id.startsWith('_attach_'));
    const hasBottom1 = graph.outEdges(siblings[1].target).some((e) => e.id.startsWith('_attach_'));
    if (hasBottom0 && !hasBottom1) {
      return siblingIndex === 0 ? 0 : -1;
    }
  }

  const relPositions: number[] = [0];
  for (let i = 1; i < siblings.length; i++) {
    const prevExt = getBranchExtents(siblings[i - 1].target, graph);
    const currExt = getBranchExtents(siblings[i].target, graph);
    const step = Math.max(1, prevExt.down + currExt.up + 1);
    relPositions.push(relPositions[i - 1] + step);
  }

  const centerIndex = Math.floor((siblings.length - 1) / 2);
  return relPositions[siblingIndex] - relPositions[centerIndex];
}

function calculateSingleParentTrack(nodeId: string, parentId: string, ctx: TrackContext): number {
  const parentNode = ctx.graph.getNode(parentId);
  if (parentNode?.data?.$type === 'bpmn:BoundaryEvent') {
    const hostId = parentNode.data?.attachedToRef?.id || parentNode.data?.attachedToRef;
    return (ctx.tracks.get(hostId) || 0) + 1;
  }
  const parentTrack = ctx.tracks.get(parentId) || 0;
  let siblings = ctx.graph
    .outEdges(parentId)
    .filter((e) => !ctx.feedbackEdges?.has(e.id) && !e.id.startsWith('_attach_'));

  if (ctx.nodeToLane) {
    const currentLane = ctx.nodeToLane.get(nodeId);
    siblings = siblings.filter((e) => ctx.nodeToLane!.get(e.target) === currentLane);
  }

  if (siblings.length <= 1) {
    return parentTrack;
  }
  const siblingIndex = siblings.findIndex((e) => e.target === nodeId);
  return parentTrack + getSiblingBranchOffset(siblings, siblingIndex, ctx.graph);
}

function resolveRankCollisions(
  nodesInRank: Array<{ id: string; data?: any; order?: number }>,
  tracks: Map<string, number>,
  graph: DirectedGraph
): void {
  const regularNodes = nodesInRank.filter((n) => n.data?.$type !== 'bpmn:BoundaryEvent');
  regularNodes.sort((a, b) => {
    const tA = tracks.get(a.id) || 0;
    const tB = tracks.get(b.id) || 0;
    if (tA !== tB) {
      return tA - tB;
    }
    const oA = a.order ?? 0;
    const oB = b.order ?? 0;
    if (oA !== oB) {
      return oA - oB;
    }
    // Real BPMN nodes take priority over virtual dummy routing nodes: when tracks
    // and orders tie, dummies sort last so they are pushed up, not the real node.
    return Number(b.data?.isDummy) - Number(a.data?.isDummy);
  });

  for (let i = 1; i < regularNodes.length; i++) {
    const prevId = regularNodes[i - 1].id;
    const currId = regularNodes[i].id;
    const prevTrack = tracks.get(prevId) || 0;
    let currTrack = tracks.get(currId) || 0;
    const attachCount = graph
      .outEdges(prevId)
      .filter((e) => e.id.startsWith('_attach_') && graph.outEdges(e.target).length > 0).length;
    const minSpacing = 1 + attachCount;

    if (currTrack < prevTrack + minSpacing) {
      currTrack = prevTrack + minSpacing;
      tracks.set(currId, currTrack);
    }
  }
}
