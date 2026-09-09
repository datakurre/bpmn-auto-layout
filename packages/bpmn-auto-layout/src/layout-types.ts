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
}
