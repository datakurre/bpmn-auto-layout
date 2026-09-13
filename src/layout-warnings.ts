import { boxesOverlap, segmentCrossesBox } from './layout-metrics';
import { isSubProcessType } from './di-constants';

export type LayoutWarningCode =
  | 'UNRESOLVED_SEQUENCE_FLOW'
  | 'CROSS_CONTAINER_FLOW'
  | 'ROUTE_INTERSECTS_OBSTACLE'
  | 'ROUTE_INVALID_CONNECTION_POINTS'
  | 'ROUTE_NOT_ORTHOGONAL'
  | 'SHAPE_OVERLAPS_SHAPE'
  | 'LABEL_OVERLAPS_ELEMENT'
  | 'CONTAINER_OVERFLOW';

export interface LayoutWarning {
  code: LayoutWarningCode;
  elementId?: string;
  message: string;
}

export function addWarning(warnings: LayoutWarning[] | undefined, warning: LayoutWarning): void {
  warnings?.push(warning);
}

function isContainerShape(el: any): boolean {
  const type = el.bpmnElement?.$type;
  return (
    type === 'bpmn:Participant' ||
    type === 'bpmn:Lane' ||
    (isSubProcessType(type) && el.isExpanded === true)
  );
}

function areShapesAttached(s1: any, s2: any): boolean {
  const a1 = s1.bpmnElement?.attachedToRef?.id || s1.bpmnElement?.attachedToRef;
  const a2 = s2.bpmnElement?.attachedToRef?.id || s2.bpmnElement?.attachedToRef;
  return a1 === s2.bpmnElement?.id || a2 === s1.bpmnElement?.id;
}

function checkShapeOverlaps(flowShapes: any[], warnings: LayoutWarning[]): void {
  for (let i = 0; i < flowShapes.length; i++) {
    for (let j = i + 1; j < flowShapes.length; j++) {
      const s1 = flowShapes[i];
      const s2 = flowShapes[j];
      if (areShapesAttached(s1, s2)) {
        continue;
      }
      if (boxesOverlap(s1.bounds, s2.bounds)) {
        addWarning(warnings, {
          code: 'SHAPE_OVERLAPS_SHAPE',
          elementId: s1.bpmnElement?.id,
          message: `Shape "${s1.bpmnElement?.id}" overlaps with shape "${s2.bpmnElement?.id}"`,
        });
      }
    }
  }
}

function checkContainerEnclosure(
  containers: any[],
  shapesMap: Map<string, any>,
  warnings: LayoutWarning[]
): void {
  for (const c of containers) {
    const flowElements = c.bpmnElement?.flowElements || [];
    for (const child of flowElements) {
      const childShape = shapesMap.get(child.id);
      if (!childShape?.bounds) {
        continue;
      }
      const b = childShape.bounds;
      const cb = c.bounds;
      if (
        b.x < cb.x ||
        b.y < cb.y ||
        b.x + b.width > cb.x + cb.width ||
        b.y + b.height > cb.y + cb.height
      ) {
        addWarning(warnings, {
          code: 'CONTAINER_OVERFLOW',
          elementId: c.bpmnElement?.id,
          message: `Container "${c.bpmnElement?.id}" does not enclose child element "${child.id}"`,
        });
      }
    }
  }
}

function checkEdgeOrthogonality(edges: any[], warnings: LayoutWarning[]): void {
  for (const edge of edges) {
    if (edge.bpmnElement?.$type !== 'bpmn:SequenceFlow') {
      continue;
    }
    const waypoints = edge.waypoint;
    for (let i = 0; i < waypoints.length - 1; i++) {
      const p1 = waypoints[i];
      const p2 = waypoints[i + 1];
      if (p1.x !== p2.x && p1.y !== p2.y) {
        addWarning(warnings, {
          code: 'ROUTE_NOT_ORTHOGONAL',
          elementId: edge.bpmnElement?.id,
          message: `Sequence flow "${edge.bpmnElement?.id}" contains non-orthogonal segment`,
        });
        break;
      }
    }
  }
}

interface SegmentObstacleCheck {
  p1: any;
  p2: any;
  edgeId: string;
  srcId?: string;
  tgtId?: string;
}

function checkSegmentObstacles(
  seg: SegmentObstacleCheck,
  flowShapes: any[],
  warnings: LayoutWarning[]
): void {
  for (const shape of flowShapes) {
    const shapeId = shape.bpmnElement?.id;
    if (shapeId === seg.srcId || shapeId === seg.tgtId) {
      continue;
    }
    if (segmentCrossesBox(seg.p1, seg.p2, shape.bounds)) {
      addWarning(warnings, {
        code: 'ROUTE_INTERSECTS_OBSTACLE',
        elementId: seg.edgeId,
        message: `Edge "${seg.edgeId}" intersects shape "${shapeId}"`,
      });
    }
  }
}

function checkEdgeObstacles(edges: any[], flowShapes: any[], warnings: LayoutWarning[]): void {
  for (const edge of edges) {
    const waypoints = edge.waypoint;
    const srcId = edge.bpmnElement?.sourceRef?.id;
    const tgtId = edge.bpmnElement?.targetRef?.id;
    const edgeId = edge.bpmnElement?.id;

    for (let i = 0; i < waypoints.length - 1; i++) {
      checkSegmentObstacles(
        { p1: waypoints[i], p2: waypoints[i + 1], edgeId, srcId, tgtId },
        flowShapes,
        warnings
      );
    }
  }
}

export function collectPlaneDiagnostics(plane: any, warnings: LayoutWarning[]): void {
  const elements = plane?.planeElement || [];
  const flowShapes: any[] = [];
  const containers: any[] = [];
  const edges: any[] = [];
  const shapesMap = new Map<string, any>();

  for (const el of elements) {
    if (el.$type === 'bpmndi:BPMNShape' && el.bounds) {
      shapesMap.set(el.bpmnElement?.id, el);
      if (isContainerShape(el)) {
        containers.push(el);
      } else {
        flowShapes.push(el);
      }
    } else if (el.$type === 'bpmndi:BPMNEdge' && Array.isArray(el.waypoint)) {
      edges.push(el);
    }
  }

  checkShapeOverlaps(flowShapes, warnings);
  checkContainerEnclosure(containers, shapesMap, warnings);
  checkEdgeOrthogonality(edges, warnings);
  checkEdgeObstacles(edges, flowShapes, warnings);
}
