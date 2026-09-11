/**
 * Element size constants and default layout options.
 *
 * All pixel values here are the canonical sizes used throughout the engine.
 * Change a value here and it propagates everywhere automatically.
 */

export interface AutoLayoutOptions {
  colWidth?: number;
  gridSize?: number;
  spineY?: number;
  trackGap?: number;
  routing?: Partial<import("./layout-policy").RoutingPolicy>;
}

export interface ResolvedLayoutOptions {
  colWidth: number;
  gridSize: number;
  spineY: number;
  trackGap: number;
  routing: Partial<import("./layout-policy").RoutingPolicy>;
}

export const DEFAULT_OPTIONS: ResolvedLayoutOptions = {
  colWidth: 120,
  gridSize: 10,
  spineY: 70,
  trackGap: 140,
  routing: {},
};

export interface ElementDimensions {
  width: number;
  height: number;
}

export function getElementDimensions(element: any): ElementDimensions {
  const type: string = element.$type || "";
  if (type.endsWith("Event")) return { width: 36, height: 36 };
  if (type.endsWith("Gateway")) return { width: 50, height: 50 };
  if (type === "bpmn:SubProcess") return { width: 360, height: 200 };
  return { width: 100, height: 80 };
}

/** Gap between the right edge of one node and the left edge of the next. */
export const DEFAULT_FLOW_GAP = 50;

/** Gap between disconnected top-level connected components. */
export const COMPONENT_GAP = 100;

/** Landscape A4 aspect ratio (297/210) used to score component packing. */
export const LANDSCAPE_A4_RATIO = 297 / 210;

/** Clearance below/above the node band before channel lanes begin. */
export const CHANNEL_CLEARANCE = 30;

/** Distance between adjacent channel lanes. */
export const CHANNEL_LANE_GAP = 30;

/** Minimum distance a polyline must travel from its attach point before turning. */
export const ROUTE_DEPARTURE_GAP = 40;

/** Bend penalty used in the visibility-graph Dijkstra to prefer fewer turns. */
export const ROUTE_BEND_PENALTY = 10_000;

/**
 * How far an edge label's center may slide past the ends of its own
 * segment. Was 45 -- more than the length of the shortest eligible segment
 * (30 px) -- letting a label's center land entirely outside the segment
 * it's supposedly "on" (see #16). Sharply reduced so §2's "center of a
 * sufficiently long segment" is actually enforced.
 */
export const LABEL_SLIDE_SLACK = 15;
