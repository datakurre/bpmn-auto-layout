import { BpmnModdle, type BPMNModdle } from 'bpmn-moddle';
import { DiGenerator } from './di-generator';
import { layoutScope } from './hierarchy/subprocess-layout';
import {
  layoutProcessLanes,
  routeMessageFlow,
  isMessageCorridorBlocked,
} from './hierarchy/swimlane-layout';
import { layoutAllLabels, type PlacedEdge, type PlacedShape } from './graph/label-layout';
import { normalizePlaneOrigin } from './plane-normalization';
import { validateFlowContainers } from './validation/bpmn-validation';
import { collectPlaneDiagnostics, type LayoutWarning } from './layout-warnings';
import { alignVerticallyStackedPaths, alignIntraProcessBranches } from './hierarchy/path-alignment';
import { ensureBoundariesAttached } from './hierarchy/boundary-events';
import type { AutoLayoutOptions, Bounds, Point } from './types';

interface PoolEntry {
  element: any;
  bounds: Bounds;
  lanes?: Array<{ element: any; bounds: Bounds }>;
}

interface ParticipantLayoutParams {
  participant: any;
  process: any;
  currentY: number;
  allShapesMap: Map<string, Bounds>;
  allShapes: PlacedShape[];
  allEdges: PlacedEdge[];
  allLanes: Array<{ element: any; bounds: Bounds }>;
  allPools: PoolEntry[];
}

interface PoolAndLanesParams {
  participant: any;
  process: any;
  result: any;
  currentY: number;
  hasLanes: boolean;
  contentHeight?: number;
  allLanes?: Array<{ element: any; bounds: Bounds }>;
  allPools: PoolEntry[];
}

export class LayoutEngine {
  private moddle: BPMNModdle;
  private diGenerator: DiGenerator;
  private options?: AutoLayoutOptions;

  constructor(options?: AutoLayoutOptions) {
    this.options = options;
    this.moddle = new BpmnModdle(options?.moddleExtensions);
    this.diGenerator = new DiGenerator(this.moddle);
  }

  public async layout(xml: string): Promise<string> {
    const result = await this.layoutWithDiagnostics(xml);
    return result.xml;
  }

  public async layoutWithDiagnostics(
    xml: string
  ): Promise<{ xml: string; warnings: LayoutWarning[] }> {
    const warnings: LayoutWarning[] = [];
    const { rootElement } = await this.moddle.fromXML(xml);
    const definitions: any = rootElement;
    validateFlowContainers(definitions, this.options, warnings);
    const targetElement = this.selectTargetElement(definitions);

    if (!targetElement) {
      const { xml: unformatted } = await this.moddle.toXML(definitions, { format: true });
      return { xml: unformatted, warnings };
    }

    const diagram = this.diGenerator.ensureDiagram(definitions, targetElement);
    const existingParticipantY = extractExistingParticipantY(diagram.plane);
    diagram.plane.planeElement = [];

    const collaboration = definitions.rootElements?.find(
      (el: any) => el.$type === 'bpmn:Collaboration'
    );
    if (collaboration) {
      this.layoutCollaboration(definitions, collaboration, {
        plane: diagram.plane,
        existingY: existingParticipantY,
      });
    } else {
      this.layoutSingleProcesses(definitions, diagram.plane);
    }

    normalizePlaneOrigin(diagram.plane);
    collectPlaneDiagnostics(diagram.plane, warnings);

    const { xml: resultXml } = await this.moddle.toXML(definitions, { format: true });
    return { xml: resultXml, warnings };
  }

  private selectTargetElement(definitions: any): any {
    const rootElements = definitions.rootElements || [];
    const collaboration = rootElements.find((el: any) => el.$type === 'bpmn:Collaboration');
    if (collaboration) {
      return collaboration;
    }
    return rootElements.find((el: any) => el.$type === 'bpmn:Process');
  }

  private layoutSingleProcesses(definitions: any, plane: any): void {
    const processes = definitions.rootElements.filter((el: any) => el.$type === 'bpmn:Process');
    const FIRST_PROCESS_Y = 100;
    let nextTop: number | null = null;

    for (const process of processes) {
      const result = layoutScope(process, this.options);
      alignIntraProcessBranches({ process, result, options: this.options });
      ensureBoundariesAttached(result.shapes);

      // layoutScope always positions a process as if it were the only one, so every
      // process after the first is translated down. minContentY/maxContentY include
      // edge waypoints, so a loop channel routed above or below the nodes is counted
      // too. The first process is untouched and keeps byte-identical output.
      const { minContentY, maxContentY } = computeScopeContentYExtents(result);
      let startY = FIRST_PROCESS_Y;
      if (nextTop !== null) {
        const top = Math.min(FIRST_PROCESS_Y, minContentY);
        translateScopeResult(result, 0, nextTop - top);
        startY = FIRST_PROCESS_Y + (nextTop - top);
      }

      const laneResult = layoutProcessLanes(process, result.shapes, {
        startX: 100,
        startY,
        totalWidth: result.width,
        edges: result.edges,
      });

      layoutAllLabels({
        shapes: result.shapes,
        edges: result.edges,
        lanes: laneResult.lanes,
      });

      for (const lane of laneResult.lanes) {
        this.diGenerator.addShape(plane, lane.element, lane.bounds);
      }
      for (const s of result.shapes) {
        this.diGenerator.addShape(plane, s.element, {
          ...s.bounds,
          isExpanded: s.isExpanded,
          labelBounds: s.labelBounds,
        });
      }
      for (const e of result.edges) {
        this.diGenerator.addEdge(plane, {
          bpmnElement: e.element,
          waypoints: e.waypoints,
          labelBounds: e.labelBounds,
        });
      }

      const translatedMaxContentY = maxContentY + (startY - FIRST_PROCESS_Y);
      nextTop = Math.max(translatedMaxContentY, startY + laneResult.totalHeight) + 60;
    }
  }

  private layoutCollaboration(
    definitions: any,
    collaboration: any,
    ctx: { plane: any; existingY?: Map<string, number> }
  ): void {
    const plane = ctx.plane;
    const rawParticipants = collaboration.participants || [];
    const participants = orderCollaborationParticipants(rawParticipants, ctx.existingY);
    const allShapesMap = new Map<string, Bounds>();
    const allShapes: PlacedShape[] = [];
    const allEdges: PlacedEdge[] = [];
    const allLanes: Array<{ element: any; bounds: Bounds }> = [];
    const allPools: PoolEntry[] = [];
    let currentY = 80;

    for (const participant of participants) {
      const procRef = participant.processRef?.id || participant.processRef;
      const process = definitions.rootElements.find((el: any) => el.id === procRef);
      currentY = this.layoutParticipant({
        participant,
        process,
        currentY,
        allShapesMap,
        allShapes,
        allEdges,
        allLanes,
        allPools,
      });
    }

    alignVerticallyStackedPaths({
      definitions,
      collaboration,
      allShapesMap,
      allShapes,
      allEdges,
      allLanes,
      allPools,
    });

    ensureBoundariesAttached(allShapes);

    this.routeAllMessageFlows(collaboration.messageFlows || [], allShapesMap, {
      plane,
      participants,
      edges: allEdges,
      allLanes,
      allPools,
    });

    layoutAllLabels({
      shapes: allShapes,
      edges: allEdges,
      lanes: allLanes,
      pools: allPools,
    });

    for (const pool of allPools) {
      this.diGenerator.addShape(plane, pool.element, pool.bounds);
      if (pool.lanes) {
        for (const lane of pool.lanes) {
          this.diGenerator.addShape(plane, lane.element, lane.bounds);
        }
      }
    }

    for (const s of allShapes) {
      this.diGenerator.addShape(plane, s.element, {
        ...s.bounds,
        isExpanded: s.isExpanded,
        labelBounds: s.labelBounds,
      });
    }
    for (const e of allEdges) {
      this.diGenerator.addEdge(plane, {
        bpmnElement: e.element,
        waypoints: e.waypoints,
        labelBounds: e.labelBounds,
      });
    }
  }

  private layoutParticipant(params: ParticipantLayoutParams): number {
    const {
      participant,
      process,
      currentY,
      allShapesMap,
      allShapes,
      allEdges,
      allLanes,
      allPools,
    } = params;
    if (!process) {
      const poolBounds = this.layoutBlackBoxPool(participant, currentY, allPools);
      allShapesMap.set(participant.id, poolBounds);
      return currentY + poolBounds.height + 60;
    }

    const result = layoutScope(process, this.options);
    const hasLanes = Boolean(process.laneSets && process.laneSets[0]?.lanes?.length > 0);
    const { minContentY, maxContentY } = computeScopeContentYExtents(result);
    const contentHeight = maxContentY - minContentY;
    const POOL_PADDING_Y = 25;
    const deltaX = hasLanes ? 0 : 150 - result.minX;
    const padY = hasLanes
      ? POOL_PADDING_Y
      : Math.max(POOL_PADDING_Y, Math.round((120 - contentHeight) / 2));
    const deltaY = currentY + padY - minContentY;

    translateScopeResult(result, deltaX, deltaY);

    const poolBounds = this.createPoolAndLanes({
      participant,
      process,
      result,
      currentY,
      hasLanes,
      contentHeight,
      allLanes,
      allPools,
    });

    allShapesMap.set(participant.id, poolBounds);
    for (const s of result.shapes) {
      allShapesMap.set(s.element.id, s.bounds);
    }
    allShapes.push(...result.shapes);
    allEdges.push(...result.edges);

    return currentY + poolBounds.height + 60;
  }

  private layoutBlackBoxPool(participant: any, currentY: number, allPools?: PoolEntry[]): Bounds {
    const poolBounds: Bounds = { x: 100, y: currentY, width: 400, height: 60 };
    allPools?.push({ element: participant, bounds: poolBounds });
    return poolBounds;
  }

  private createPoolAndLanes(params: PoolAndLanesParams): Bounds {
    const {
      participant,
      process,
      result,
      currentY,
      hasLanes,
      contentHeight = 80,
      allLanes,
      allPools,
    } = params;
    if (hasLanes) {
      const laneStartX = 130;
      const laneWidth = Math.max(400, result.width + 30);
      const laneResult = layoutProcessLanes(process, result.shapes, {
        startX: laneStartX,
        startY: currentY,
        totalWidth: laneWidth,
        edges: result.edges,
      });

      const poolBounds: Bounds = {
        x: 100,
        y: currentY,
        width: laneWidth + 30,
        height: laneResult.totalHeight,
      };

      allPools?.push({ element: participant, bounds: poolBounds, lanes: laneResult.lanes });
      allLanes?.push(...laneResult.lanes);
      return poolBounds;
    }

    const poolBounds: Bounds = {
      x: 100,
      y: currentY,
      width: Math.max(400, result.width + 100),
      height: Math.max(120, contentHeight + 50),
    };
    allPools?.push({ element: participant, bounds: poolBounds });
    return poolBounds;
  }

  private routeAllMessageFlows(
    messageFlows: any[],
    allShapesMap: Map<string, Bounds>,
    options: {
      plane: any;
      participants: any[];
      edges: PlacedEdge[];
      allLanes: Array<{ element: any; bounds: Bounds }>;
      allPools: PoolEntry[];
    }
  ): void {
    const participantIds = new Set(options.participants.map((p: any) => p.id));
    for (const pool of options.allPools) {
      participantIds.add(pool.element.id);
    }
    const laneIds = new Set(options.allLanes.map((lane) => lane.element.id));
    const poolBoundsList = options.participants
      .map((p: any) => allShapesMap.get(p.id))
      .filter((b): b is Bounds => Boolean(b));
    const flowNodeBounds = Array.from(allShapesMap.entries())
      .filter(([id]) => !participantIds.has(id) && !laneIds.has(id))
      .map(([, b]) => b);

    const { targetPorts: poolTargetPorts, sourcePorts: poolSourcePorts } = resolveAllPoolPorts(
      options.participants,
      messageFlows,
      allShapesMap
    );

    const flowsByTarget = groupFlowsByTarget(messageFlows);

    for (const flow of messageFlows) {
      const srcId = flow.sourceRef?.id || flow.sourceRef;
      const tgtId = flow.targetRef?.id || flow.targetRef;
      const srcBounds = allShapesMap.get(srcId);
      const tgtBounds = allShapesMap.get(tgtId);

      if (srcBounds && tgtBounds) {
        const interPoolChannelY = computeInterPoolChannelY(srcBounds, tgtBounds, poolBoundsList);
        const flowsForTarget = flowsByTarget.get(tgtId)!;
        const targetPortX = participantIds.has(tgtId)
          ? poolTargetPorts.get(flow.id)
          : computeTargetPortX({
              flow,
              flowsForTarget,
              tgtBounds,
              allShapesMap,
              obstacles: flowNodeBounds,
              channelY: interPoolChannelY,
            });
        const sourcePortX = participantIds.has(srcId) ? poolSourcePorts.get(flow.id) : undefined;

        const waypoints = routeMessageFlow(srcBounds, tgtBounds, {
          obstacles: flowNodeBounds,
          interPoolChannelY,
          targetPortX,
          sourcePortX,
        });
        options.edges.push({ element: flow, waypoints });
      }
    }
  }
}

export function translateScopeResult(
  result: {
    shapes: Array<{ bounds: Bounds }>;
    edges: Array<{ waypoints: Point[] }>;
  },
  deltaX: number,
  deltaY: number
): void {
  for (const s of result.shapes) {
    s.bounds.x += deltaX;
    s.bounds.y += deltaY;
  }
  for (const e of result.edges) {
    for (const wp of e.waypoints) {
      wp.x += deltaX;
      wp.y += deltaY;
    }
  }
}

export function computeScopeContentYExtents(result: {
  shapes: Array<{ bounds: Bounds }>;
  edges: Array<{ waypoints: Point[] }>;
}): { minContentY: number; maxContentY: number } {
  let minContentY = Infinity;
  let maxContentY = -Infinity;
  for (const s of result.shapes) {
    minContentY = Math.min(minContentY, s.bounds.y);
    maxContentY = Math.max(maxContentY, s.bounds.y + s.bounds.height);
  }
  for (const e of result.edges) {
    for (const wp of e.waypoints) {
      minContentY = Math.min(minContentY, wp.y);
      maxContentY = Math.max(maxContentY, wp.y);
    }
  }
  if (minContentY === Infinity) {
    return { minContentY: 80, maxContentY: 160 };
  }
  return { minContentY, maxContentY };
}

export interface ApproachContext {
  targetBounds: Bounds;
  obstacles: Bounds[];
  channelY?: number;
}

export function findEnclosingPool(bounds: Bounds, pools: Bounds[]): Bounds | undefined {
  return (
    pools.find((p) => p === bounds) ??
    pools.find(
      (p) =>
        bounds.x >= p.x - 5 &&
        bounds.x + bounds.width <= p.x + p.width + 5 &&
        bounds.y >= p.y - 5 &&
        bounds.y + bounds.height <= p.y + p.height + 5
    )
  );
}

export function computeInterPoolChannelY(
  srcBounds: Bounds,
  tgtBounds: Bounds,
  pools: Bounds[]
): number | undefined {
  const srcPool = findEnclosingPool(srcBounds, pools);
  const tgtPool = findEnclosingPool(tgtBounds, pools);
  if (!srcPool || !tgtPool || srcPool === tgtPool) {
    return undefined;
  }
  const [upper, lower] = srcPool.y < tgtPool.y ? [srcPool, tgtPool] : [tgtPool, srcPool];
  return Math.round((upper.y + upper.height + lower.y) / 2);
}

export function getEffectiveApproachX(sourceBounds: Bounds, ctx: ApproachContext): number {
  const isUpward = sourceBounds.y >= ctx.targetBounds.y + ctx.targetBounds.height;
  const centerX = Math.round(sourceBounds.x + sourceBounds.width / 2);
  const srcY = isUpward ? sourceBounds.y : sourceBounds.y + sourceBounds.height;
  const tgtY = isUpward ? ctx.targetBounds.y + ctx.targetBounds.height : ctx.targetBounds.y;
  const midY = ctx.channelY ?? Math.round((srcY + tgtY) / 2);
  const blocked = isMessageCorridorBlocked(centerX, [srcY, midY], {
    ignore: [sourceBounds, ctx.targetBounds],
    obstacles: ctx.obstacles,
  });
  if (blocked) {
    return sourceBounds.x + sourceBounds.width + 20;
  }
  return centerX;
}

export interface PoolPortEntry {
  flowId: string;
  idealX: number;
}

export function layoutPoolConnectionPorts(
  poolBounds: Bounds,
  entries: PoolPortEntry[]
): Map<string, number> {
  const result = new Map<string, number>();
  if (entries.length === 0) {
    return result;
  }
  if (entries.length === 1) {
    result.set(entries[0].flowId, entries[0].idealX);
    return result;
  }

  const sorted = [...entries].sort((a, b) => {
    if (a.idealX !== b.idealX) {
      return a.idealX - b.idealX;
    }
    return a.flowId.localeCompare(b.flowId);
  });

  const MIN_PORT_SPACING = 30;
  const positions = sorted.map((e) => e.idealX);
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] < positions[i - 1] + MIN_PORT_SPACING) {
      positions[i] = positions[i - 1] + MIN_PORT_SPACING;
    }
  }

  const maxAllowedX = poolBounds.x + poolBounds.width - 20;
  if (positions[positions.length - 1] > maxAllowedX) {
    const overflow = positions[positions.length - 1] - maxAllowedX;
    for (let i = positions.length - 1; i >= 0; i--) {
      positions[i] = Math.max(poolBounds.x + 20, positions[i] - overflow);
    }
  }

  for (let i = 0; i < sorted.length; i++) {
    result.set(sorted[i].flowId, positions[i]);
  }
  return result;
}

export interface CollectPoolPortsParams {
  poolId: string;
  poolBounds: Bounds;
  messageFlows: any[];
  allShapesMap: Map<string, Bounds>;
}

export function collectPoolPortEntries(params: CollectPoolPortsParams): PoolPortEntry[] {
  const { poolId, poolBounds, messageFlows, allShapesMap } = params;
  const entries: PoolPortEntry[] = [];
  for (const flow of messageFlows) {
    const srcId = flow.sourceRef?.id || flow.sourceRef;
    const tgtId = flow.targetRef?.id || flow.targetRef;
    if (tgtId === poolId) {
      const srcBounds = allShapesMap.get(srcId);
      const rawX = srcBounds
        ? Math.round(srcBounds.x + srcBounds.width / 2)
        : Math.round(poolBounds.x + poolBounds.width / 2);
      const idealX = Math.max(
        poolBounds.x + 20,
        Math.min(poolBounds.x + poolBounds.width - 20, rawX)
      );
      entries.push({ flowId: flow.id, idealX });
    } else if (srcId === poolId) {
      const tgtBounds = allShapesMap.get(tgtId);
      const rawX = tgtBounds
        ? Math.round(tgtBounds.x + tgtBounds.width / 2)
        : Math.round(poolBounds.x + poolBounds.width / 2);
      const idealX = Math.max(
        poolBounds.x + 20,
        Math.min(poolBounds.x + poolBounds.width - 20, rawX)
      );
      entries.push({ flowId: flow.id, idealX });
    }
  }
  return entries;
}

export interface PoolPortsMap {
  targetPorts: Map<string, number>;
  sourcePorts: Map<string, number>;
}

export function resolveAllPoolPorts(
  participants: any[],
  messageFlows: any[],
  allShapesMap: Map<string, Bounds>
): PoolPortsMap {
  const targetPorts = new Map<string, number>();
  const sourcePorts = new Map<string, number>();

  for (const p of participants) {
    const poolBounds = allShapesMap.get(p.id);
    if (!poolBounds) {
      continue;
    }
    const entries = collectPoolPortEntries({
      poolId: p.id,
      poolBounds,
      messageFlows,
      allShapesMap,
    });
    const portMap = layoutPoolConnectionPorts(poolBounds, entries);
    for (const flow of messageFlows) {
      const flowId = flow.id;
      const resolved = portMap.get(flowId);
      if (resolved !== undefined) {
        const tgtId = flow.targetRef?.id || flow.targetRef;
        if (tgtId === p.id) {
          targetPorts.set(flowId, resolved);
        } else {
          sourcePorts.set(flowId, resolved);
        }
      }
    }
  }

  return { targetPorts, sourcePorts };
}

export function groupFlowsByTarget(messageFlows: any[]): Map<string, any[]> {
  const flowsByTarget = new Map<string, any[]>();
  for (const flow of messageFlows) {
    const tgtId = flow.targetRef?.id || flow.targetRef;
    if (tgtId) {
      const list = flowsByTarget.get(tgtId) || [];
      list.push(flow);
      flowsByTarget.set(tgtId, list);
    }
  }
  return flowsByTarget;
}

export interface TargetPortParams {
  flow: any;
  flowsForTarget: any[];
  tgtBounds: Bounds;
  allShapesMap: Map<string, Bounds>;
  obstacles: Bounds[];
  channelY?: number;
  isTargetPool?: boolean;
}

export function computeTargetPortX(params: TargetPortParams): number | undefined {
  const { flow, flowsForTarget, tgtBounds, allShapesMap, obstacles, channelY, isTargetPool } =
    params;

  if (isTargetPool) {
    const entries = flowsForTarget.map((f) => {
      const srcId = f.sourceRef?.id || f.sourceRef;
      const srcBounds = allShapesMap.get(srcId);
      const rawX = srcBounds
        ? Math.round(srcBounds.x + srcBounds.width / 2)
        : Math.round(tgtBounds.x + tgtBounds.width / 2);
      const idealX = Math.max(tgtBounds.x + 20, Math.min(tgtBounds.x + tgtBounds.width - 20, rawX));
      return { flowId: f.id, idealX };
    });
    const portMap = layoutPoolConnectionPorts(tgtBounds, entries);
    return portMap.get(flow.id);
  }

  if (flowsForTarget.length <= 1) {
    return undefined;
  }

  const sorted = [...flowsForTarget].sort((a, b) => {
    const srcA = allShapesMap.get(a.sourceRef?.id || a.sourceRef);
    const srcB = allShapesMap.get(b.sourceRef?.id || b.sourceRef);
    const xA = srcA
      ? getEffectiveApproachX(srcA, { targetBounds: tgtBounds, obstacles, channelY })
      : 0;
    const xB = srcB
      ? getEffectiveApproachX(srcB, { targetBounds: tgtBounds, obstacles, channelY })
      : 0;
    if (xA !== xB) {
      return xA - xB;
    }
    return (a.id || '').localeCompare(b.id || '');
  });

  const index = sorted.findIndex((f) => f.id === flow.id);
  return tgtBounds.x + Math.round((tgtBounds.width * (index + 1)) / (sorted.length + 1));
}

export function orderCollaborationParticipants(
  participants: any[],
  existingY?: Map<string, number>
): any[] {
  if (!participants || participants.length <= 1) {
    return participants || [];
  }
  if (existingY && existingY.size > 0) {
    const hasAnyY = participants.some((p) => existingY.has(p.id));
    if (hasAnyY) {
      return [...participants].sort((a, b) => {
        const yA = existingY.get(a.id);
        const yB = existingY.get(b.id);
        if (yA !== undefined && yB !== undefined) {
          return yA - yB;
        }
        if (yA !== undefined) {
          return -1;
        }
        if (yB !== undefined) {
          return 1;
        }
        return 0;
      });
    }
  }
  return participants;
}

export function extractExistingParticipantY(plane: any): Map<string, number> {
  const existingY = new Map<string, number>();
  for (const pe of plane?.planeElement || []) {
    const ref = pe.bpmnElement;
    const bpmnId = typeof ref === 'string' ? ref : ref?.id;
    if (bpmnId && pe.bounds?.y !== undefined) {
      existingY.set(bpmnId, pe.bounds.y);
    }
  }
  return existingY;
}
