/**
 * Element size constants and default layout options.
 *
 * All pixel values here are the canonical sizes used throughout the engine.
 * Change a value here and it propagates everywhere automatically.
 */

export interface AutoLayoutOptions {
  colWidth?: number;
  spineY?: number;
  track1Y?: number;
  track2Y?: number;
  trackGap?: number;
  channel1Y?: number;
  channel2Y?: number;
  channel3Y?: number;
  routing?: Partial<import("./layout-policy").RoutingPolicy>;
}

export interface ResolvedLayoutOptions {
  colWidth: number;
  spineY: number;
  track1Y: number;
  track2Y: number;
  trackGap: number;
  channel1Y: number;
  channel2Y: number;
  channel3Y: number;
  routing: Partial<import("./layout-policy").RoutingPolicy>;
}

export const DEFAULT_OPTIONS: ResolvedLayoutOptions = {
  colWidth: 120,
  spineY: 70,
  track1Y: 180,
  track2Y: 430,
  trackGap: 140,
  channel1Y: 140,
  channel2Y: 280,
  channel3Y: 560,
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

/** How far an edge label may slide past the ends of its own segment. */
export const LABEL_SLIDE_SLACK = 45;
