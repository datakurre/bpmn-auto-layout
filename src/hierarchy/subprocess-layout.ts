import { DirectedGraph, isAttachEdge } from '../graph/graph';
import { findFeedbackEdges } from '../graph/cycle-removal';
import { assignLayers } from '../graph/layer-assignment';
import { alignReturnPathLayers } from '../graph/return-path-layout';
import { assignCoordinates } from '../graph/coordinate-assignment';
import { type AxisSpan, isHorizontalSpanBlocked } from '../graph/obstacles';
import { routeOrthogonalEdge } from '../graph/orthogonal-router';
import {
  routeGatewayOutgoingEdges,
  routeGatewayIncomingEdges,
  type GatewayFlowInfo,
  type GatewayIncomingFlowInfo,
} from '../graph/gateway-router';
import { insertDummyNodes } from '../graph/dummy-nodes';
import {
  SUBPROCESS_MIN_WIDTH,
  SUBPROCESS_MIN_HEIGHT,
  SUBPROCESS_PADDING,
  SUBPROCESS_HEADER_HEIGHT,
  SUBPROCESS_CONTAINER_PADDING_X,
  SUBPROCESS_CONTAINER_PADDING_Y,
  SUBPROCESS_WIDTH_BUDGET_FLOOR,
  isSubProcessType,
} from '../di-constants';
import { addBoundaryEventEdges, placeBoundaries, routeBoundaryExit } from './boundary-events';
import {
  isArtifact,
  isAssociation,
  collectScopeAssociations,
  partitionArtifacts,
  layoutConnectedArtifacts,
  routeAssociations,
} from './artifact-layout';
import {
  isEventSubProcess,
  computeCurrentDiagramBounds,
  layoutDisconnectedElements,
} from './disconnected-layout';
import type { AutoLayoutOptions, Bounds, Point } from '../types';

export { routeAssociationEdge } from './artifact-layout';

export interface ScopeAnalysis {
  feedbackEdges: Set<string>;
  returnNodes: Set<string>;
  returnGateways: Map<string, string>;
}

function emptyScopeAnalysis(): ScopeAnalysis {
  return { feedbackEdges: new Set(), returnNodes: new Set(), returnGateways: new Map() };
}

function cloneAnalysis(analysis: ScopeAnalysis): ScopeAnalysis {
  return {
    feedbackEdges: new Set(analysis.feedbackEdges),
    returnNodes: new Set(analysis.returnNodes),
    returnGateways: new Map(analysis.returnGateways),
  };
}

export interface ScopeLayoutResult {
  width: number;
  height: number;
  minX: number;
  minY: number;
  shapes: Array<{
    element: any;
    bounds: Bounds;
    isExpanded?: boolean;
    labelBounds?: Bounds;
  }>;
  analysis: ScopeAnalysis;
  /**
   * Every descendant subprocess's own ScopeAnalysis, keyed by its element id,
   * flattened across all nesting depths. Lets a final routing pass look up
   * any scope's analysis (feedback edges, return-path info) directly, without
   * re-walking the scope tree layoutScope already built.
   */
  childAnalysis: Map<string, ScopeAnalysis>;
}

interface LayoutContext {
  options?: AutoLayoutOptions;
  feedbackEdges: Set<string>;
  subDimensions: Map<string, { width: number; height: number }>;
  nodeToLane?: Map<string, number>;
}

export interface ScopeCacheOptions {
  customDimensions?: Map<string, { width: number; height: number }>;
  scopeCache?: Map<string, ScopeLayoutResult>;
  callCounter?: { count: number };
}

function cloneScopeResult(result: ScopeLayoutResult): ScopeLayoutResult {
  return {
    width: result.width,
    height: result.height,
    minX: result.minX,
    minY: result.minY,
    shapes: result.shapes.map((s) => ({
      element: s.element,
      bounds: { ...s.bounds },
      isExpanded: s.isExpanded,
      labelBounds: s.labelBounds,
    })),
    analysis: cloneAnalysis(result.analysis),
    childAnalysis: new Map(
      Array.from(result.childAnalysis.entries()).map(([id, a]) => [id, cloneAnalysis(a)])
    ),
  };
}

function resolveScopeCacheOptions(
  cacheOptions: ScopeCacheOptions | undefined
): ResolvedScopeCacheOptions {
  const callCounter = cacheOptions?.callCounter;
  if (callCounter) {
    callCounter.count += 1;
  }
  return {
    customDimensions: cacheOptions?.customDimensions,
    scopeCache: cacheOptions?.scopeCache ?? new Map<string, ScopeLayoutResult>(),
    callCounter,
  };
}

export function layoutScope(
  scopeElement: any,
  options?: AutoLayoutOptions,
  cacheOptions?: ScopeCacheOptions
): ScopeLayoutResult {
  const resolvedCacheOptions = resolveScopeCacheOptions(cacheOptions);
  const flowElements = scopeElement.flowElements || [];
  const subProcesses = flowElements.filter((el: any) => isSubProcessType(el.$type));
  const { childScopeResults, subDimensions } = layoutChildSubProcesses(
    subProcesses,
    options,
    resolvedCacheOptions
  );

  const partition = partitionScopeElements(scopeElement);
  const {
    boundaryEvents,
    sequenceFlows,
    eventSubProcesses,
    compensationHandlers,
    regularNodes,
    allArtifacts,
    allAssociations,
  } = partition;

  if (
    regularNodes.length === 0 &&
    boundaryEvents.length === 0 &&
    eventSubProcesses.length === 0 &&
    compensationHandlers.length === 0 &&
    allArtifacts.length === 0
  ) {
    return {
      width: 100,
      height: 80,
      minX: 0,
      minY: 0,
      shapes: [],
      analysis: emptyScopeAnalysis(),
      childAnalysis: new Map(),
    };
  }

  const boundsMap = new Map<string, Bounds>();
  const shapes: Array<{ element: any; bounds: Bounds; isExpanded?: boolean }> = [];

  let analysis = emptyScopeAnalysis();
  if (regularNodes.length > 0 || boundaryEvents.length > 0) {
    analysis = layoutRegularFlowNodes({
      scopeElement,
      regularNodes,
      boundaryEvents,
      sequenceFlows,
      childScopeResults,
      subDimensions,
      options,
      boundsMap,
      shapes,
    });
  }

  layoutRemainingArtifacts(
    { allArtifacts, allAssociations, eventSubProcesses, compensationHandlers, regularNodes },
    { childScopeResults, boundsMap, shapes }
  );

  const bounding = computeScopeBoundingBox(shapes);
  const { width, height } = computeScopeContainerDimensions(bounding);
  return {
    width,
    height,
    minX: bounding.minX,
    minY: bounding.minY,
    shapes,
    analysis,
    childAnalysis: collectChildAnalysis(childScopeResults),
  };
}

function collectChildAnalysis(
  childScopeResults: Map<string, ScopeLayoutResult>
): Map<string, ScopeAnalysis> {
  const childAnalysis = new Map<string, ScopeAnalysis>();
  for (const [subId, childResult] of childScopeResults.entries()) {
    childAnalysis.set(subId, childResult.analysis);
    for (const [descId, descAnalysis] of childResult.childAnalysis.entries()) {
      childAnalysis.set(descId, descAnalysis);
    }
  }
  return childAnalysis;
}

interface ScopeArtifactPartition {
  allArtifacts: any[];
  allAssociations: any[];
  eventSubProcesses: any[];
  compensationHandlers: any[];
  regularNodes: any[];
}

interface ScopeArtifactContext {
  childScopeResults: Map<string, ScopeLayoutResult>;
  boundsMap: Map<string, Bounds>;
  shapes: Array<{ element: any; bounds: Bounds; isExpanded?: boolean }>;
}

function layoutRemainingArtifacts(
  partition: ScopeArtifactPartition,
  ctx: ScopeArtifactContext
): void {
  const { allArtifacts, allAssociations, eventSubProcesses, compensationHandlers, regularNodes } =
    partition;
  const { childScopeResults, boundsMap, shapes } = ctx;

  const regularNodeIds = new Set<string>(regularNodes.map((n: any) => n.id));
  const { connected, unconnected } = partitionArtifacts(
    allArtifacts,
    allAssociations,
    regularNodeIds
  );

  layoutConnectedArtifacts(connected, { boundsMap, shapes });

  const disconnectedItems = [...eventSubProcesses, ...compensationHandlers, ...unconnected];
  if (disconnectedItems.length > 0) {
    const diagramBounds = computeCurrentDiagramBounds(shapes);
    layoutDisconnectedElements(disconnectedItems, diagramBounds, {
      childScopeResults,
      boundsMap,
      shapes,
      associations: allAssociations,
    });
  }
}

function extractNodeToLaneMap(scopeElement: any): Map<string, number> | undefined {
  const laneSets = scopeElement.laneSets || [];
  if (laneSets.length === 0 || !laneSets[0]?.lanes || laneSets[0].lanes.length === 0) {
    return undefined;
  }
  const nodeToLane = new Map<string, number>();
  laneSets[0].lanes.forEach((lane: any, index: number) => {
    for (const ref of lane.flowNodeRef || []) {
      const refId = ref.id || ref;
      nodeToLane.set(refId, index);
    }
  });
  return nodeToLane;
}

export interface ScopeRouteContext {
  regularNodes: any[];
  boundaryEvents: any[];
  boundsMap: Map<string, Bounds>;
  feedbackEdges?: Set<string>;
  returnNodes?: Set<string>;
  returnGateways?: Map<string, string>;
}

interface PartitionedFlows {
  gatewayOutgoingFlows: Map<string, GatewayFlowInfo[]>;
  gatewayIncomingFlows: Map<string, GatewayIncomingFlowInfo[]>;
  otherFlows: Array<{ flow: any; srcId: string; srcBounds: Bounds; tgtBounds: Bounds }>;
  targetPortMap: Map<string, 'top' | 'bottom' | 'left' | 'right'>;
}

export function getRefId(ref: any): string | undefined {
  return ref?.id || ref;
}

export interface IncomingFlowCandidate {
  flow: any;
  sourceBounds: Bounds;
  isFeedback?: boolean;
  isReturnSource?: boolean;
  isReturnGateway?: boolean;
}

function isCorridorBlocked(y: number, xSpan: AxisSpan, obstacles: Bounds[]): boolean {
  return isHorizontalSpanBlocked(y, xSpan, { obstacles });
}

function assignMergeBottomPort(
  below: IncomingFlowCandidate[],
  center: IncomingFlowCandidate[],
  ctx: { gwBounds: Bounds; gwCenterY: number; allBounds?: Bounds[] }
): IncomingFlowCandidate | undefined {
  if (below.length > 0) {
    return below.shift();
  }
  if (center.length > 1) {
    center.sort((a, b) => a.sourceBounds.x - b.sourceBounds.x);
    return center.shift();
  }
  if (center.length === 1 && ctx.allBounds) {
    const obstacles = ctx.allBounds.filter(
      (b) => b !== ctx.gwBounds && b !== center[0].sourceBounds
    );
    const xStart = center[0].sourceBounds.x + center[0].sourceBounds.width;
    if (isCorridorBlocked(ctx.gwCenterY, { start: xStart, end: ctx.gwBounds.x }, obstacles)) {
      return center.shift();
    }
  }
  return undefined;
}

function classifyMergeIncomingFlow(
  f: IncomingFlowCandidate,
  gwBounds: Bounds
): 'forward' | 'bottom' | 'right' | 'left' {
  const isBackwards = f.sourceBounds.x + f.sourceBounds.width > gwBounds.x;
  if (f.isReturnSource || (f.isReturnGateway && f.sourceBounds.x >= gwBounds.x + gwBounds.width)) {
    return f.sourceBounds.y > gwBounds.y + gwBounds.height ? 'bottom' : 'right';
  }
  if (f.isFeedback || isBackwards) {
    return 'left';
  }
  return 'forward';
}

export function assignMergeIncomingPorts(
  flows: IncomingFlowCandidate[],
  gwBounds: Bounds,
  allBounds?: Bounds[]
): Map<string, 'top' | 'bottom' | 'left' | 'right'> {
  const ports = new Map<string, 'top' | 'bottom' | 'left' | 'right'>();
  const gwCenterY = gwBounds.y + gwBounds.height / 2;

  const forwardFlows: IncomingFlowCandidate[] = [];
  for (const f of flows) {
    const port = classifyMergeIncomingFlow(f, gwBounds);
    if (port === 'forward') {
      forwardFlows.push(f);
    } else {
      ports.set(f.flow.id, port);
    }
  }

  if (forwardFlows.length <= 1) {
    for (const f of forwardFlows) {
      ports.set(f.flow.id, 'left');
    }
    return ports;
  }

  const above: IncomingFlowCandidate[] = [];
  const below: IncomingFlowCandidate[] = [];
  const center: IncomingFlowCandidate[] = [];

  for (const f of forwardFlows) {
    const srcCenterY = f.sourceBounds.y + f.sourceBounds.height / 2;
    const diff = srcCenterY - gwCenterY;
    if (diff < -2) {
      above.push(f);
    } else if (diff > 2) {
      below.push(f);
    } else {
      center.push(f);
    }
  }

  above.sort((a, b) => b.sourceBounds.x - a.sourceBounds.x);
  below.sort((a, b) => b.sourceBounds.x - a.sourceBounds.x);

  if (above.length > 0) {
    const topFlow = above.shift()!;
    ports.set(topFlow.flow.id, 'top');
  }

  const bottomCandidate = assignMergeBottomPort(below, center, {
    gwBounds,
    gwCenterY,
    allBounds,
  });
  if (bottomCandidate) {
    ports.set(bottomCandidate.flow.id, 'bottom');
  }

  for (const f of [...center, ...above, ...below]) {
    ports.set(f.flow.id, 'left');
  }

  return ports;
}

export function computeMergeTargetPorts(
  sequenceFlows: any[],
  gatewaySet: Set<string>,
  ctx: ScopeRouteContext
): Map<string, 'top' | 'bottom' | 'left' | 'right'> {
  const targetPortMap = new Map<string, 'top' | 'bottom' | 'left' | 'right'>();

  const gwIncomingMap = new Map<string, IncomingFlowCandidate[]>();
  for (const flow of sequenceFlows) {
    const tgtId = getRefId(flow.targetRef);
    const srcId = getRefId(flow.sourceRef);
    if (tgtId && gatewaySet.has(tgtId)) {
      const srcBounds = ctx.boundsMap.get(srcId!);
      if (srcBounds) {
        const list = gwIncomingMap.get(tgtId) || [];
        list.push({
          flow,
          sourceBounds: srcBounds,
          isFeedback: ctx.feedbackEdges?.has(flow.id),
          isReturnSource: Boolean(ctx.returnNodes?.has(srcId!)),
          isReturnGateway: Boolean(ctx.returnGateways?.has(tgtId)),
        });
        gwIncomingMap.set(tgtId, list);
      }
    }
  }

  for (const [gwId, incomingFlows] of gwIncomingMap.entries()) {
    if (incomingFlows.length <= 1) {
      continue;
    }
    const gwBounds = ctx.boundsMap.get(gwId)!;
    const allBounds = Array.from(ctx.boundsMap.values());
    const ports = assignMergeIncomingPorts(incomingFlows, gwBounds, allBounds);
    for (const [flowId, port] of ports.entries()) {
      targetPortMap.set(flowId, port);
    }
  }

  return targetPortMap;
}

function partitionScopeFlows(
  sequenceFlows: any[],
  gatewaySet: Set<string>,
  ctx: ScopeRouteContext
): PartitionedFlows {
  const targetPortMap = computeMergeTargetPorts(sequenceFlows, gatewaySet, ctx);
  const gatewayOutgoingFlows = new Map<string, GatewayFlowInfo[]>();
  const gatewayIncomingFlows = new Map<string, GatewayIncomingFlowInfo[]>();
  const otherFlows: Array<{ flow: any; srcId: string; srcBounds: Bounds; tgtBounds: Bounds }> = [];

  for (const flow of sequenceFlows) {
    const srcId = getRefId(flow.sourceRef);
    const tgtId = getRefId(flow.targetRef);
    const srcBounds = ctx.boundsMap.get(srcId!);
    const tgtBounds = ctx.boundsMap.get(tgtId!);

    if (srcBounds && tgtBounds) {
      if (gatewaySet.has(srcId!)) {
        const list = gatewayOutgoingFlows.get(srcId!) || [];
        const isReturnTarget =
          Boolean(ctx.returnNodes?.has(tgtId!)) && tgtBounds.x < srcBounds.x + srcBounds.width;
        list.push({
          flow,
          targetBounds: tgtBounds,
          isFeedback: ctx.feedbackEdges?.has(flow.id),
          targetPort: isReturnTarget ? 'right' : targetPortMap.get(flow.id),
          isReturnPathTarget: isReturnTarget,
        });
        gatewayOutgoingFlows.set(srcId!, list);
      } else if (gatewaySet.has(tgtId!)) {
        const isFromBoundary = ctx.boundaryEvents.some((b: any) => b.id === srcId);
        if (isFromBoundary) {
          otherFlows.push({ flow, srcId: srcId!, srcBounds, tgtBounds });
        } else {
          const list = gatewayIncomingFlows.get(tgtId!) || [];
          const isReturnSource = Boolean(ctx.returnNodes?.has(srcId!));
          list.push({
            flow,
            sourceBounds: srcBounds,
            isFeedback: ctx.feedbackEdges?.has(flow.id),
            targetPort: targetPortMap.get(flow.id),
            isReturnSource,
          });
          gatewayIncomingFlows.set(tgtId!, list);
        }
      } else {
        otherFlows.push({ flow, srcId: srcId!, srcBounds, tgtBounds });
      }
    }
  }

  return { gatewayOutgoingFlows, gatewayIncomingFlows, otherFlows, targetPortMap };
}

interface GatewayRouteScopeContext {
  routeCtx: ScopeRouteContext;
  sequenceFlows: any[];
  targetPortMap: Map<string, 'top' | 'bottom' | 'left' | 'right'>;
  usedPortsMap: Map<string, Set<'top' | 'bottom' | 'left' | 'right'>>;
}

function getUsedPorts(
  map: Map<string, Set<'top' | 'bottom' | 'left' | 'right'>>,
  id: string
): Set<'top' | 'bottom' | 'left' | 'right'> {
  let set = map.get(id);
  if (!set) {
    set = new Set();
    map.set(id, set);
  }
  return set;
}

function recordOutgoingFlowUsedPort(
  gwBounds: Bounds,
  waypoints: Point[],
  usedPorts: Set<'top' | 'bottom' | 'left' | 'right'>
): void {
  const start = waypoints[0];
  if (start.y <= gwBounds.y) {
    usedPorts.add('top');
  } else if (start.y >= gwBounds.y + gwBounds.height) {
    usedPorts.add('bottom');
  } else {
    usedPorts.add('right');
  }
}

function getReservedOutgoingPorts(
  gwId: string,
  ctx: GatewayRouteScopeContext
): Set<'top' | 'bottom' | 'left' | 'right'> {
  const outgoingUsedPorts = new Set(getUsedPorts(ctx.usedPortsMap, gwId));
  for (const inFlow of ctx.sequenceFlows) {
    if (getRefId(inFlow.targetRef) === gwId) {
      const port = ctx.targetPortMap.get(inFlow.id);
      if (port === 'top' || port === 'bottom') {
        outgoingUsedPorts.add(port);
      }
    }
  }
  return outgoingUsedPorts;
}

function routeAllGatewayOutgoingFlows(
  gatewayFlows: Map<string, GatewayFlowInfo[]>,
  ctx: GatewayRouteScopeContext
): Array<{ element: any; waypoints: Point[] }> {
  const edges: Array<{ element: any; waypoints: Point[] }> = [];
  const allBounds = Array.from(ctx.routeCtx.boundsMap.values());

  for (const [gwId, flows] of gatewayFlows.entries()) {
    const gwBounds = ctx.routeCtx.boundsMap.get(gwId)!;
    const hasIncomingFeedback = ctx.sequenceFlows.some((f) => {
      const tgtId = getRefId(f.targetRef);
      return tgtId === gwId && Boolean(ctx.routeCtx.feedbackEdges?.has(f.id));
    });

    const actualUsedPorts = getUsedPorts(ctx.usedPortsMap, gwId);
    const outgoingUsedPorts = getReservedOutgoingPorts(gwId, ctx);
    const routeMap = routeGatewayOutgoingEdges(flows, {
      gatewayBounds: gwBounds,
      allBounds,
      hasIncomingFeedback,
      usedPorts: outgoingUsedPorts,
    });

    for (const f of flows) {
      const waypoints = routeMap.get(f.flow.id)!;
      edges.push({ element: f.flow, waypoints });
      recordOutgoingFlowUsedPort(gwBounds, waypoints, actualUsedPorts);
      const tgtId = getRefId(f.flow.targetRef);
      if (tgtId && f.targetPort) {
        getUsedPorts(ctx.usedPortsMap, tgtId).add(f.targetPort);
      }
    }
  }

  return edges;
}

function markConflictingTopPortUsed(
  gwBounds: Bounds,
  ctx: GatewayRouteScopeContext,
  usedPorts: Set<'top' | 'bottom' | 'left' | 'right'>
): void {
  const gwCenterX = Math.round(gwBounds.x + gwBounds.width / 2);
  for (const [otherId, ports] of ctx.usedPortsMap.entries()) {
    if (!ports.has('bottom')) {
      continue;
    }
    const otherBounds = ctx.routeCtx.boundsMap.get(otherId);
    if (otherBounds && otherBounds.y < gwBounds.y) {
      const otherCenterX = Math.round(otherBounds.x + otherBounds.width / 2);
      if (Math.abs(otherCenterX - gwCenterX) < 20) {
        usedPorts.add('top');
        break;
      }
    }
  }
}

function routeAllGatewayIncomingFlows(
  gatewayFlows: Map<string, GatewayIncomingFlowInfo[]>,
  ctx: GatewayRouteScopeContext
): Array<{ element: any; waypoints: Point[] }> {
  const edges: Array<{ element: any; waypoints: Point[] }> = [];
  const allBounds = Array.from(ctx.routeCtx.boundsMap.values());

  for (const [gwId, flows] of gatewayFlows.entries()) {
    const gwBounds = ctx.routeCtx.boundsMap.get(gwId)!;
    const hasIncomingFeedback = ctx.sequenceFlows.some((f) => {
      const tgtId = getRefId(f.targetRef);
      const srcId = getRefId(f.sourceRef);
      return (tgtId === gwId || srcId === gwId) && Boolean(ctx.routeCtx.feedbackEdges?.has(f.id));
    });

    const usedPorts = getUsedPorts(ctx.usedPortsMap, gwId);
    markConflictingTopPortUsed(gwBounds, ctx, usedPorts);
    const { routes, usedPorts: updatedPorts } = routeGatewayIncomingEdges(flows, {
      gatewayBounds: gwBounds,
      allBounds,
      hasIncomingFeedback,
      usedPorts,
    });
    ctx.usedPortsMap.set(gwId, updatedPorts);

    for (const f of flows) {
      const waypoints = routes.get(f.flow.id)!;
      edges.push({ element: f.flow, waypoints });
    }
  }

  return edges;
}

function routeReturnPathIntermediateFlow(srcBounds: Bounds, tgtBounds: Bounds): Point[] {
  const srcWest: Point = {
    x: srcBounds.x,
    y: Math.round(srcBounds.y + srcBounds.height / 2),
  };
  const tgtEast: Point = {
    x: tgtBounds.x + tgtBounds.width,
    y: Math.round(tgtBounds.y + tgtBounds.height / 2),
  };
  if (srcWest.y === tgtEast.y) {
    return [srcWest, tgtEast];
  }
  const midX = Math.round((srcWest.x + tgtEast.x) / 2);
  return [srcWest, { x: midX, y: srcWest.y }, { x: midX, y: tgtEast.y }, tgtEast];
}

interface OtherFlowsContext {
  boundaryEvents: any[];
  allBounds: Bounds[];
  returnNodes?: Set<string>;
}

function routeOtherFlows(
  otherFlows: Array<{ flow: any; srcId: string; srcBounds: Bounds; tgtBounds: Bounds }>,
  ctx: OtherFlowsContext
): Array<{ element: any; waypoints: Point[] }> {
  const edges: Array<{ element: any; waypoints: Point[] }> = [];
  for (const { flow, srcId, srcBounds, tgtBounds } of otherFlows) {
    const isFromBoundary = ctx.boundaryEvents.some((b: any) => b.id === srcId);
    let waypoints: Point[];
    if (isFromBoundary) {
      waypoints = routeBoundaryExit(srcBounds, tgtBounds, ctx.allBounds);
    } else if (ctx.returnNodes?.has(srcId) && srcBounds.x >= tgtBounds.x + tgtBounds.width) {
      waypoints = routeReturnPathIntermediateFlow(srcBounds, tgtBounds);
    } else {
      waypoints = routeOrthogonalEdge(srcBounds, tgtBounds, ctx.allBounds);
    }
    edges.push({ element: flow, waypoints });
  }
  return edges;
}

export function routeScopeEdges(
  sequenceFlows: any[],
  ctx: ScopeRouteContext
): Array<{ element: any; waypoints: Point[] }> {
  const allBounds = Array.from(ctx.boundsMap.values());
  const gatewaySet = new Set(
    ctx.regularNodes.filter((n) => n.$type?.endsWith('Gateway')).map((n) => n.id)
  );

  const { gatewayOutgoingFlows, gatewayIncomingFlows, otherFlows, targetPortMap } =
    partitionScopeFlows(sequenceFlows, gatewaySet, ctx);

  const usedPortsMap = new Map<string, Set<'top' | 'bottom' | 'left' | 'right'>>();
  const gwCtx: GatewayRouteScopeContext = {
    routeCtx: ctx,
    sequenceFlows,
    targetPortMap,
    usedPortsMap,
  };

  const outEdges = routeAllGatewayOutgoingFlows(gatewayOutgoingFlows, gwCtx);
  const inEdges = routeAllGatewayIncomingFlows(gatewayIncomingFlows, gwCtx);
  const otherEdges = routeOtherFlows(otherFlows, {
    boundaryEvents: ctx.boundaryEvents,
    allBounds,
    returnNodes: ctx.returnNodes,
  });

  return [...outEdges, ...inEdges, ...otherEdges];
}

export function buildScopeGraph(
  regularNodes: any[],
  boundaryEvents: any[],
  sequenceFlows: any[]
): DirectedGraph {
  const graph = new DirectedGraph();
  for (let i = 0; i < regularNodes.length; i++) {
    const node = regularNodes[i];
    graph.addNode(node.id, node, i);
  }
  addBoundaryEventEdges(graph, boundaryEvents, regularNodes.length);
  addSequenceFlowEdges(graph, sequenceFlows);
  return graph;
}

function addSequenceFlowEdges(graph: DirectedGraph, sequenceFlows: any[]): void {
  for (let i = 0; i < sequenceFlows.length; i++) {
    const flow = sequenceFlows[i];
    const srcId = getRefId(flow.sourceRef);
    const tgtId = getRefId(flow.targetRef);
    if (srcId && tgtId && graph.getNode(srcId) && graph.getNode(tgtId)) {
      const srcNode = graph.getNode(srcId)?.data;
      let order = i;
      if (Array.isArray(srcNode?.outgoing)) {
        const outIdx = srcNode.outgoing.findIndex((f: any) => getRefId(f) === flow.id);
        if (outIdx >= 0) {
          order = outIdx;
        }
      }
      graph.addEdge({
        id: flow.id,
        source: srcId,
        target: tgtId,
        data: flow,
        order,
        kind: 'sequence',
      });
    }
  }
}

function assignCoordinatesWithCustomDimensions(
  graph: DirectedGraph,
  ranks: Map<string, number>,
  ctx: LayoutContext
): Map<string, Bounds> {
  for (const node of graph.getNodes()) {
    if (ctx.subDimensions.has(node.id)) {
      const dim = ctx.subDimensions.get(node.id)!;
      node.data.customWidth = dim.width;
      node.data.customHeight = dim.height;
    }
  }
  return assignCoordinates(graph, ranks, {
    ...ctx.options,
    feedbackEdges: ctx.feedbackEdges,
    nodeToLane: ctx.nodeToLane,
  });
}

export function offsetAndCollectChildren(
  child: ScopeLayoutResult,
  parentBounds: Bounds,
  shapes: Array<{ element: any; bounds: Bounds; isExpanded?: boolean }>
): void {
  const offsetX = parentBounds.x + SUBPROCESS_PADDING - child.minX;
  const offsetY = parentBounds.y + SUBPROCESS_HEADER_HEIGHT - child.minY;

  for (const s of child.shapes) {
    shapes.push({
      element: s.element,
      bounds: {
        x: s.bounds.x + offsetX,
        y: s.bounds.y + offsetY,
        width: s.bounds.width,
        height: s.bounds.height,
      },
      isExpanded: s.isExpanded,
    });
  }
}

function computeScopeBoundingBox(shapes: Array<{ bounds: Bounds }>): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const s of shapes) {
    minX = Math.min(minX, s.bounds.x);
    minY = Math.min(minY, s.bounds.y);
    maxX = Math.max(maxX, s.bounds.x + s.bounds.width);
    maxY = Math.max(maxY, s.bounds.y + s.bounds.height);
  }

  return { minX, minY, maxX, maxY };
}

function computeScopeContainerDimensions(bounding: {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}): { width: number; height: number } {
  return {
    width: Math.max(
      SUBPROCESS_MIN_WIDTH,
      bounding.maxX - bounding.minX + SUBPROCESS_CONTAINER_PADDING_X
    ),
    height: Math.max(
      SUBPROCESS_MIN_HEIGHT,
      bounding.maxY - bounding.minY + SUBPROCESS_CONTAINER_PADDING_Y
    ),
  };
}

function isNonVisual(el: any): boolean {
  return el.$type === 'bpmn:DataObject';
}

interface RegularFlowContext {
  scopeElement: any;
  regularNodes: any[];
  boundaryEvents: any[];
  sequenceFlows: any[];
  childScopeResults: Map<string, ScopeLayoutResult>;
  subDimensions: Map<string, { width: number; height: number }>;
  options?: AutoLayoutOptions;
  boundsMap: Map<string, Bounds>;
  shapes: Array<{ element: any; bounds: Bounds; isExpanded?: boolean }>;
}

function alignTerminalBoundaryRanks(
  boundaryEvents: any[],
  graph: DirectedGraph,
  ranks: Map<string, number>
): void {
  for (const bEvent of boundaryEvents) {
    const hostId = getRefId(bEvent.attachedToRef);
    if (!hostId || !ranks.has(hostId)) {
      continue;
    }
    const hostNode = graph.getNode(hostId);
    if (isSubProcessType(hostNode?.data?.$type)) {
      continue;
    }
    const hostBoundaries = graph.outEdges(hostId).filter(isAttachEdge);
    if (hostBoundaries.length !== 1) {
      continue;
    }
    const outEdges = graph.outEdges(bEvent.id);
    if (outEdges.length !== 1) {
      continue;
    }
    const targetId = outEdges[0].target;
    const targetNode = graph.getNode(targetId);
    if (
      targetNode?.data?.$type === 'bpmn:EndEvent' &&
      graph.inEdges(targetId).length === 1 &&
      graph.outEdges(targetId).length === 0
    ) {
      const hostRank = ranks.get(hostId)!;
      ranks.set(bEvent.id, hostRank);
      ranks.set(targetId, hostRank);
    }
  }
}

function clearMergeCorridorObstacles(graph: DirectedGraph, ranks: Map<string, number>): void {
  for (const node of graph.getNodes()) {
    const inEdges = graph.inEdges(node.id).filter((e) => !isAttachEdge(e));
    if (inEdges.length < 2) {
      continue;
    }
    const nodeRank = ranks.get(node.id)!;

    const hasLongIncoming = inEdges.some((e) => {
      const srcRank = ranks.get(e.source);
      return srcRank !== undefined && nodeRank - srcRank >= 2;
    });
    if (!hasLongIncoming) {
      continue;
    }

    for (const other of graph.getNodes()) {
      if (other.id === node.id) {
        continue;
      }
      if (other.data?.$type === 'bpmn:EndEvent' && graph.outEdges(other.id).length === 0) {
        const otherRank = ranks.get(other.id);
        if (otherRank === nodeRank) {
          ranks.set(other.id, nodeRank + 1);
        }
      }
    }
  }
}

function alignScopeEndEvents(graph: DirectedGraph, ranks: Map<string, number>): void {
  const maxRank = Math.max(0, ...ranks.values());
  for (const node of graph.getNodes()) {
    if (node.data?.$type === 'bpmn:EndEvent' && graph.outEdges(node.id).length === 0) {
      ranks.set(node.id, maxRank);
    }
  }
}

function layoutRegularFlowNodes(ctx: RegularFlowContext): ScopeAnalysis {
  const {
    scopeElement,
    regularNodes,
    boundaryEvents,
    sequenceFlows,
    childScopeResults,
    subDimensions,
    options,
    boundsMap,
    shapes,
  } = ctx;

  const graph = buildScopeGraph(regularNodes, boundaryEvents, sequenceFlows);
  const feedbackEdges = findFeedbackEdges(graph);
  const ranks = assignLayers(graph, feedbackEdges);
  const nodeToLane = extractNodeToLaneMap(scopeElement);
  const returnPathAnalysis = alignReturnPathLayers(graph, ranks, { feedbackEdges, nodeToLane });
  alignTerminalBoundaryRanks(boundaryEvents, graph, ranks);
  clearMergeCorridorObstacles(graph, ranks);
  if (options?.alignEndEvents) {
    alignScopeEndEvents(graph, ranks);
  }

  const { augmentedGraph, augmentedRanks } = insertDummyNodes(graph, ranks, {
    feedbackEdges,
  });

  const calculatedBounds = assignCoordinatesWithCustomDimensions(augmentedGraph, augmentedRanks, {
    options,
    feedbackEdges,
    subDimensions,
    nodeToLane,
  });
  for (const [id, b] of calculatedBounds.entries()) {
    boundsMap.set(id, b);
  }

  placeBoundaries(boundaryEvents, boundsMap, graph);

  for (const node of regularNodes) {
    const bounds = boundsMap.get(node.id)!;
    const isSub = isSubProcessType(node.$type);
    shapes.push({ element: node, bounds, isExpanded: isSub ? true : undefined });

    if (isSub && childScopeResults.has(node.id)) {
      const child = childScopeResults.get(node.id)!;
      offsetAndCollectChildren(child, bounds, shapes);
    }
  }

  for (const bEvent of boundaryEvents) {
    shapes.push({ element: bEvent, bounds: boundsMap.get(bEvent.id)! });
  }

  return {
    feedbackEdges,
    returnNodes: returnPathAnalysis.returnNodes,
    returnGateways: returnPathAnalysis.returnGateways,
  };
}

const SUBPROCESS_MAX_ASPECT_RATIO = 6;
const SUBPROCESS_TARGET_ASPECT_RATIO = 2;

interface ScopeCacheContext {
  cache: Map<string, ScopeLayoutResult>;
  subDimensions: Map<string, { width: number; height: number }>;
  callCounter?: { count: number };
}

function layoutScopeCached(
  sub: any,
  options: AutoLayoutOptions | undefined,
  ctx: ScopeCacheContext
): ScopeLayoutResult {
  const key = `${sub.id}|${options?.widthBudget ?? ''}`;
  const cached = ctx.cache.get(key);
  if (cached) {
    return cloneScopeResult(cached);
  }
  const result = layoutScope(sub, options, {
    customDimensions: ctx.subDimensions,
    scopeCache: ctx.cache,
    callCounter: ctx.callCounter,
  });
  ctx.cache.set(key, result);
  return cloneScopeResult(result);
}

interface ResolvedScopeCacheOptions {
  customDimensions?: Map<string, { width: number; height: number }>;
  scopeCache: Map<string, ScopeLayoutResult>;
  callCounter?: { count: number };
}

function layoutChildSubProcesses(
  subProcesses: any[],
  options: AutoLayoutOptions | undefined,
  cacheOptions: ResolvedScopeCacheOptions
): {
  childScopeResults: Map<string, ScopeLayoutResult>;
  subDimensions: Map<string, { width: number; height: number }>;
} {
  const childScopeResults = new Map<string, ScopeLayoutResult>();
  const subDimensions =
    cacheOptions.customDimensions ?? new Map<string, { width: number; height: number }>();
  const ctx: ScopeCacheContext = {
    cache: cacheOptions.scopeCache,
    subDimensions,
    callCounter: cacheOptions.callCounter,
  };

  for (const sub of subProcesses) {
    let childResult = layoutScopeCached(sub, options, ctx);
    const containerRatio = childResult.width / childResult.height;
    if (containerRatio > SUBPROCESS_MAX_ASPECT_RATIO) {
      const area = childResult.width * childResult.height;
      const widthBudget = Math.max(
        SUBPROCESS_WIDTH_BUDGET_FLOOR,
        Math.sqrt(area * SUBPROCESS_TARGET_ASPECT_RATIO)
      );
      childResult = layoutScopeCached(sub, { ...options, widthBudget }, ctx);
    }
    childScopeResults.set(sub.id, childResult);
    subDimensions.set(sub.id, { width: childResult.width, height: childResult.height });
  }

  return { childScopeResults, subDimensions };
}

interface ScopeElementsPartition {
  boundaryEvents: any[];
  sequenceFlows: any[];
  eventSubProcesses: any[];
  compensationHandlers: any[];
  regularNodes: any[];
  allArtifacts: any[];
  allAssociations: any[];
}

function isCompensationHandler(el: any): boolean {
  return el.isForCompensation === true;
}

export function partitionScopeElements(scopeElement: any): ScopeElementsPartition {
  const flowElements = scopeElement.flowElements || [];
  const boundaryEvents = flowElements.filter((el: any) => el.$type === 'bpmn:BoundaryEvent');
  const sequenceFlows = flowElements.filter((el: any) => el.$type === 'bpmn:SequenceFlow');
  const eventSubProcesses = flowElements.filter(isEventSubProcess);
  const compensationHandlers = flowElements.filter(isCompensationHandler);
  const regularNodes = flowElements.filter(
    (el: any) =>
      el.$type !== 'bpmn:SequenceFlow' &&
      el.$type !== 'bpmn:BoundaryEvent' &&
      !isEventSubProcess(el) &&
      !isCompensationHandler(el) &&
      !isArtifact(el) &&
      !isAssociation(el) &&
      !isNonVisual(el)
  );

  const allArtifacts = [
    ...flowElements.filter(isArtifact),
    ...(scopeElement.artifacts || []).filter(isArtifact),
  ];
  const allAssociations = collectScopeAssociations(scopeElement, regularNodes);

  return {
    boundaryEvents,
    sequenceFlows,
    eventSubProcesses,
    compensationHandlers,
    regularNodes,
    allArtifacts,
    allAssociations,
  };
}

export function rerouteProcessEdges(
  process: any,
  boundsMap: Map<string, Bounds>,
  analysis?: ScopeAnalysis
): Array<{ element: any; waypoints: Point[]; isFeedback?: boolean }> {
  const { regularNodes, boundaryEvents, sequenceFlows } = partitionScopeElements(process);
  const routed = routeScopeEdges(sequenceFlows, {
    regularNodes,
    boundaryEvents,
    boundsMap,
    feedbackEdges: analysis?.feedbackEdges,
    returnNodes: analysis?.returnNodes,
    returnGateways: analysis?.returnGateways,
  });
  return routed.map((e) => ({
    ...e,
    isFeedback: analysis?.feedbackEdges?.has(e.element.id),
  }));
}

export interface ScopeRoutingContext {
  /**
   * Final absolute bounds for every node routeScope might need, across the
   * whole process/collaboration -- not just this scope's own nodes. Each
   * recursive call narrows this down to its own scope's nodes before routing,
   * so a sibling subprocess's or another participant's shapes are never
   * treated as obstacles for this scope's own edges.
   */
  boundsMap: Map<string, Bounds>;
  /** Every scope's own ScopeAnalysis (top-level process ids and subprocess ids), keyed by element id. */
  analysisMap: Map<string, ScopeAnalysis>;
}

/**
 * Routes `scopeElement`'s own sequence flows and associations exactly once,
 * over final (post-alignment) absolute bounds, then recurses into every
 * subprocess nested directly inside it -- so every scope in the tree, at any
 * nesting depth, is routed exactly once, after every placement and alignment
 * pass has finished moving nodes. This replaces the early routing layoutScope
 * used to do for itself and every descendant subprocess: layoutScope now only
 * places nodes and records each scope's ScopeAnalysis.
 */
export function routeScope(
  scopeElement: any,
  ctx: ScopeRoutingContext
): Array<{ element: any; waypoints: Point[]; isFeedback?: boolean }> {
  const analysis = ctx.analysisMap.get(scopeElement.id);
  const {
    regularNodes,
    boundaryEvents,
    allArtifacts,
    allAssociations,
    eventSubProcesses,
    compensationHandlers,
  } = partitionScopeElements(scopeElement);

  const localBoundsMap = new Map<string, Bounds>();
  for (const n of [
    ...regularNodes,
    ...boundaryEvents,
    ...allArtifacts,
    ...eventSubProcesses,
    ...compensationHandlers,
  ]) {
    const b = ctx.boundsMap.get(n.id);
    if (b) {
      localBoundsMap.set(n.id, b);
    }
  }

  const edges = rerouteProcessEdges(scopeElement, localBoundsMap, analysis);
  routeAssociations(allAssociations, localBoundsMap, edges);

  const subProcesses = (scopeElement.flowElements || []).filter((el: any) =>
    isSubProcessType(el.$type)
  );
  for (const sub of subProcesses) {
    edges.push(...routeScope(sub, ctx));
  }

  return edges;
}
