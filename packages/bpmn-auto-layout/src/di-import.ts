/**
 * DI -> ProcessLayoutResult importer (#70).
 *
 * Reads an already-serialized bpmndi:BPMNPlane's shapes and edges back into
 * the same NodeLayout / ProcessLayoutResult shape node-placement.ts produces
 * from scratch, so code that operates on that structure (today: the
 * alignment mode in align-layout.ts) can run against an existing,
 * hand-authored diagram the same way it runs against a freshly computed one.
 *
 * Deliberately does not infer track/column/back-edge structure: those are
 * graph-structural decisions layoutProcess (mode (a)) makes, not something
 * this importer should reconstruct from geometry alone. Imported nodes
 * carry track=0, col=0 -- placeholders no consumer in this module reads.
 */
import type { NodeLayout, ProcessLayoutResult } from "./layout-types";
import type { RoutePoint } from "./process-routing";

export interface ImportedPlane {
  layout: ProcessLayoutResult;
  edgeWaypoints: Map<string, RoutePoint[]>;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Import one bpmndi:BPMNPlane's shapes and edges. Returns undefined when the
 * plane has no shape with valid bounds -- nothing usable to align.
 */
export function importPlane(plane: any): ImportedPlane | undefined {
  const nodes = new Map<string, NodeLayout>();
  const allFlows: any[] = [];
  const edgeWaypoints = new Map<string, RoutePoint[]>();

  for (const di of plane?.planeElement ?? []) {
    const element = di.bpmnElement;
    if (!element?.id) continue;
    if (di.$type === "bpmndi:BPMNShape") {
      const bounds = di.bounds;
      if (
        !bounds ||
        !isFiniteNumber(bounds.x) ||
        !isFiniteNumber(bounds.y) ||
        !isFiniteNumber(bounds.width) ||
        !isFiniteNumber(bounds.height)
      ) {
        continue;
      }
      nodes.set(element.id, {
        id: element.id,
        element,
        col: 0,
        track: 0,
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        centerX: bounds.x + bounds.width / 2,
        centerY: bounds.y + bounds.height / 2,
      });
    } else if (di.$type === "bpmndi:BPMNEdge") {
      const points: RoutePoint[] = (di.waypoint ?? [])
        .filter((wp: any) => isFiniteNumber(wp.x) && isFiniteNumber(wp.y))
        .map((wp: any) => ({ x: wp.x, y: wp.y }));
      if (points.length < 2) continue;
      edgeWaypoints.set(element.id, points);
      if (element.$type === "bpmn:SequenceFlow") allFlows.push(element);
    }
  }

  if (nodes.size === 0) return undefined;
  return { layout: { nodes, allFlows }, edgeWaypoints };
}
