import { BpmnModdle, type BPMNModdle } from 'bpmn-moddle';
import { DiGenerator } from './di-generator';
import { layoutScope } from './hierarchy/subprocess-layout';
import { layoutProcessLanes, routeMessageFlow } from './hierarchy/swimlane-layout';
import type { AutoLayoutOptions, Bounds } from './types';

interface ParticipantLayoutParams {
  participant: any;
  process: any;
  plane: any;
  currentY: number;
  allShapesMap: Map<string, Bounds>;
}

interface PoolAndLanesParams {
  participant: any;
  process: any;
  result: any;
  plane: any;
  currentY: number;
  hasLanes: boolean;
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
      });

      for (const lane of laneResult.lanes) {
        this.diGenerator.addShape(plane, lane.element, lane.bounds);
      }
      for (const s of result.shapes) {
        this.diGenerator.addShape(plane, s.element, { ...s.bounds, isExpanded: s.isExpanded });
      }
      for (const e of result.edges) {
        this.diGenerator.addEdge(plane, e.element, e.waypoints);
      }

      startY += Math.max(result.height, laneResult.totalHeight) + 60;
    }
  }

  private layoutCollaboration(definitions: any, collaboration: any, plane: any): void {
    const participants = collaboration.participants || [];
    const allShapesMap = new Map<string, Bounds>();
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
      });
    }

    this.routeAllMessageFlows(collaboration.messageFlows || [], allShapesMap, plane);
  }

  private layoutParticipant(params: ParticipantLayoutParams): number {
    const { participant, process, plane, currentY, allShapesMap } = params;
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
    });

    allShapesMap.set(participant.id, poolBounds);
    for (const s of result.shapes) {
      this.diGenerator.addShape(plane, s.element, { ...s.bounds, isExpanded: s.isExpanded });
      allShapesMap.set(s.element.id, s.bounds);
    }
    for (const e of result.edges) {
      this.diGenerator.addEdge(plane, e.element, e.waypoints);
    }

    return currentY + poolBounds.height + 60;
  }

  private layoutBlackBoxPool(participant: any, currentY: number, plane: any): Bounds {
    const poolBounds: Bounds = { x: 100, y: currentY, width: 400, height: 100 };
    this.diGenerator.addShape(plane, participant, poolBounds);
    return poolBounds;
  }

  private createPoolAndLanes(params: PoolAndLanesParams): Bounds {
    const { participant, process, result, plane, currentY, hasLanes } = params;
    if (hasLanes) {
      const laneStartX = 130;
      const laneWidth = Math.max(400, result.width + 30);
      const laneResult = layoutProcessLanes(process, result.shapes, {
        startX: laneStartX,
        startY: currentY,
        totalWidth: laneWidth,
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
    plane: any
  ): void {
    for (const flow of messageFlows) {
      const srcId = flow.sourceRef?.id || flow.sourceRef;
      const tgtId = flow.targetRef?.id || flow.targetRef;
      const srcBounds = allShapesMap.get(srcId);
      const tgtBounds = allShapesMap.get(tgtId);

      if (srcBounds && tgtBounds) {
        const waypoints = routeMessageFlow(srcBounds, tgtBounds);
        this.diGenerator.addEdge(plane, flow, waypoints);
      }
    }
  }
}
