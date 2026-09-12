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
import { SUBPROCESS_MIN_WIDTH, SUBPROCESS_MIN_HEIGHT, getElementDimensions } from '../di-constants';
import type { AutoLayoutOptions, Bounds, Point } from '../types';

export interface ScopeLayoutResult {
  width: number;
  height: number;
  minX: number;
  minY: number;
  shapes: Array<{ element: any; bounds: Bounds; isExpanded?: boolean }>;
  edges: Array<{ element: any; waypoints: Point[]; isFeedback?: boolean }>;
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
}

interface PartitionedFlows {
  gatewayOutgoingFlows: Map<string, GatewayFlowInfo[]>;
  gatewayIncomingFlows: Map<string, GatewayIncomingFlowInfo[]>;
  otherFlows: Array<{ flow: any; srcId: string; srcBounds: Bounds; tgtBounds: Bounds }>;
}

function getRefId(ref: any): string | undefined {
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

  return [...outEdges, ...inEdges, ...otherEdges];
}

function buildScopeGraph(
  regularNodes: any[],
  boundaryEvents: any[],
  sequenceFlows: any[]
): DirectedGraph {
  const graph = new DirectedGraph();
  for (const node of regularNodes) {
    graph.addNode(node.id, node);
  }
  addBoundaryEventEdges(graph, boundaryEvents);
  addSequenceFlowEdges(graph, sequenceFlows);
  return graph;
}

function addBoundaryEventEdges(graph: DirectedGraph, boundaryEvents: any[]): void {
  for (const bEvent of boundaryEvents) {
    graph.addNode(bEvent.id, bEvent);
    const hostId = getRefId(bEvent.attachedToRef);
    if (hostId && graph.getNode(hostId)) {
      graph.addEdge({
        id: `_attach_${bEvent.id}`,
        source: hostId,
        target: bEvent.id,
        data: null,
      });
    }
  }
}

function addSequenceFlowEdges(graph: DirectedGraph, sequenceFlows: any[]): void {
  for (const flow of sequenceFlows) {
    const srcId = getRefId(flow.sourceRef);
    const tgtId = getRefId(flow.targetRef);
    if (srcId && tgtId && graph.getNode(srcId) && graph.getNode(tgtId)) {
      graph.addEdge({
        id: flow.id,
        source: srcId,
        target: tgtId,
        data: flow,
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

function offsetAndCollectChildren(
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

function placeBoundaries(
  boundaryEvents: any[],
  boundsMap: Map<string, Bounds>,
  graph: DirectedGraph
): void {
  const eventsByHost = new Map<string, any[]>();
  for (const b of boundaryEvents) {
    const hostId = b.attachedToRef?.id || b.attachedToRef;
    if (hostId) {
      const list = eventsByHost.get(hostId) || [];
      list.push(b);
      eventsByHost.set(hostId, list);
    }
  }

  for (const [hostId, events] of eventsByHost.entries()) {
    const hostBounds = boundsMap.get(hostId);
    if (hostBounds) {
      sortBoundaryEventsByTarget(events, { hostBounds, graph, boundsMap });
    }
  }
}

interface BoundarySortContext {
  hostBounds: Bounds;
  graph: DirectedGraph;
  boundsMap: Map<string, Bounds>;
}

function sortBoundaryEventsByTarget(events: any[], ctx: BoundarySortContext): void {
  const { hostBounds, graph, boundsMap } = ctx;
  events.sort((a, b) => {
    const targetA = graph.outEdges(a.id)[0]?.target;
    const targetB = graph.outEdges(b.id)[0]?.target;
    const boundsA = targetA ? boundsMap.get(targetA) : undefined;
    const boundsB = targetB ? boundsMap.get(targetB) : undefined;
    const yA = boundsA ? boundsA.y : 0;
    const yB = boundsB ? boundsB.y : 0;
    if (yA !== yB) {
      return yB - yA;
    }
    return a.id.localeCompare(b.id);
  });

  const count = events.length;
  if (count === 1) {
    const x = Math.round(hostBounds.x + (hostBounds.width - 36) / 2);
    const y = Math.round(hostBounds.y + hostBounds.height - 18);
    boundsMap.set(events[0].id, { x, y, width: 36, height: 36 });
    return;
  }

  const minX = hostBounds.x + 10;
  const maxX = hostBounds.x + hostBounds.width - 46;
  const step = (maxX - minX) / (count - 1);
  for (let i = 0; i < count; i++) {
    const x = Math.round(minX + i * step);
    const y = Math.round(hostBounds.y + hostBounds.height - 18);
    boundsMap.set(events[i].id, { x, y, width: 36, height: 36 });
  }
}

function routeBoundaryExit(sourceBounds: Bounds, targetBounds: Bounds): Point[] {
  const srcBottom: Point = {
    x: Math.round(sourceBounds.x + sourceBounds.width / 2),
    y: sourceBounds.y + sourceBounds.height,
  };
  const tgtEntry: Point = {
    x: targetBounds.x,
    y: Math.round(targetBounds.y + targetBounds.height / 2),
  };
  return [srcBottom, { x: srcBottom.x, y: tgtEntry.y }, tgtEntry];
}

function isEventSubProcess(el: any): boolean {
  return Boolean(el.$type === 'bpmn:SubProcess' && el.triggeredByEvent);
}

function isArtifact(el: any): boolean {
  return (
    el.$type === 'bpmn:DataObjectReference' ||
    el.$type === 'bpmn:DataStoreReference' ||
    el.$type === 'bpmn:TextAnnotation'
  );
}

function isAssociation(el: any): boolean {
  return el.$type === 'bpmn:Association';
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

  const calculatedBounds = assignCoordinatesWithCustomDimensions(graph, ranks, {
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
  });
  for (const e of routedEdges) {
    edges.push({
      element: e.element,
      waypoints: e.waypoints,
      isFeedback: feedbackEdges.has(e.element.id),
    });
  }
}

function routeAssociations(
  associations: any[],
  boundsMap: Map<string, Bounds>,
  edges: Array<{ element: any; waypoints: Point[]; isFeedback?: boolean }>
): void {
  for (const assoc of associations) {
    if (edges.some((e) => e.element.id === assoc.id)) {
      continue;
    }
    const srcId = getRefId(assoc.sourceRef);
    const tgtId = getRefId(assoc.targetRef);
    const srcBounds = boundsMap.get(srcId as string);
    const tgtBounds = boundsMap.get(tgtId as string);
    if (srcBounds && tgtBounds) {
      const waypoints = routeAssociationEdge(srcBounds, tgtBounds);
      edges.push({ element: assoc, waypoints });
    }
  }
}

function collectTaskDataAssociations(node: any): any[] {
  const result: any[] = [];
  for (const dia of node.dataInputAssociations || []) {
    const src = Array.isArray(dia.sourceRef) ? dia.sourceRef[0] : dia.sourceRef;
    const srcId = getRefId(src);
    result.push({
      $type: 'bpmn:Association',
      id: dia.id ?? `Assoc_${srcId}_${node.id}`,
      sourceRef: src,
      targetRef: node,
    });
  }
  for (const doa of node.dataOutputAssociations || []) {
    const tgtId = getRefId(doa.targetRef);
    result.push({
      $type: 'bpmn:Association',
      id: doa.id ?? `Assoc_${node.id}_${tgtId}`,
      sourceRef: node,
      targetRef: doa.targetRef,
    });
  }
  return result;
}

function collectScopeAssociations(scopeElement: any, regularNodes: any[]): any[] {
  const flowElements = scopeElement.flowElements || [];
  const artifacts = scopeElement.artifacts || [];
  const result = [...flowElements.filter(isAssociation), ...artifacts.filter(isAssociation)];

  for (const node of regularNodes) {
    result.push(...collectTaskDataAssociations(node));
  }

  return result;
}

interface ConnectedArtifactInfo {
  artifact: any;
  hostId: string;
}

function partitionArtifacts(
  artifacts: any[],
  associations: any[],
  regularNodeIds: Set<string>
): {
  connected: ConnectedArtifactInfo[];
  unconnected: any[];
} {
  const connected: ConnectedArtifactInfo[] = [];
  const unconnected: any[] = [];

  for (const art of artifacts) {
    let hostId: string | undefined;
    for (const assoc of associations) {
      const srcId = getRefId(assoc.sourceRef);
      const tgtId = getRefId(assoc.targetRef);
      if (srcId === art.id && tgtId && regularNodeIds.has(tgtId)) {
        hostId = tgtId;
        break;
      }
      if (tgtId === art.id && srcId && regularNodeIds.has(srcId)) {
        hostId = srcId;
        break;
      }
    }
    if (hostId) {
      connected.push({ artifact: art, hostId });
    } else {
      unconnected.push(art);
    }
  }

  return { connected, unconnected };
}

interface ConnectedLayoutContext {
  boundsMap: Map<string, Bounds>;
  shapes: Array<{ element: any; bounds: Bounds; isExpanded?: boolean }>;
}

function layoutConnectedArtifacts(
  connectedList: ConnectedArtifactInfo[],
  ctx: ConnectedLayoutContext
): void {
  const byHost = new Map<string, any[]>();
  for (const item of connectedList) {
    const list = byHost.get(item.hostId) || [];
    list.push(item.artifact);
    byHost.set(item.hostId, list);
  }

  for (const [hostId, artifacts] of byHost.entries()) {
    const hostBounds = ctx.boundsMap.get(hostId)!;
    placeHostArtifacts(artifacts, hostBounds, ctx);
  }
}

function placeHostArtifacts(
  artifacts: any[],
  hostBounds: Bounds,
  ctx: ConnectedLayoutContext
): void {
  const aboveList: any[] = [];
  const belowList: any[] = [];
  const sideList: any[] = [];

  for (const art of artifacts) {
    if (art.$type === 'bpmn:DataStoreReference') {
      belowList.push(art);
    } else if (art.$type === 'bpmn:DataObjectReference') {
      aboveList.push(art);
    } else if (aboveList.length === 0) {
      aboveList.push(art);
    } else if (belowList.length === 0) {
      belowList.push(art);
    } else {
      sideList.push(art);
    }
  }

  const hostCenterX = Math.round(hostBounds.x + hostBounds.width / 2);
  placeArtifactRow(aboveList, {
    hostCenterX,
    y: (h) => hostBounds.y - 30 - h,
    ctx,
  });
  placeArtifactRow(belowList, {
    hostCenterX,
    y: () => hostBounds.y + hostBounds.height + 30,
    ctx,
  });
  placeArtifactSide(sideList, hostBounds, ctx);
}

interface RowPlacementConfig {
  hostCenterX: number;
  y: (height: number) => number;
  ctx: ConnectedLayoutContext;
}

function placeArtifactRow(artifacts: any[], config: RowPlacementConfig): void {
  if (artifacts.length === 0) {
    return;
  }
  const dims = artifacts.map((a) => getElementDimensions(a.$type));
  const totalWidth = dims.reduce((sum, d) => sum + d.width, 0) + (artifacts.length - 1) * 20;
  let curX = Math.round(config.hostCenterX - totalWidth / 2);

  for (let i = 0; i < artifacts.length; i++) {
    const art = artifacts[i];
    const dim = dims[i];
    const bounds: Bounds = {
      x: curX,
      y: config.y(dim.height),
      width: dim.width,
      height: dim.height,
    };
    config.ctx.boundsMap.set(art.id, bounds);
    config.ctx.shapes.push({ element: art, bounds });
    curX += dim.width + 20;
  }
}

function placeArtifactSide(
  artifacts: any[],
  hostBounds: Bounds,
  ctx: ConnectedLayoutContext
): void {
  let curX = hostBounds.x + hostBounds.width + 30;
  for (const art of artifacts) {
    const dim = getElementDimensions(art.$type);
    const bounds: Bounds = {
      x: curX,
      y: Math.round(hostBounds.y + (hostBounds.height - dim.height) / 2),
      width: dim.width,
      height: dim.height,
    };
    ctx.boundsMap.set(art.id, bounds);
    ctx.shapes.push({ element: art, bounds });
    curX += dim.width + 20;
  }
}

export function routeAssociationEdge(sourceBounds: Bounds, targetBounds: Bounds): Point[] {
  const overlapMinX = Math.max(sourceBounds.x, targetBounds.x);
  const overlapMaxX = Math.min(
    sourceBounds.x + sourceBounds.width,
    targetBounds.x + targetBounds.width
  );

  if (overlapMinX < overlapMaxX) {
    const midX = Math.round((overlapMinX + overlapMaxX) / 2);
    if (sourceBounds.y + sourceBounds.height <= targetBounds.y) {
      return [
        { x: midX, y: sourceBounds.y + sourceBounds.height },
        { x: midX, y: targetBounds.y },
      ];
    }
    if (targetBounds.y + targetBounds.height <= sourceBounds.y) {
      return [
        { x: midX, y: sourceBounds.y },
        { x: midX, y: targetBounds.y + targetBounds.height },
      ];
    }
  }

  const overlapMinY = Math.max(sourceBounds.y, targetBounds.y);
  const overlapMaxY = Math.min(
    sourceBounds.y + sourceBounds.height,
    targetBounds.y + targetBounds.height
  );

  if (overlapMinY < overlapMaxY) {
    const midY = Math.round((overlapMinY + overlapMaxY) / 2);
    if (sourceBounds.x + sourceBounds.width <= targetBounds.x) {
      return [
        { x: sourceBounds.x + sourceBounds.width, y: midY },
        { x: targetBounds.x, y: midY },
      ];
    }
    if (targetBounds.x + targetBounds.width <= sourceBounds.x) {
      return [
        { x: sourceBounds.x, y: midY },
        { x: targetBounds.x + targetBounds.width, y: midY },
      ];
    }
  }

  return routeDiagonalAssociation(sourceBounds, targetBounds);
}

function routeDiagonalAssociation(src: Bounds, tgt: Bounds): Point[] {
  const srcCenter: Point = {
    x: Math.round(src.x + src.width / 2),
    y: Math.round(src.y + src.height / 2),
  };
  const tgtCenter: Point = {
    x: Math.round(tgt.x + tgt.width / 2),
    y: Math.round(tgt.y + tgt.height / 2),
  };

  if (src.x + src.width <= tgt.x) {
    const p1: Point = { x: src.x + src.width, y: srcCenter.y };
    const p3: Point = {
      x: tgtCenter.x,
      y: srcCenter.y < tgtCenter.y ? tgt.y : tgt.y + tgt.height,
    };
    return [p1, { x: p3.x, y: p1.y }, p3];
  }

  const p1: Point = {
    x: srcCenter.x,
    y: srcCenter.y < tgtCenter.y ? src.y + src.height : src.y,
  };
  const p3: Point = {
    x: tgt.x + tgt.width,
    y: tgtCenter.y,
  };
  return [p1, { x: p1.x, y: p3.y }, p3];
}

function computeCurrentDiagramBounds(
  shapes: Array<{ bounds: Bounds }>,
  edges: Array<{ waypoints: Point[] }>
): { minX: number; maxX: number; maxY: number } {
  if (shapes.length === 0) {
    return { minX: 100, maxX: 500, maxY: 40 };
  }
  let minX = shapes[0].bounds.x;
  let maxX = shapes[0].bounds.x + shapes[0].bounds.width;
  let maxY = shapes[0].bounds.y + shapes[0].bounds.height;

  for (const s of shapes) {
    minX = Math.min(minX, s.bounds.x);
    maxX = Math.max(maxX, s.bounds.x + s.bounds.width);
    maxY = Math.max(maxY, s.bounds.y + s.bounds.height);
  }
  for (const e of edges) {
    for (const wp of e.waypoints) {
      minX = Math.min(minX, wp.x);
      maxX = Math.max(maxX, wp.x);
      maxY = Math.max(maxY, wp.y);
    }
  }
  return { minX, maxX, maxY };
}

interface DisconnectedLayoutContext {
  childScopeResults: Map<string, ScopeLayoutResult>;
  boundsMap: Map<string, Bounds>;
  shapes: Array<{ element: any; bounds: Bounds; isExpanded?: boolean }>;
  edges: Array<{ element: any; waypoints: Point[]; isFeedback?: boolean }>;
}

function layoutDisconnectedElements(
  items: any[],
  diagramBounds: { minX: number; maxX: number; maxY: number },
  ctx: DisconnectedLayoutContext
): void {
  const rowStartX = diagramBounds.minX;
  const rowBoundaryX = Math.max(diagramBounds.maxX, rowStartX + 600);
  let currentX = rowStartX;
  let currentY = diagramBounds.maxY + 60;
  let rowMaxHeight = 0;

  for (const item of items) {
    const childResult = isEventSubProcess(item) ? ctx.childScopeResults.get(item.id) : undefined;
    const width = childResult
      ? Math.max(SUBPROCESS_MIN_WIDTH, childResult.width)
      : getElementDimensions(item.$type).width;
    const height = childResult
      ? Math.max(SUBPROCESS_MIN_HEIGHT, childResult.height)
      : getElementDimensions(item.$type).height;

    if (currentX > rowStartX && currentX + width > rowBoundaryX) {
      currentX = rowStartX;
      currentY += rowMaxHeight + 40;
      rowMaxHeight = 0;
    }

    const bounds: Bounds = { x: currentX, y: currentY, width, height };
    ctx.boundsMap.set(item.id, bounds);

    if (childResult) {
      ctx.shapes.push({ element: item, bounds, isExpanded: true });
      offsetAndCollectChildren(childResult, bounds, {
        shapes: ctx.shapes,
        edges: ctx.edges,
      });
    } else {
      ctx.shapes.push({ element: item, bounds });
    }

    currentX += width + 40;
    rowMaxHeight = Math.max(rowMaxHeight, height);
  }
}

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
    const childResult = layoutScope(sub, options, subDimensions);
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
