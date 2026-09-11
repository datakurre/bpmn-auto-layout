export interface NodeLayout {
  id: string;
  element: any;
  col: number;
  track: number;
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  isSubProcessChild?: boolean;
}

export interface ChannelPlan {
  channelY(flowId: string, side: "above" | "below", x1: number, x2: number): number;
}

export interface ProcessLayoutResult {
  nodes: Map<string, NodeLayout>;
  allFlows: any[];
  channels?: ChannelPlan;
  /**
   * Thin boundary-strip obstacles for pool borders, the pool caption/name
   * gutter, and lane dividers, in the same absolute coordinates as `nodes`.
   * Interiors are not obstacles -- only the strips a route must not run
   * along or through (see #11). Populated by di-creation.ts once container
   * geometry is known, before routing runs.
   */
  containerObstacles?: NodeLayout[];
}
