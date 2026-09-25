import type { AutoLayoutOptions, Bounds, Point } from '../types';
import {
  buildScopeGraph,
  getRefId,
  partitionScopeElements,
  type ScopeLayoutResult,
} from './subprocess-layout';
import { findFeedbackEdges } from '../graph/cycle-removal';
import { boxesOverlap } from '../layout-metrics';

export interface CollaborationAlignmentContext {
  definitions: any;
  collaboration: any;
  allShapesMap: Map<string, Bounds>;
  allShapes: Array<{ element: any; bounds: Bounds; isExpanded?: boolean; labelBounds?: Bounds }>;
  allEdges: Array<{ element: any; waypoints: Point[]; isFeedback?: boolean; labelBounds?: Bounds }>;
  allLanes?: Array<{ element: any; bounds: Bounds }>;
  allPools?: Array<{ element: any; bounds: Bounds }>;
}

export interface IntraProcessAlignmentContext {
  process: any;
  result: ScopeLayoutResult;
  options?: AutoLayoutOptions;
}

interface MessagePair {
  srcId: string;
  tgtId: string;
  srcProc: any;
  tgtProc: any;
}

interface ProcessForwardInfo {
  process: any;
  forwardSuccessors: Map<string, string[]>;
  subProcessDescendants: Map<string, { shapes: string[]; edges: string[] }>;
}

interface ShiftSubtreeContext {
  allShapesMap: Map<string, Bounds>;
  allEdges: Array<{ element: any; waypoints: Point[]; isFeedback?: boolean }>;
  forwardSuccessors: Map<string, string[]>;
  subProcessDescendants: Map<string, { shapes: string[]; edges: string[] }>;
}

interface PairShiftContext {
  allShapesMap: Map<string, Bounds>;
  allEdges: Array<{ element: any; waypoints: Point[]; isFeedback?: boolean }>;
  procInfos: Map<string, ProcessForwardInfo>;
}

function mapProcessElements(elements: any[], process: any, map: Map<string, any>): void {
  for (const el of elements) {
    map.set(el.id, process);
    if (el.$type === 'bpmn:SubProcess' && el.flowElements) {
      mapProcessElements(el.flowElements, process, map);
    }
  }
}

function buildNodeProcessMap(definitions: any): Map<string, any> {
  const map = new Map<string, any>();
  const processes = (definitions.rootElements || []).filter(
    (el: any) => el.$type === 'bpmn:Process'
  );
  for (const proc of processes) {
    if (proc.flowElements) {
      mapProcessElements(proc.flowElements, proc, map);
    }
  }
  return map;
}

function collectSubProcessDescendants(
  element: any,
  descendants: { shapes: string[]; edges: string[] }
): void {
  for (const child of element.flowElements || []) {
    if (child.$type === 'bpmn:SequenceFlow') {
      descendants.edges.push(child.id);
    } else {
      descendants.shapes.push(child.id);
      if (child.$type === 'bpmn:SubProcess') {
        collectSubProcessDescendants(child, descendants);
      }
    }
  }
}

function collectAllBoundaryEvents(scope: any): any[] {
  const result: any[] = [];
  for (const el of scope.flowElements || []) {
    if (el.$type === 'bpmn:BoundaryEvent') {
      result.push(el);
    } else if (el.$type === 'bpmn:SubProcess' && el.flowElements) {
      result.push(...collectAllBoundaryEvents(el));
    }
  }
  return result;
}

function buildProcessForwardInfo(process: any): ProcessForwardInfo {
  const { regularNodes, boundaryEvents, sequenceFlows } = partitionScopeElements(process);
  const graph = buildScopeGraph(regularNodes, boundaryEvents, sequenceFlows);
  const feedbackEdges = findFeedbackEdges(graph);
  const forwardSuccessors = new Map<string, string[]>();
  for (const node of regularNodes) {
    forwardSuccessors.set(node.id, []);
  }

  for (const flow of sequenceFlows) {
    if (feedbackEdges.has(flow.id)) {
      continue;
    }
    const srcId = getRefId(flow.sourceRef);
    const tgtId = getRefId(flow.targetRef);
    if (!srcId || !tgtId) {
      continue;
    }
    forwardSuccessors.get(srcId)?.push(tgtId);
  }

  const allBoundaryEvents = collectAllBoundaryEvents(process);
  for (const be of allBoundaryEvents) {
    const hostId = getRefId(be.attachedToRef);
    if (hostId) {
      const list = forwardSuccessors.get(hostId) || [];
      list.push(be.id);
      forwardSuccessors.set(hostId, list);
    }
  }

  const subProcessDescendants = new Map<string, { shapes: string[]; edges: string[] }>();
  for (const node of regularNodes) {
    if (node.$type === 'bpmn:SubProcess') {
      const descendants = { shapes: [], edges: [] };
      collectSubProcessDescendants(node, descendants);
      subProcessDescendants.set(node.id, descendants);
    }
  }

  return { process, forwardSuccessors, subProcessDescendants };
}

function collectReachableNodes(
  startId: string,
  forwardSuccessors: Map<string, string[]>
): Set<string> {
  const reachable = new Set<string>();
  const queue = [startId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    reachable.add(current);
    const succs = forwardSuccessors.get(current) || [];
    for (const succ of succs) {
      if (!reachable.has(succ)) {
        reachable.add(succ);
        queue.push(succ);
      }
    }
  }
  return reachable;
}

function shiftSubtreeNodes(startId: string, deltaX: number, ctx: ShiftSubtreeContext): void {
  const reachable = collectReachableNodes(startId, ctx.forwardSuccessors);
  const shiftedShapeIds = new Set<string>();
  const shiftedEdgeIds = new Set<string>();

  for (const id of reachable) {
    shiftedShapeIds.add(id);
    const desc = ctx.subProcessDescendants.get(id);
    if (desc) {
      for (const sId of desc.shapes) {
        shiftedShapeIds.add(sId);
      }
      for (const eId of desc.edges) {
        shiftedEdgeIds.add(eId);
      }
    }
  }

  for (const id of shiftedShapeIds) {
    const b = ctx.allShapesMap.get(id);
    if (b) {
      b.x += deltaX;
    }
  }

  for (const edge of ctx.allEdges) {
    if (shiftedEdgeIds.has(edge.element.id)) {
      for (const wp of edge.waypoints) {
        wp.x += deltaX;
      }
    }
  }
}

function collectInterPoolMessagePairs(
  messageFlows: any[],
  nodeToProcess: Map<string, any>
): MessagePair[] {
  const pairs: MessagePair[] = [];
  for (const mf of messageFlows) {
    const srcId = getRefId(mf.sourceRef);
    const tgtId = getRefId(mf.targetRef);
    if (!srcId || !tgtId) {
      continue;
    }
    const srcProc = nodeToProcess.get(srcId);
    const tgtProc = nodeToProcess.get(tgtId);
    if (srcProc && tgtProc && srcProc !== tgtProc) {
      pairs.push({ srcId, tgtId, srcProc, tgtProc });
    }
  }
  return pairs;
}

function findElementInScope(scope: any, id: string): any {
  for (const el of scope.flowElements || []) {
    if (el.id === id) {
      return el;
    }
    if (el.$type === 'bpmn:SubProcess') {
      const found = findElementInScope(el, id);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

function getEffectiveShiftRoot(nodeId: string, process: any): string {
  const el = findElementInScope(process, nodeId);
  if (el?.$type === 'bpmn:BoundaryEvent' || el?.attachedToRef) {
    const hostId = getRefId(el.attachedToRef);
    if (hostId) {
      return hostId;
    }
  }
  return nodeId;
}

function applyPairShift(pair: MessagePair, ctx: PairShiftContext): boolean {
  const srcBounds = ctx.allShapesMap.get(pair.srcId);
  const tgtBounds = ctx.allShapesMap.get(pair.tgtId);
  if (!srcBounds || !tgtBounds) {
    return false;
  }
  const srcCenter = Math.round(srcBounds.x + srcBounds.width / 2);
  const tgtCenter = Math.round(tgtBounds.x + tgtBounds.width / 2);
  if (srcCenter === tgtCenter) {
    return false;
  }

  if (srcCenter > tgtCenter) {
    const delta = srcCenter - tgtCenter;
    const tgtInfo = ctx.procInfos.get(pair.tgtProc.id)!;
    const shiftRoot = getEffectiveShiftRoot(pair.tgtId, pair.tgtProc);
    shiftSubtreeNodes(shiftRoot, delta, {
      allShapesMap: ctx.allShapesMap,
      allEdges: ctx.allEdges,
      forwardSuccessors: tgtInfo.forwardSuccessors,
      subProcessDescendants: tgtInfo.subProcessDescendants,
    });
    return true;
  }

  const delta = tgtCenter - srcCenter;
  const srcInfo = ctx.procInfos.get(pair.srcProc.id)!;
  const shiftRoot = getEffectiveShiftRoot(pair.srcId, pair.srcProc);
  shiftSubtreeNodes(shiftRoot, delta, {
    allShapesMap: ctx.allShapesMap,
    allEdges: ctx.allEdges,
    forwardSuccessors: srcInfo.forwardSuccessors,
    subProcessDescendants: srcInfo.subProcessDescendants,
  });
  return true;
}

export function alignCollaborationPaths(opts: CollaborationAlignmentContext): void {
  const { definitions, collaboration } = opts;
  const messageFlows = collaboration?.messageFlows || [];
  if (messageFlows.length === 0) {
    unifyCollaborationPoolWidths(opts);
    return;
  }

  const nodeToProcess = buildNodeProcessMap(definitions);
  const pairs = collectInterPoolMessagePairs(messageFlows, nodeToProcess);
  if (pairs.length === 0) {
    unifyCollaborationPoolWidths(opts);
    return;
  }

  const procInfos = new Map<string, ProcessForwardInfo>();
  const processes = definitions.rootElements.filter((el: any) => el.$type === 'bpmn:Process');
  for (const p of processes) {
    procInfos.set(p.id, buildProcessForwardInfo(p));
  }

  const pairCtx: PairShiftContext = {
    allShapesMap: opts.allShapesMap,
    allEdges: opts.allEdges,
    procInfos,
  };

  const MAX_PASSES = 10;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let shifted = false;
    for (const pair of pairs) {
      if (applyPairShift(pair, pairCtx)) {
        shifted = true;
      }
    }
    if (!shifted) {
      break;
    }
  }

  unifyCollaborationPoolWidths(opts);
}

export function unifyCollaborationPoolWidths(opts: CollaborationAlignmentContext): void {
  if (!opts.allPools || opts.allPools.length <= 1) {
    return;
  }

  let unifiedWidth = Math.max(...opts.allPools.map((p) => p.bounds.width));
  for (const pool of opts.allPools) {
    const poolShapes = opts.allShapes.filter(
      (s) =>
        s.bounds.x >= pool.bounds.x &&
        s.bounds.y >= pool.bounds.y &&
        s.bounds.y + s.bounds.height <= pool.bounds.y + pool.bounds.height
    );
    if (poolShapes.length > 0) {
      const maxShapeRight = Math.max(...poolShapes.map((s) => s.bounds.x + s.bounds.width));
      unifiedWidth = Math.max(unifiedWidth, maxShapeRight - pool.bounds.x + 60);
    }
  }

  for (const pool of opts.allPools) {
    pool.bounds.width = unifiedWidth;
    opts.allShapesMap.set(pool.element.id, pool.bounds);
  }

  if (opts.allLanes) {
    for (const lane of opts.allLanes) {
      const pool = opts.allPools.find(
        (p) => lane.bounds.y >= p.bounds.y && lane.bounds.y < p.bounds.y + p.bounds.height
      );
      if (pool) {
        lane.bounds.width = pool.bounds.width - (lane.bounds.x - pool.bounds.x);
        opts.allShapesMap.set(lane.element.id, lane.bounds);
      }
    }
  }
}

interface GatewayObstacleCandidate {
  candidateGateway: any;
  joinGateway: any;
  obstacleNode: any;
  nonJoinNodes: any[];
  targetX: number;
  deltaX: number;
}

interface CorridorCheckContext {
  gCenterX: number;
  yRange: { top: number; bottom: number };
  boundsMap: Map<string, Bounds>;
}

function findCorridorObstacle(nodes: any[], ctx: CorridorCheckContext): any | undefined {
  return nodes.find((n) => {
    const b = ctx.boundsMap.get(n.id);
    return (
      b &&
      b.y >= ctx.yRange.top &&
      b.y + b.height <= ctx.yRange.bottom + 40 &&
      ctx.gCenterX >= b.x &&
      ctx.gCenterX <= b.x + b.width
    );
  });
}

interface NonJoinContext {
  sequenceFlows: any[];
  joinId: string;
  nodeMap: Map<string, any>;
}

function collectNonJoinSubtree(nonJoinFlows: any[], ctx: NonJoinContext): any[] {
  const result: any[] = [];
  const visited = new Set<string>();
  const queue: string[] = [];

  for (const f of nonJoinFlows) {
    const id = getRefId(f.targetRef);
    if (id && id !== ctx.joinId && !visited.has(id)) {
      visited.add(id);
      queue.push(id);
    }
  }

  while (queue.length > 0) {
    const curId = queue.shift()!;
    const node = ctx.nodeMap.get(curId);
    if (node) {
      result.push(node);
    }
    const out = ctx.sequenceFlows.filter((f) => getRefId(f.sourceRef) === curId);
    for (const f of out) {
      const tgtId = getRefId(f.targetRef);
      if (tgtId && !visited.has(tgtId) && tgtId !== ctx.joinId) {
        visited.add(tgtId);
        queue.push(tgtId);
      }
    }
  }
  return result;
}

function findNextColumnNodeX(
  regularNodes: any[],
  range: { minX: number; maxX: number },
  boundsMap: Map<string, Bounds>
): number | undefined {
  let targetX: number | undefined;
  for (const n of regularNodes) {
    const b = boundsMap.get(n.id);
    if (b && b.x >= range.minX && b.x < range.maxX) {
      if (targetX === undefined || b.x < targetX) {
        targetX = b.x;
      }
    }
  }
  return targetX;
}

function buildForwardSuccessorsMap(sequenceFlows: any[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const flow of sequenceFlows) {
    const srcId = getRefId(flow.sourceRef);
    const tgtId = getRefId(flow.targetRef);
    if (srcId && tgtId) {
      const list = map.get(srcId) || [];
      list.push(tgtId);
      map.set(srcId, list);
    }
  }
  return map;
}

function findGatewayJoinFlow(
  outgoing: any[],
  gBounds: Bounds,
  ctx: { sequenceFlows: any[]; boundsMap: Map<string, Bounds> }
): any | undefined {
  return outgoing.find((f) => {
    const tgtId = getRefId(f.targetRef);
    if (!tgtId) {
      return false;
    }
    const tgtBounds = ctx.boundsMap.get(tgtId);
    const incCount = ctx.sequenceFlows.filter((sf) => getRefId(sf.targetRef) === tgtId).length;
    return tgtBounds && tgtBounds.y > gBounds.y && incCount >= 2;
  });
}

interface GatewayCandidateContext {
  regularNodes: any[];
  sequenceFlows: any[];
  boundsMap: Map<string, Bounds>;
  nodeMap: Map<string, any>;
  forwardSuccessors: Map<string, string[]>;
}

function evaluateGatewayCandidate(
  node: any,
  ctx: GatewayCandidateContext
): GatewayObstacleCandidate | undefined {
  if (!node.$type?.endsWith('Gateway') || node.$type?.includes('Parallel')) {
    return undefined;
  }
  const outgoing = ctx.sequenceFlows.filter((f) => getRefId(f.sourceRef) === node.id);
  if (outgoing.length < 2) {
    return undefined;
  }
  const gBounds = ctx.boundsMap.get(node.id)!;
  const joinFlow = findGatewayJoinFlow(outgoing, gBounds, ctx);
  if (!joinFlow) {
    return undefined;
  }

  const joinId = getRefId(joinFlow.targetRef)!;
  const jBounds = ctx.boundsMap.get(joinId)!;
  const gCenterX = Math.round(gBounds.x + gBounds.width / 2);
  const otherNodes = ctx.regularNodes.filter((n) => n.id !== node.id && n.id !== joinId);
  const obstacle = findCorridorObstacle(otherNodes, {
    gCenterX,
    yRange: { top: gBounds.y + gBounds.height, bottom: jBounds.y },
    boundsMap: ctx.boundsMap,
  });
  if (!obstacle) {
    return undefined;
  }

  const obsBounds = ctx.boundsMap.get(obstacle.id)!;
  const reachable = collectReachableNodes(node.id, ctx.forwardSuccessors);
  const parallelNodes = ctx.regularNodes.filter((n) => !reachable.has(n.id) && n.id !== joinId);
  const targetX = findNextColumnNodeX(
    parallelNodes,
    { minX: obsBounds.x + obsBounds.width, maxX: jBounds.x },
    ctx.boundsMap
  );
  if (targetX === undefined || targetX <= gBounds.x) {
    return undefined;
  }

  const deltaX = targetX - gBounds.x;
  if (gBounds.x + deltaX + gBounds.width + 60 > jBounds.x) {
    return undefined;
  }

  const nonJoinFlows = outgoing.filter((f) => f !== joinFlow);
  const nonJoinNodes = collectNonJoinSubtree(nonJoinFlows, {
    sequenceFlows: ctx.sequenceFlows,
    joinId,
    nodeMap: ctx.nodeMap,
  });

  if (doesShiftCauseOverlap({ candidateGateway: node, deltaX, nonJoinNodes }, ctx)) {
    return undefined;
  }

  return {
    candidateGateway: node,
    joinGateway: ctx.nodeMap.get(joinId)!,
    obstacleNode: obstacle,
    nonJoinNodes,
    targetX,
    deltaX,
  };
}

interface CandidateShiftSpec {
  candidateGateway: any;
  deltaX: number;
  nonJoinNodes: any[];
}

function doesShiftCauseOverlap(shift: CandidateShiftSpec, ctx: GatewayCandidateContext): boolean {
  const shiftNodes = [shift.candidateGateway, ...shift.nonJoinNodes];
  const shiftIds = new Set(shiftNodes.map((n) => n.id));
  const unshiftedBounds = ctx.regularNodes
    .filter((other) => !shiftIds.has(other.id))
    .map((other) => ctx.boundsMap.get(other.id))
    .filter((b): b is Bounds => Boolean(b));

  return shiftNodes.some((n) => {
    const orig = ctx.boundsMap.get(n.id);
    if (!orig) {
      return false;
    }
    const shiftedBounds: Bounds = {
      x: orig.x + shift.deltaX,
      y: orig.y,
      width: orig.width,
      height: orig.height,
    };
    return unshiftedBounds.some((other) => boxesOverlap(shiftedBounds, other));
  });
}

function findCandidateObstacle(
  process: any,
  boundsMap: Map<string, Bounds>
): GatewayObstacleCandidate | undefined {
  const { regularNodes, sequenceFlows } = partitionScopeElements(process);
  const nodeMap = new Map<string, any>(regularNodes.map((n) => [n.id, n]));
  const forwardSuccessors = buildForwardSuccessorsMap(sequenceFlows);

  const ctx: GatewayCandidateContext = {
    regularNodes,
    sequenceFlows,
    boundsMap,
    nodeMap,
    forwardSuccessors,
  };

  for (const node of regularNodes) {
    const candidate = evaluateGatewayCandidate(node, ctx);
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
}

export function alignIntraProcessBranches(ctx: IntraProcessAlignmentContext): boolean {
  const { process, result } = ctx;
  const boundsMap = new Map<string, Bounds>(result.shapes.map((s) => [s.element.id, s.bounds]));
  const candidate = findCandidateObstacle(process, boundsMap);
  if (!candidate) {
    return false;
  }

  const nodesToShift = [candidate.candidateGateway, ...candidate.nonJoinNodes];
  const { boundaryEvents } = partitionScopeElements(process);
  const boundaryEventsToShift = boundaryEvents.filter((be: any) => {
    const hostId = getRefId(be.attachedToRef);
    return hostId && nodesToShift.some((n) => n.id === hostId);
  });

  const shapeIdsToShift = new Set<string>();
  const descendantEdgeIds = new Set<string>();
  for (const n of [...nodesToShift, ...boundaryEventsToShift]) {
    shapeIdsToShift.add(n.id);
    if (n.$type === 'bpmn:SubProcess') {
      const descendants = { shapes: [], edges: [] };
      collectSubProcessDescendants(n, descendants);
      for (const sId of descendants.shapes) {
        shapeIdsToShift.add(sId);
      }
      for (const eId of descendants.edges) {
        descendantEdgeIds.add(eId);
      }
    }
  }
  for (const id of shapeIdsToShift) {
    const b = boundsMap.get(id);
    if (b) {
      b.x += candidate.deltaX;
    }
  }
  if (descendantEdgeIds.size > 0) {
    for (const e of result.edges) {
      if (descendantEdgeIds.has(e.element.id)) {
        for (const wp of e.waypoints) {
          wp.x += candidate.deltaX;
        }
      }
    }
  }

  // Node/shape movement only: routing happens once, after every alignment
  // pass has finished moving nodes (see LayoutEngine.layoutSingleProcesses
  // and layoutCollaboration).
  let maxRight = 0;
  for (const s of result.shapes) {
    maxRight = Math.max(maxRight, s.bounds.x + s.bounds.width);
  }
  result.width = maxRight - result.minX;

  return true;
}

export function alignVerticallyStackedPaths(opts: CollaborationAlignmentContext): void {
  const { definitions, collaboration } = opts;
  const participants = collaboration?.participants || [];

  for (const part of participants) {
    const procRef = part.processRef?.id || part.processRef;
    const process = (definitions.rootElements || []).find((el: any) => el.id === procRef);
    if (process) {
      const flowElementIds = new Set<string>(
        (process.flowElements as any[] | undefined)?.map((fe: any) => fe.id)
      );
      const partShapes = opts.allShapes.filter((s) => flowElementIds.has(s.element.id));
      const partEdges = opts.allEdges.filter((e) => flowElementIds.has(e.element.id));
      const fakeResult: ScopeLayoutResult = {
        width: 0,
        height: 0,
        minX: Math.min(...partShapes.map((s) => s.bounds.x), 100),
        minY: Math.min(...partShapes.map((s) => s.bounds.y), 100),
        shapes: partShapes,
        edges: partEdges,
        // alignIntraProcessBranches only moves nodes now; it doesn't read
        // this beyond satisfying the type, since routing happens once, later,
        // in LayoutEngine.layoutCollaboration.
        analysis: { feedbackEdges: new Set(), returnNodes: new Set(), returnGateways: new Map() },
      };
      alignIntraProcessBranches({ process, result: fakeResult });
    }
  }

  alignCollaborationPaths(opts);
}
