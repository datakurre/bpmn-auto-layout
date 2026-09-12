import { BpmnModdle } from 'bpmn-moddle';
import type { Bounds, DiagramQualityScore, HardViolations, Point, QualityMetrics } from './types';

interface ExtractedShape {
  id: string;
  elementId: string;
  bounds: Bounds;
  isContainer: boolean;
  attachedToRefId?: string;
}

interface ExtractedEdge {
  id: string;
  elementId: string;
  sourceRefId?: string;
  targetRefId?: string;
  waypoints: Point[];
}

function boxesOverlap(a: Bounds, b: Bounds): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function isPointStrictlyInsideBox(pt: Point, box: Bounds): boolean {
  const margin = 1;
  return (
    pt.x > box.x + margin &&
    pt.x < box.x + box.width - margin &&
    pt.y > box.y + margin &&
    pt.y < box.y + box.height - margin
  );
}

function segmentCrossesBox(p1: Point, p2: Point, box: Bounds): boolean {
  const minX = Math.min(p1.x, p2.x);
  const maxX = Math.max(p1.x, p2.x);
  const minY = Math.min(p1.y, p2.y);
  const maxY = Math.max(p1.y, p2.y);

  if (maxX <= box.x || minX >= box.x + box.width || maxY <= box.y || minY >= box.y + box.height) {
    return false;
  }

  const mid: Point = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  return isPointStrictlyInsideBox(mid, box);
}

function segmentsCross(segA: { p1: Point; p2: Point }, segB: { p1: Point; p2: Point }): boolean {
  const isAHorizontal = segA.p1.y === segA.p2.y;
  const isBHorizontal = segB.p1.y === segB.p2.y;

  if (isAHorizontal === isBHorizontal) {
    return false;
  }

  const h = isAHorizontal ? segA : segB;
  const v = isAHorizontal ? segB : segA;

  const hMinX = Math.min(h.p1.x, h.p2.x);
  const hMaxX = Math.max(h.p1.x, h.p2.x);
  const vMinY = Math.min(v.p1.y, v.p2.y);
  const vMaxY = Math.max(v.p1.y, v.p2.y);
  const vx = v.p1.x;
  const hy = h.p1.y;

  return vx > hMinX && vx < hMaxX && hy > vMinY && hy < vMaxY;
}

export async function scoreDiagram(xml: string): Promise<DiagramQualityScore> {
  const moddle = new BpmnModdle();
  const { rootElement } = await moddle.fromXML(xml);
  const { shapes, edges } = extractDiElements(rootElement);

  const hardViolations = evaluateHardViolations(shapes, edges);
  const metrics = evaluateQualityMetrics(edges);
  const isValid =
    hardViolations.shapeOverlaps === 0 &&
    hardViolations.edgeShapeCrossings === 0 &&
    hardViolations.nonOrthogonalSegments === 0 &&
    hardViolations.collinearDeviations === 0;

  return { hardViolations, metrics, isValid };
}

function parseDiShape(elem: any): ExtractedShape | undefined {
  if (elem.$type !== 'bpmndi:BPMNShape' || !elem.bounds) {
    return undefined;
  }
  const isContainer =
    elem.bpmnElement?.$type === 'bpmn:Participant' ||
    elem.bpmnElement?.$type === 'bpmn:Lane' ||
    (elem.bpmnElement?.$type === 'bpmn:SubProcess' && elem.isExpanded === true);

  return {
    id: elem.id,
    elementId: elem.bpmnElement?.id || '',
    attachedToRefId: elem.bpmnElement?.attachedToRef?.id || elem.bpmnElement?.attachedToRef,
    bounds: {
      x: Number(elem.bounds.x),
      y: Number(elem.bounds.y),
      width: Number(elem.bounds.width),
      height: Number(elem.bounds.height),
    },
    isContainer,
  };
}

function parseDiEdge(elem: any): ExtractedEdge | undefined {
  if (elem.$type !== 'bpmndi:BPMNEdge' || !elem.waypoint) {
    return undefined;
  }
  return {
    id: elem.id,
    elementId: elem.bpmnElement?.id || '',
    sourceRefId: elem.bpmnElement?.sourceRef?.id,
    targetRefId: elem.bpmnElement?.targetRef?.id,
    waypoints: elem.waypoint.map((wp: any) => ({ x: Number(wp.x), y: Number(wp.y) })),
  };
}

function extractDiElements(definitions: any): { shapes: ExtractedShape[]; edges: ExtractedEdge[] } {
  const shapes: ExtractedShape[] = [];
  const edges: ExtractedEdge[] = [];
  const diagrams = definitions.diagrams || [];

  for (const diagram of diagrams) {
    for (const elem of diagram.plane?.planeElement || []) {
      const shape = parseDiShape(elem);
      if (shape) {
        shapes.push(shape);
      }
      const edge = parseDiEdge(elem);
      if (edge) {
        edges.push(edge);
      }
    }
  }

  return { shapes, edges };
}

function evaluateHardViolations(shapes: ExtractedShape[], edges: ExtractedEdge[]): HardViolations {
  return {
    shapeOverlaps: countShapeOverlaps(shapes),
    edgeShapeCrossings: countEdgeShapeCrossings(shapes, edges),
    nonOrthogonalSegments: countNonOrthogonalSegments(edges),
    collinearDeviations: 0,
  };
}

function countShapeOverlaps(shapes: ExtractedShape[]): number {
  let overlaps = 0;
  const flowShapes = shapes.filter((s) => !s.isContainer);
  for (let i = 0; i < flowShapes.length; i++) {
    for (let j = i + 1; j < flowShapes.length; j++) {
      const s1 = flowShapes[i];
      const s2 = flowShapes[j];
      if (s1.attachedToRefId === s2.elementId || s2.attachedToRefId === s1.elementId) {
        continue;
      }
      if (boxesOverlap(s1.bounds, s2.bounds)) {
        overlaps++;
      }
    }
  }
  return overlaps;
}

function countEdgeShapeCrossings(shapes: ExtractedShape[], edges: ExtractedEdge[]): number {
  let crossings = 0;
  const flowShapes = shapes.filter((s) => !s.isContainer);
  for (const edge of edges) {
    for (let i = 0; i < edge.waypoints.length - 1; i++) {
      const p1 = edge.waypoints[i];
      const p2 = edge.waypoints[i + 1];
      for (const shape of flowShapes) {
        if (shape.elementId === edge.sourceRefId || shape.elementId === edge.targetRefId) {
          continue;
        }
        if (segmentCrossesBox(p1, p2, shape.bounds)) {
          crossings++;
        }
      }
    }
  }
  return crossings;
}

function countNonOrthogonalSegments(edges: ExtractedEdge[]): number {
  let nonOrthogonal = 0;
  for (const edge of edges) {
    for (let i = 0; i < edge.waypoints.length - 1; i++) {
      const p1 = edge.waypoints[i];
      const p2 = edge.waypoints[i + 1];
      if (p1.x !== p2.x && p1.y !== p2.y) {
        nonOrthogonal++;
      }
    }
  }
  return nonOrthogonal;
}

function evaluateQualityMetrics(edges: ExtractedEdge[]): QualityMetrics {
  let totalBends = 0;
  let totalEdgeLength = 0;
  const segments: Array<{ p1: Point; p2: Point }> = [];

  for (const edge of edges) {
    totalBends += Math.max(0, edge.waypoints.length - 2);
    for (let i = 0; i < edge.waypoints.length - 1; i++) {
      const p1 = edge.waypoints[i];
      const p2 = edge.waypoints[i + 1];
      totalEdgeLength += Math.abs(p2.x - p1.x) + Math.abs(p2.y - p1.y);
      segments.push({ p1, p2 });
    }
  }

  let edgeCrossings = 0;
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      if (segmentsCross(segments[i], segments[j])) {
        edgeCrossings++;
      }
    }
  }

  return {
    totalBends,
    totalEdgeLength,
    edgeCrossings,
    symmetryError: 0,
  };
}
