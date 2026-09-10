/**
 * Custom Planar BPMN Auto-Layout Engine — public entry point.
 *
 * Principles:
 * - Primary horizontal spine centered at Y=70.
 * - Modular 120px semantic column grid: col 0 at centerX=75, col 1 at 195, …
 * - Final node centers and safe route bends quantized to the 10px diagram-js grid.
 * - Multi-track vertical lanes (Track 0 at Y=70, Track 1 at Y=180, Track 2 at Y=430).
 * - Planar, zero-crossing orthogonal routing with dedicated return/bypass channels.
 * - Full support for expanded SubProcesses and their internal elements.
 * - Automatic generation of BPMNLabel bounds for all named events and gateways.
 *
 * Algorithm modules:
 *   element-dimensions  — sizes, constants, and AutoLayoutOptions
 *   graph-analysis      — structural validation (cross-process flow guard)
 *   node-placement      — spine detection, track/column assignment, packing
 *   channel-planning    — 2-pass channel lane assignment
 *   edge-routing        — 7-case orthogonal waypoint computation
 *   collision-repair    — visibility-graph re-route and segment nudging
 *   label-placement     — candidate-enumeration label placement
 *   di-creation         — bpmndi BPMNShape / BPMNEdge serialization
 */
import { BpmnModdle } from "bpmn-moddle";
import { assertNoCrossProcessFlows } from "./graph-analysis";
import { computeProcessLayout } from "./node-placement";
import { createProcessDi, createCollaborationDi, getCollaborationProcessIds } from "./di-creation";
import { DEFAULT_OPTIONS, type AutoLayoutOptions, type ResolvedLayoutOptions } from "./element-dimensions";

export type { AutoLayoutOptions };

export async function layoutProcess(xml: string, options: AutoLayoutOptions = {}): Promise<string> {
  const opts: ResolvedLayoutOptions = { ...DEFAULT_OPTIONS, ...options };
  const moddle = new BpmnModdle();
  const { rootElement } = await moddle.fromXML(xml);
  const root = rootElement as any;

  const processes = (root.rootElements || []).filter((el: any) => el.$type === "bpmn:Process");
  if (processes.length === 0) return xml;

  assertNoCrossProcessFlows(processes);

  // Clear existing diagrams — all DI is regenerated from scratch
  root.diagrams = [];

  // Determine which processes belong to a collaboration pool.
  // Those processes' shapes will be emitted inside the collaboration diagram
  // plane rather than in separate per-process diagrams.
  const collaborationProcessIds = getCollaborationProcessIds(root);

  const layouts = new Map();
  for (const process of processes) {
    const layout = computeProcessLayout(process, opts);
    layouts.set(process.id, layout);
    // Only create a standalone process diagram for processes that are NOT
    // part of a collaboration (pool/participant).
    if (!collaborationProcessIds.has(process.id)) {
      createProcessDi(moddle, root, process, layout, opts);
    }
  }
  createCollaborationDi(moddle, root, layouts, opts);

  const { xml: outputXml } = await moddle.toXML(rootElement, { format: true });
  return outputXml;
}
