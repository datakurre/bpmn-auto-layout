/**
 * Structured diagnostics for constraints the engine could not fully satisfy.
 *
 * Decision (#32): the engine shall always produce a renderable diagram. When
 * a constraint cannot be satisfied it degrades to the best available
 * geometry and reports what it could not achieve, rather than throwing or
 * degrading silently. This module is the shared vocabulary for that -- a
 * warning code, the element/flow it concerns, and a human-readable message.
 */

import { LAYOUT_PRIORITY_LEVELS } from "./layout-policy";

export type LayoutWarningCode =
  /** A sequence flow's final route still overlaps a node, container, or another route after every repair attempt. */
  | "ROUTE_INTERSECTS_OBSTACLE"
  /** No valid connection-point pair could be found for a flow even after every fallback; an unvalidated route was emitted so the diagram still renders. */
  | "ROUTE_INVALID_CONNECTION_POINTS"
  /** A sequence flow's final route has a non-axis-aligned segment. */
  | "ROUTE_NOT_ORTHOGONAL"
  /** Two node shapes overlap in the finished layout. */
  | "SHAPE_OVERLAPS_SHAPE"
  /** A label's final position still overlaps a shape, another label, or a routed edge. */
  | "LABEL_OVERLAPS_ELEMENT"
  /** A label could not be placed inside its owning pool/lane/subprocess and was placed outside it instead. */
  | "LABEL_ESCAPES_CONTAINER";

/**
 * Maps each warning code to the §8 priority level (LAYOUT_PRIORITY_LEVELS
 * in layout-policy.ts) it is evidence against, so a warning carries not just
 * what went wrong but how important the requirement it violates is (#42).
 * Mirrors tools/bpmn_feedback.py's METRIC_PRIORITY_LEVEL for the same
 * reason: the external checker sorts failures by priority, and diagnostics
 * produced inside the engine itself should speak the same vocabulary rather
 * than leaving LAYOUT_PRIORITY_LEVELS with no call site of its own.
 */
const WARNING_PRIORITY_LEVEL: Record<LayoutWarningCode, number> = {
  ROUTE_INVALID_CONNECTION_POINTS: 1,
  LABEL_ESCAPES_CONTAINER: 1,
  SHAPE_OVERLAPS_SHAPE: 2,
  ROUTE_INTERSECTS_OBSTACLE: 2,
  LABEL_OVERLAPS_ELEMENT: 2,
  ROUTE_NOT_ORTHOGONAL: 3,
};

// Fail fast if a code above is ever mapped to a level that doesn't exist in
// the shared ladder, instead of silently carrying a meaningless number.
for (const [code, level] of Object.entries(WARNING_PRIORITY_LEVEL)) {
  if (!LAYOUT_PRIORITY_LEVELS.some((entry) => entry.level === level)) {
    throw new Error(`layout-warnings: ${code} maps to unknown priority level ${level}`);
  }
}

export interface LayoutWarning {
  code: LayoutWarningCode;
  /** The BPMN element or flow id the warning concerns, when there is one specific owner. */
  elementId?: string;
  message: string;
  /** The §8 priority level (see LAYOUT_PRIORITY_LEVELS) this warning is evidence against. */
  priorityLevel: number;
}

/** Small helper so call sites read as one line instead of an inline object literal. */
export function warn(
  warnings: LayoutWarning[] | undefined,
  code: LayoutWarningCode,
  elementId: string | undefined,
  message: string,
): void {
  warnings?.push({ code, elementId, message, priorityLevel: WARNING_PRIORITY_LEVEL[code] });
}
