import { DirectedGraph } from '../graph/graph';
import { findFeedbackEdges } from '../graph/cycle-removal';
import { assignLayers } from '../graph/layer-assignment';
import { assignCoordinates } from '../graph/coordinate-assignment';
import { routeOrthogonalEdge } from '../graph/orthogonal-router';
import {
  routeGatewayOutgoingEdges,
  routeGatewayIncomingEdges,
  type GatewayFlowInfo,
  type GatewayIncomingFlowInfo,
} from '../graph/gateway-router';
import { insertDummyNodes, routeEdgeThroughDummyChain, boundsCenter } from '../graph/dummy-nodes';
import { SUBPROCESS_MIN_WIDTH, SUBPROCESS_MIN_HEIGHT } from '../di-constants';
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
  edges: Array<{
    element: any;
    waypoints: Point[];
    isFeedback?: boolean;
    labelBounds?: Bounds;
  }>;
}

interface LayoutContext {
  options?: AutoLayoutOptions;
  feedbackEdges: Set<string>;
  subDimensions: Map<string, { width: number; height: number }>;
  nodeToLane?: Map<string, number>;
}

export function layoutScope(
  scopeElement: any,
  options?: AutoLayoutOptions,
  customDimensions?: Map<string, { width: number; height: number }>
): ScopeLayoutResult {
  const flowElements = scopeElement.flowElements || [];
  const subProcesses = flowElements.filter((el: any) => el.$type === 'bpmn:SubProcess');
  const { childScopeResults, subDimensions } = layoutChildSubProcesses(
    subProcesses,
    options,
    customDimensions
  );

  const partition = partitionScopeElements(scopeElement);
  const {
    boundaryEvents,
    sequenceFlows,
    eventSubProcesses,
    regularNodes,
    allArtifacts,
    allAssociations,
  } = partition;

  if (
    regularNodes.length === 0 &&
    boundaryEvents.length === 0 &&
    eventSubProcesses.length === 0 &&
    allArtifacts.length === 0
  ) {
    return { width: 100, height: 80, minX: 0, minY: 0, shapes: [], edges: [] };
  }

  const boundsMap = new Map<string, Bounds>();
  const shapes: Array<{ element: any; bounds: Bounds; isExpanded?: boolean }> = [];
  const edges: Array<{ element: any; waypoints: Point[]; isFeedback?: boolean }> = [];

  if (regularNodes.length > 0 || boundaryEvents.length > 0) {
    layoutRegularFlowNodes({
      scopeElement,
      regularNodes,
      boundaryEvents,
      sequenceFlows,
      childScopeResults,
      subDimensions,
      options,
      boundsMap,
      shapes,
      edges,
    });
  }

  const regularNodeIds = new Set<string>(regularNodes.map((n: any) => n.id));
  const { connected, unconnected } = partitionArtifacts(
    allArtifacts,
    allAssociations,
    regularNodeIds
  );

  layoutConnectedArtifacts(connected, { boundsMap, shapes });
  routeAssociations(allAssociations, boundsMap, edges);

  const disconnectedItems = [...eventSubProcesses, ...unconnected];
  if (disconnectedItems.length > 0) {
    const diagramBounds = computeCurrentDiagramBounds(shapes, edges);
    layoutDisconnectedElements(disconnectedItems, diagramBounds, {
      childScopeResults,
      boundsMap,
      shapes,
      edges,
    });
    routeAssociations(allAssociations, boundsMap, edges);
  }

  const bounding = computeScopeBoundingBox(shapes);
  return {
    width: Math.max(SUBPROCESS_MIN_WIDTH, bounding.maxX - bounding.minX + 60),
    height: Math.max(SUBPROCESS_MIN_HEIGHT, bounding.maxY - bounding.minY + 70),
    minX: bounding.minX,
    minY: bounding.minY,
    shapes,
    edges,
  };
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
  edgeDummyChains?: Map<string, string[]>;
}

interface PartitionedFlows {
  gatewayOutgoingFlows: Map<string, GatewayFlowInfo[]>;
  gatewayIncomingFlows: Map<string, GatewayIncomingFlowInfo[]>;
  otherFlows: Array<{ flow: any; srcId: string; srcBounds: Bounds; tgtBounds: Bounds }>;
}

export function getRefId(ref: any): string | undefined {
  return ref?.id || ref;
}

export interface IncomingFlowCandidate {
  flow: any;
  sourceBounds: Bounds;
  isFeedback?: boolean;
}

export function assignMergeIncomingPorts(
  flows: IncomingFlowCandidate[],
  gwBounds: Bounds
): Map<string, 'top' | 'bottom' | 'left'> {
  const ports = new Map<string, 'top' | 'bottom' | 'left'>();
  const gwCenterY = gwBounds.y + gwBounds.height / 2;

  const forwardFlows: IncomingFlowCandidate[] = [];
  for (const f of flows) {
    const isBackwards = f.sourceBounds.x + f.sourceBounds.width > gwBounds.x;
    if (f.isFeedback || isBackwards) {
      ports.set(f.flow.id, 'left');
    } else {
      forwardFlows.push(f);
    }
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
  if (below.length > 0) {
    const bottomFlow = below.shift()!;
    ports.set(bottomFlow.flow.id, 'bottom');
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
): Map<string, 'top' | 'bottom' | 'left'> {
  const targetPortMap = new Map<string, 'top' | 'bottom' | 'left'>();

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
    const ports = assignMergeIncomingPorts(incomingFlows, gwBounds);
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
        list.push({
          flow,
          targetBounds: tgtBounds,
          isFeedback: ctx.feedbackEdges?.has(flow.id),
          targetPort: targetPortMap.get(flow.id),
        });
        gatewayOutgoingFlows.set(srcId!, list);
      } else if (gatewaySet.has(tgtId!)) {
        const list = gatewayIncomingFlows.get(tgtId!) || [];
        list.push({
          flow,
          sourceBounds: srcBounds,
          isFeedback: ctx.feedbackEdges?.has(flow.id),
        });
        gatewayIncomingFlows.set(tgtId!, list);
      } else {
        otherFlows.push({ flow, srcId: srcId!, srcBounds, tgtBounds });
      }
    }
  }

  return { gatewayOutgoingFlows, gatewayIncomingFlows, otherFlows };
}

interface GatewayRouteScopeContext {
  routeCtx: ScopeRouteContext;
  sequenceFlows: any[];
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

    const usedPorts = getUsedPorts(ctx.usedPortsMap, gwId);
    const routeMap = routeGatewayOutgoingEdges(flows, {
      gatewayBounds: gwBounds,
      allBounds,
      hasIncomingFeedback,
      usedPorts,
    });
    ctx.usedPortsMap.set(gwId, usedPorts);

    for (const f of flows) {
      const waypoints = routeMap.get(f.flow.id)!;
      edges.push({ element: f.flow, waypoints });
      const tgtId = getRefId(f.flow.targetRef);
      if (tgtId && f.targetPort) {
        getUsedPorts(ctx.usedPortsMap, tgtId).add(f.targetPort);
      }
    }
  }

  return edges;
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

function routeOtherFlows(
  otherFlows: Array<{ flow: any; srcId: string; srcBounds: Bounds; tgtBounds: Bounds }>,
  boundaryEvents: any[],
  allBounds: Bounds[]
): Array<{ element: any; waypoints: Point[] }> {
  const edges: Array<{ element: any; waypoints: Point[] }> = [];
  for (const { flow, srcId, srcBounds, tgtBounds } of otherFlows) {
    const isFromBoundary = boundaryEvents.some((b: any) => b.id === srcId);
    const waypoints = isFromBoundary
      ? routeBoundaryExit(srcBounds, tgtBounds)
      : routeOrthogonalEdge(srcBounds, tgtBounds, allBounds);
    edges.push({ element: flow, waypoints });
  }
  return edges;
}

function routeScopeEdges(
  sequenceFlows: any[],
  ctx: ScopeRouteContext
): Array<{ element: any; waypoints: Point[] }> {
  const allBounds = Array.from(ctx.boundsMap.values());
  const gatewaySet = new Set(
    ctx.regularNodes.filter((n) => n.$type?.endsWith('Gateway')).map((n) => n.id)
  );

  const { gatewayOutgoingFlows, gatewayIncomingFlows, otherFlows } = partitionScopeFlows(
    sequenceFlows,
    gatewaySet,
    ctx
  );

  const usedPortsMap = new Map<string, Set<'top' | 'bottom' | 'left' | 'right'>>();
  const gwCtx: GatewayRouteScopeContext = {
    routeCtx: ctx,
    sequenceFlows,
    usedPortsMap,
  };

  const outEdges = routeAllGatewayOutgoingFlows(gatewayOutgoingFlows, gwCtx);
  const inEdges = routeAllGatewayIncomingFlows(gatewayIncomingFlows, gwCtx);
  const otherEdges = routeOtherFlows(otherFlows, ctx.boundaryEvents, allBounds);

  const routedEdges = [...outEdges, ...inEdges, ...otherEdges];
  return applyDummyChainRouting(routedEdges, ctx, allBounds);
}

function applyDummyChainRouting(
  edges: Array<{ element: any; waypoints: Point[] }>,
  ctx: ScopeRouteContext,
  allBounds: Bounds[]
): Array<{ element: any; waypoints: Point[] }> {
  const edgeDummyChains = ctx.edgeDummyChains;
  if (!edgeDummyChains || edgeDummyChains.size === 0) {
    return edges;
  }

  return edges.map((e) => {
    const chain = edgeDummyChains.get(e.element.id);
    if (!chain || chain.length === 0 || e.waypoints.length < 2) {
      return e;
    }
    // Every id in the chain was added to the same augmented graph that
    // produced boundsMap, so each one is guaranteed a bounds entry.
    const dummyPoints = chain.map((id) => boundsCenter(ctx.boundsMap.get(id)!));
    const first = e.waypoints[0];
    const last = e.waypoints[e.waypoints.length - 1];
    const waypoints = routeEdgeThroughDummyChain([first, ...dummyPoints, last], allBounds);
    return { element: e.element, waypoints };
  });
}

function buildScopeGraph(
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
  collector: {
    shapes: Array<{ element: any; bounds: Bounds; isExpanded?: boolean }>;
    edges: Array<{ element: any; waypoints: Point[] }>;
  }
): void {
  const offsetX = parentBounds.x + 30 - child.minX;
  const offsetY = parentBounds.y + 35 - child.minY;

  for (const s of child.shapes) {
    collector.shapes.push({
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

  for (const e of child.edges) {
    collector.edges.push({
      element: e.element,
      waypoints: e.waypoints.map((pt) => ({
        x: pt.x + offsetX,
        y: pt.y + offsetY,
      })),
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
  edges: Array<{ element: any; waypoints: Point[]; isFeedback?: boolean }>;
}

function layoutRegularFlowNodes(ctx: RegularFlowContext): void {
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
    edges,
  } = ctx;

  const graph = buildScopeGraph(regularNodes, boundaryEvents, sequenceFlows);
  const feedbackEdges = findFeedbackEdges(graph);
  const ranks = assignLayers(graph, feedbackEdges);
  const nodeToLane = extractNodeToLaneMap(scopeElement);

  const { augmentedGraph, augmentedRanks, edgeDummyChains } = insertDummyNodes(graph, ranks, {
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
    const isSub = node.$type === 'bpmn:SubProcess';
    shapes.push({ element: node, bounds, isExpanded: isSub ? true : undefined });

    if (isSub && childScopeResults.has(node.id)) {
      const child = childScopeResults.get(node.id)!;
      offsetAndCollectChildren(child, bounds, { shapes, edges });
    }
  }

  for (const bEvent of boundaryEvents) {
    shapes.push({ element: bEvent, bounds: boundsMap.get(bEvent.id)! });
  }

  const routedEdges = routeScopeEdges(sequenceFlows, {
    regularNodes,
    boundaryEvents,
    boundsMap,
    feedbackEdges,
    edgeDummyChains,
  });
  for (const e of routedEdges) {
    edges.push({
      element: e.element,
      waypoints: e.waypoints,
      isFeedback: feedbackEdges.has(e.element.id),
    });
  }
}

const SUBPROCESS_MAX_ASPECT_RATIO = 6;
const SUBPROCESS_TARGET_ASPECT_RATIO = 2;

function layoutChildSubProcesses(
  subProcesses: any[],
  options?: AutoLayoutOptions,
  customDimensions?: Map<string, { width: number; height: number }>
): {
  childScopeResults: Map<string, ScopeLayoutResult>;
  subDimensions: Map<string, { width: number; height: number }>;
} {
  const childScopeResults = new Map<string, ScopeLayoutResult>();
  const subDimensions = customDimensions ?? new Map<string, { width: number; height: number }>();

  for (const sub of subProcesses) {
    let childResult = layoutScope(sub, options, subDimensions);
    const containerRatio = childResult.width / childResult.height;
    if (containerRatio > SUBPROCESS_MAX_ASPECT_RATIO) {
      const area = childResult.width * childResult.height;
      const widthBudget = Math.max(600, Math.sqrt(area * SUBPROCESS_TARGET_ASPECT_RATIO));
      childResult = layoutScope(sub, { ...options, widthBudget }, subDimensions);
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
  regularNodes: any[];
  allArtifacts: any[];
  allAssociations: any[];
}

function partitionScopeElements(scopeElement: any): ScopeElementsPartition {
  const flowElements = scopeElement.flowElements || [];
  const boundaryEvents = flowElements.filter((el: any) => el.$type === 'bpmn:BoundaryEvent');
  const sequenceFlows = flowElements.filter((el: any) => el.$type === 'bpmn:SequenceFlow');
  const eventSubProcesses = flowElements.filter(isEventSubProcess);
  const regularNodes = flowElements.filter(
    (el: any) =>
      el.$type !== 'bpmn:SequenceFlow' &&
      el.$type !== 'bpmn:BoundaryEvent' &&
      !isEventSubProcess(el) &&
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
    regularNodes,
    allArtifacts,
    allAssociations,
  };
}
