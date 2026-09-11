import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { BpmnModdle } from "bpmn-moddle";

const testDir = path.dirname(fileURLToPath(import.meta.url));
export const fixturesDir = path.resolve(testDir, "../../../../fixtures");

export function listFixtures(): string[] {
  return readdirSync(fixturesDir)
    .filter((name) => name.endsWith(".bpmn"))
    .sort();
}

export function readFixture(name: string): string {
  return readFileSync(path.join(fixturesDir, name), "utf8");
}

export interface DiShape {
  id: string;
  bpmnElement: string;
  bounds: { x: number; y: number; width: number; height: number };
  isExpanded?: boolean;
}

export interface DiEdge {
  id: string;
  bpmnElement: string;
  waypoints: Array<{ x: number; y: number }>;
}

export interface ParsedDiagram {
  shapes: DiShape[];
  edges: DiEdge[];
}

/**
 * Re-parses layoutProcess output with a fresh moddle instance and flattens
 * every bpmndi:BPMNPlane (including nested collaboration planes) into shapes
 * and edges, so tests can assert on generated geometry without depending on
 * internal layout-engine types.
 */
export async function parseDi(xml: string): Promise<ParsedDiagram> {
  const moddle = new BpmnModdle();
  const { rootElement } = await moddle.fromXML(xml);
  const root = rootElement as any;
  const shapes: DiShape[] = [];
  const edges: DiEdge[] = [];

  for (const diagram of root.diagrams || []) {
    const plane = diagram.plane;
    for (const el of plane.planeElement || []) {
      if (el.$type === "bpmndi:BPMNShape") {
        shapes.push({
          id: el.id,
          bpmnElement: el.bpmnElement?.id,
          bounds: {
            x: el.bounds.x,
            y: el.bounds.y,
            width: el.bounds.width,
            height: el.bounds.height,
          },
          isExpanded: el.isExpanded,
        });
      } else if (el.$type === "bpmndi:BPMNEdge") {
        edges.push({
          id: el.id,
          bpmnElement: el.bpmnElement?.id,
          waypoints: (el.waypoint || []).map((p: any) => ({ x: p.x, y: p.y })),
        });
      }
    }
  }
  return { shapes, edges };
}
