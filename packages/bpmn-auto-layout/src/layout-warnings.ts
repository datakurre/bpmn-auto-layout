/**
 * Structured diagnostics for constraints the engine could not fully satisfy.
 *
 * Decision (#32): the engine shall always produce a renderable diagram. When
 * a constraint cannot be satisfied it degrades to the best available
 * geometry and reports what it could not achieve, rather than throwing or
 * degrading silently. This module is the shared vocabulary for that -- a
 * warning code, the element/flow it concerns, and a human-readable message.
 */

export type LayoutWarningCode =
  /** A sequence flow's final route still overlaps a node, container, or another route after every repair attempt. */
  | "ROUTE_INTERSECTS_OBSTACLE"
  /** No valid connection-point pair could be found for a flow even after every fallback; an unvalidated route was emitted so the diagram still renders. */
  | "ROUTE_INVALID_CONNECTION_POINTS"
  /** A label's final position still overlaps a shape, another label, or a routed edge. */
  | "LABEL_OVERLAPS_ELEMENT"
  /** A label could not be placed inside its owning pool/lane/subprocess and was placed outside it instead. */
  | "LABEL_ESCAPES_CONTAINER";

export interface LayoutWarning {
  code: LayoutWarningCode;
  /** The BPMN element or flow id the warning concerns, when there is one specific owner. */
  elementId?: string;
  message: string;
}

/** Small helper so call sites read as one line instead of an inline object literal. */
export function warn(warnings: LayoutWarning[] | undefined, code: LayoutWarningCode, elementId: string | undefined, message: string): void {
  warnings?.push({ code, elementId, message });
}
