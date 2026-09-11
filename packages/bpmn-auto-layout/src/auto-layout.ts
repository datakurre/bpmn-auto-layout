/**
 * Custom Planar BPMN Auto-Layout Engine — public entry point.
 *
 * Principles:
 * - Primary horizontal spine centered at Y=70.
 * - Modular 120px semantic column grid: col 0 at centerX=75, col 1 at 195, …
 * - Final node centers and safe route bends quantized to the 10px diagram-js grid.
 * - Multi-track vertical lanes on a single rhythm: track t sits at
 *   spineY + t * trackGap, both above and below the spine (track 0).
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
 *   process-routing     — full per-process routing pipeline as a pure
 *                         function of (layout, opts), independent of DI
 *   label-placement     — candidate-enumeration label placement
 *   di-creation         — bpmndi BPMNShape / BPMNEdge serialization
 */
import { BpmnModdle } from "bpmn-moddle";
import { assertNoCrossProcessFlows } from "./graph-analysis";
import { computeProcessLayout } from "./node-placement";
import { createProcessDi, createCollaborationDi, getCollaborationProcessIds } from "./di-creation";
import { DEFAULT_OPTIONS, type AutoLayoutOptions, type ResolvedLayoutOptions } from "./element-dimensions";
import type { LayoutWarning } from "./layout-warnings";
import { comparePriorityViolations } from "./layout-policy";

export type { AutoLayoutOptions };
export type { LayoutWarning, LayoutWarningCode } from "./layout-warnings";

export interface LayoutResult {
  xml: string;
  /**
   * Constraints the engine could not fully satisfy, degrading to the best
   * available geometry instead (#32's decision: the engine always produces
   * a renderable diagram). Empty when nothing was compromised.
   */
  warnings: LayoutWarning[];
}

async function runLayout(xml: string, options: AutoLayoutOptions, warnings?: LayoutWarning[]): Promise<string> {
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
      createProcessDi(moddle, root, process, layout, opts, warnings);
    }
  }
  createCollaborationDi(moddle, root, layouts, opts, warnings);

  const { xml: outputXml } = await moddle.toXML(rootElement, { format: true });
  return outputXml;
}

export async function layoutProcess(xml: string, options: AutoLayoutOptions = {}): Promise<string> {
  return runLayout(xml, options);
}

/**
 * Same layout as layoutProcess, but also returns the structured warnings for
 * any constraint the engine could not fully satisfy (see LayoutResult).
 * layoutProcess itself keeps its existing string-returning signature and
 * discards these; use this companion when the caller wants to know what, if
 * anything, was compromised (#32).
 */
export async function layoutProcessWithDiagnostics(
  xml: string,
  options: AutoLayoutOptions = {},
): Promise<LayoutResult> {
  const warnings: LayoutWarning[] = [];
  const outputXml = await runLayout(xml, options, warnings);
  // §8's priority ladder (LAYOUT_PRIORITY_LEVELS / comparePriorityViolations
  // in layout-policy.ts) previously had no call site outside its own tests
  // (#42): warnings were reported in discovery order, so a low-priority
  // spacing warning could sit ahead of a high-priority overlap in the list a
  // caller reads first. Order by the same comparator the ladder defines, so
  // a caller who only looks at warnings[0] sees the most important
  // unsatisfied constraint, not just the first one the engine happened to
  // notice.
  const sortedWarnings = [...warnings].sort((a, b) =>
    comparePriorityViolations(new Set([a.priorityLevel]), new Set([b.priorityLevel])),
  );
  return { xml: outputXml, warnings: sortedWarnings };
}
