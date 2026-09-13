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
import type { AutoLayoutOptions, Bounds } from './types';

interface ParticipantLayoutParams {
  participant: any;
  process: any;
  plane: any;
  currentY: number;
  allShapesMap: Map<string, Bounds>;
  allShapes: PlacedShape[];
  allEdges: PlacedEdge[];
  allLanes: Array<{ element: any; bounds: Bounds }>;
}

interface PoolAndLanesParams {
  participant: any;
  process: any;
  result: any;
  plane: any;
  currentY: number;
  hasLanes: boolean;
  allLanes?: Array<{ element: any; bounds: Bounds }>;
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
    const { rootElement } = await this.moddle.fromXML(xml);
    const definitions: any = rootElement;
    validateFlowContainers(definitions, this.options);
    const targetElement = this.selectTargetElement(definitions);

    if (!targetElement) {
      const { xml: unformatted } = await this.moddle.toXML(definitions, { format: true });
      return unformatted;
    }

    const diagram = this.diGenerator.ensureDiagram(definitions, targetElement);
    diagram.plane.planeElement = [];

    const collaboration = definitions.rootElements?.find(
      (el: any) => el.$type === 'bpmn:Collaboration'
    );
    if (collaboration) {
      this.layoutCollaboration(definitions, collaboration, diagram.plane);
    } else {
      this.layoutSingleProcesses(definitions, diagram.plane);
    }

    normalizePlaneOrigin(diagram.plane);

    const { xml: resultXml } = await this.moddle.toXML(definitions, { format: true });
    return resultXml;
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
    let startY = 100;

    for (const process of processes) {
      const result = layoutScope(process, this.options);
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

      startY += Math.max(result.height, laneResult.totalHeight) + 60;
    }
  }

  private layoutCollaboration(definitions: any, collaboration: any, plane: any): void {
    const participants = collaboration.participants || [];
    const allShapesMap = new Map<string, Bounds>();
    const allShapes: PlacedShape[] = [];
    const allEdges: PlacedEdge[] = [];
    const allLanes: Array<{ element: any; bounds: Bounds }> = [];
    let currentY = 80;

    for (const participant of participants) {
      const procRef = participant.processRef?.id || participant.processRef;
      const process = definitions.rootElements.find((el: any) => el.id === procRef);
      currentY = this.layoutParticipant({
        participant,
        process,
        plane,
        currentY,
        allShapesMap,
        allShapes,
        allEdges,
        allLanes,
      });
    }

    this.routeAllMessageFlows(collaboration.messageFlows || [], allShapesMap, {
      plane,
      participants,
      edges: allEdges,
    });

    layoutAllLabels({
      shapes: allShapes,
      edges: allEdges,
      lanes: allLanes,
    });

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
    const { participant, process, plane, currentY, allShapesMap, allShapes, allEdges, allLanes } =
      params;
    if (!process) {
      const poolBounds = this.layoutBlackBoxPool(participant, currentY, plane);
      allShapesMap.set(participant.id, poolBounds);
      return currentY + 160;
    }

    const result = layoutScope(process, this.options);
    const hasLanes = Boolean(process.laneSets && process.laneSets[0]?.lanes?.length > 0);

    const deltaX = hasLanes ? 0 : 150 - result.minX;
    const deltaY = hasLanes ? currentY - 80 : currentY + 20 - result.minY;

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

    const poolBounds = this.createPoolAndLanes({
      participant,
      process,
      result,
      plane,
      currentY,
      hasLanes,
      allLanes,
    });

    allShapesMap.set(participant.id, poolBounds);
    for (const s of result.shapes) {
      allShapesMap.set(s.element.id, s.bounds);
    }
    allShapes.push(...result.shapes);
    allEdges.push(...result.edges);

    return currentY + poolBounds.height + 60;
  }

  private layoutBlackBoxPool(participant: any, currentY: number, plane: any): Bounds {
    const poolBounds: Bounds = { x: 100, y: currentY, width: 400, height: 100 };
    this.diGenerator.addShape(plane, participant, poolBounds);
    return poolBounds;
  }

  private createPoolAndLanes(params: PoolAndLanesParams): Bounds {
    const { participant, process, result, plane, currentY, hasLanes, allLanes } = params;
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

      this.diGenerator.addShape(plane, participant, poolBounds);
      for (const lane of laneResult.lanes) {
        this.diGenerator.addShape(plane, lane.element, lane.bounds);
      }
      allLanes?.push(...laneResult.lanes);
      return poolBounds;
    }

    const poolBounds: Bounds = {
      x: 100,
      y: currentY,
      width: Math.max(400, result.width + 100),
      height: Math.max(120, result.height + 40),
    };
    this.diGenerator.addShape(plane, participant, poolBounds);
    return poolBounds;
  }

  private routeAllMessageFlows(
    messageFlows: any[],
    allShapesMap: Map<string, Bounds>,
    options: { plane: any; participants: any[]; edges: PlacedEdge[] }
  ): void {
    const participantIds = new Set(options.participants.map((p: any) => p.id));
    const poolBoundsList = options.participants
      .map((p: any) => allShapesMap.get(p.id))
      .filter((b): b is Bounds => Boolean(b));
    const flowNodeBounds = Array.from(allShapesMap.entries())
      .filter(([id]) => !participantIds.has(id))
      .map(([, b]) => b);

    const flowsByTarget = new Map<string, any[]>();
    for (const flow of messageFlows) {
      const tgtId = flow.targetRef?.id || flow.targetRef;
      if (tgtId) {
        const list = flowsByTarget.get(tgtId) || [];
        list.push(flow);
        flowsByTarget.set(tgtId, list);
      }
    }

    for (const flow of messageFlows) {
      const srcId = flow.sourceRef?.id || flow.sourceRef;
      const tgtId = flow.targetRef?.id || flow.targetRef;
      const srcBounds = allShapesMap.get(srcId);
      const tgtBounds = allShapesMap.get(tgtId);

      if (srcBounds && tgtBounds) {
        const interPoolChannelY = computeInterPoolChannelY(srcBounds, tgtBounds, poolBoundsList);
        const flowsForTarget = flowsByTarget.get(tgtId)!;
        const targetPortX = computeTargetPortX({
          flow,
          flowsForTarget,
          tgtBounds,
          allShapesMap,
          obstacles: flowNodeBounds,
          channelY: interPoolChannelY,
        });

        const waypoints = routeMessageFlow(srcBounds, tgtBounds, {
          obstacles: flowNodeBounds,
          interPoolChannelY,
          targetPortX,
        });
        options.edges.push({ element: flow, waypoints });
      }
    }
  }
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

export interface TargetPortParams {
  flow: any;
  flowsForTarget: any[];
  tgtBounds: Bounds;
  allShapesMap: Map<string, Bounds>;
  obstacles: Bounds[];
  channelY?: number;
}

export function computeTargetPortX(params: TargetPortParams): number | undefined {
  const { flow, flowsForTarget, tgtBounds, allShapesMap, obstacles, channelY } = params;
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
