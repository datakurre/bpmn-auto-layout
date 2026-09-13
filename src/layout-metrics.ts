import { BpmnModdle } from 'bpmn-moddle';
import type {
  Bounds,
  CompactnessMetrics,
  ContainerCompactness,
  DiagramQualityScore,
  HardViolations,
  Point,
  QualityMetrics,
} from './types';

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

export function boxesOverlap(a: Bounds, b: Bounds): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function segmentCrossesBox(p1: Point, p2: Point, box: Bounds): boolean {
  if (p1.y === p2.y) {
    const y = p1.y;
    if (y <= box.y || y >= box.y + box.height) {
      return false;
    }
    const segMinX = Math.min(p1.x, p2.x);
    const segMaxX = Math.max(p1.x, p2.x);
    return Math.max(segMinX, box.x) < Math.min(segMaxX, box.x + box.width);
  }

  if (p1.x === p2.x) {
    const x = p1.x;
    if (x <= box.x || x >= box.x + box.width) {
      return false;
    }
    const segMinY = Math.min(p1.y, p2.y);
    const segMaxY = Math.max(p1.y, p2.y);
    return Math.max(segMinY, box.y) < Math.min(segMaxY, box.y + box.height);
  }

  const segMinX = Math.min(p1.x, p2.x);
  const segMaxX = Math.max(p1.x, p2.x);
  const segMinY = Math.min(p1.y, p2.y);
  const segMaxY = Math.max(p1.y, p2.y);
  return (
    Math.max(segMinX, box.x) < Math.min(segMaxX, box.x + box.width) &&
    Math.max(segMinY, box.y) < Math.min(segMaxY, box.y + box.height)
  );
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

function computeDiagramBoundingBox(
  shapes: ExtractedShape[],
  edges: ExtractedEdge[]
): { minX: number; minY: number; maxX: number; maxY: number } {
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

  for (const e of edges) {
    for (const pt of e.waypoints) {
      minX = Math.min(minX, pt.x);
      minY = Math.min(minY, pt.y);
      maxX = Math.max(maxX, pt.x);
      maxY = Math.max(maxY, pt.y);
    }
  }

  return { minX, minY, maxX, maxY };
}

function computeContainerCompactness(
  container: ExtractedShape,
  flowShapes: ExtractedShape[]
): ContainerCompactness {
  const cWidth = container.bounds.width;
  const cHeight = container.bounds.height;
  const cArea = cWidth * cHeight;
  const cAspectRatio = cHeight > 0 ? Number((cWidth / cHeight).toFixed(2)) : 0;

  let cNodeArea = 0;
  for (const s of flowShapes) {
    if (
      s.bounds.x >= container.bounds.x &&
      s.bounds.y >= container.bounds.y &&
      s.bounds.x + s.bounds.width <= container.bounds.x + container.bounds.width &&
      s.bounds.y + s.bounds.height <= container.bounds.y + container.bounds.height
    ) {
      cNodeArea += s.bounds.width * s.bounds.height;
    }
  }
  const cDensityRatio = cArea > 0 ? Number((cNodeArea / cArea).toFixed(4)) : 0;

  return {
    id: container.id,
    elementId: container.elementId,
    width: cWidth,
    height: cHeight,
    area: cArea,
    aspectRatio: cAspectRatio,
    densityRatio: cDensityRatio,
  };
}

function evaluateCompactness(shapes: ExtractedShape[], edges: ExtractedEdge[]): CompactnessMetrics {
  const bbox = computeDiagramBoundingBox(shapes, edges);
  if (!Number.isFinite(bbox.minX)) {
    return {
      width: 0,
      height: 0,
      area: 0,
      aspectRatio: 0,
      densityRatio: 0,
      containers: [],
    };
  }

  const width = bbox.maxX - bbox.minX;
  const height = bbox.maxY - bbox.minY;
  const area = width * height;
  const aspectRatio = height > 0 ? Number((width / height).toFixed(2)) : 0;

  const flowShapes = shapes.filter((s) => !s.isContainer);
  let totalNodeArea = 0;
  for (const s of flowShapes) {
    totalNodeArea += s.bounds.width * s.bounds.height;
  }
  const densityRatio = area > 0 ? Number((totalNodeArea / area).toFixed(4)) : 0;

  const containerShapes = shapes.filter((s) => s.isContainer);
  const containers = containerShapes.map((c) => computeContainerCompactness(c, flowShapes));

  return {
    width,
    height,
    area,
    aspectRatio,
    densityRatio,
    containers,
  };
}

export async function scoreDiagram(xml: string): Promise<DiagramQualityScore> {
  const moddle = new BpmnModdle();
  const { rootElement } = await moddle.fromXML(xml);
  const { shapes, edges } = extractDiElements(rootElement);

  const hardViolations = evaluateHardViolations(shapes, edges);
  const metrics = evaluateQualityMetrics(edges);
  const compactness = evaluateCompactness(shapes, edges);
  const isValid =
    hardViolations.shapeOverlaps === 0 &&
    hardViolations.edgeShapeCrossings === 0 &&
    hardViolations.nonOrthogonalSegments === 0;

  return { hardViolations, metrics, compactness, isValid };
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
  };
}
