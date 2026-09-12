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
import { SUBPROCESS_MIN_WIDTH, SUBPROCESS_MIN_HEIGHT } from '../di-constants';
import type { AutoLayoutOptions, Bounds, Point } from '../types';

export interface ScopeLayoutResult {
  width: number;
  height: number;
  minX: number;
  minY: number;
  shapes: Array<{ element: any; bounds: Bounds; isExpanded?: boolean }>;
  edges: Array<{ element: any; waypoints: Point[] }>;
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
  const childScopeResults = new Map<string, ScopeLayoutResult>();
  const subDimensions = customDimensions ?? new Map<string, { width: number; height: number }>();

  for (const sub of subProcesses) {
    const childResult = layoutScope(sub, options, subDimensions);
    childScopeResults.set(sub.id, childResult);
    subDimensions.set(sub.id, { width: childResult.width, height: childResult.height });
  }

  const boundaryEvents = flowElements.filter((el: any) => el.$type === 'bpmn:BoundaryEvent');
  const regularNodes = flowElements.filter(
    (el: any) => el.$type !== 'bpmn:SequenceFlow' && el.$type !== 'bpmn:BoundaryEvent'
  );
  const sequenceFlows = flowElements.filter((el: any) => el.$type === 'bpmn:SequenceFlow');

  if (regularNodes.length === 0 && boundaryEvents.length === 0) {
    return { width: 100, height: 80, minX: 0, minY: 0, shapes: [], edges: [] };
  }

  const graph = buildScopeGraph(regularNodes, boundaryEvents, sequenceFlows);
  const feedbackEdges = findFeedbackEdges(graph);
  const ranks = assignLayers(graph, feedbackEdges);
  const nodeToLane = extractNodeToLaneMap(scopeElement);

  const boundsMap = assignCoordinatesWithCustomDimensions(graph, ranks, {
    options,
    feedbackEdges,
    subDimensions,
    nodeToLane,
  });

  placeBoundaries(boundaryEvents, boundsMap, graph);

  const shapes: Array<{ element: any; bounds: Bounds; isExpanded?: boolean }> = [];
  const edges: Array<{ element: any; waypoints: Point[] }> = [];

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
  edges.push(...routedEdges);

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

interface ScopeRouteContext {
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

function partitionScopeFlows(
  sequenceFlows: any[],
  gatewaySet: Set<string>,
  ctx: ScopeRouteContext
): PartitionedFlows {
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
