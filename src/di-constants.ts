import type { ElementDimension } from './types';

export const DEFAULT_DIMENSIONS: Readonly<Record<string, ElementDimension>> = {
  'bpmn:StartEvent': { width: 36, height: 36 },
  'bpmn:EndEvent': { width: 36, height: 36 },
  'bpmn:IntermediateCatchEvent': { width: 36, height: 36 },
  'bpmn:IntermediateThrowEvent': { width: 36, height: 36 },
  'bpmn:BoundaryEvent': { width: 36, height: 36 },
  'bpmn:Task': { width: 100, height: 80 },
  'bpmn:UserTask': { width: 100, height: 80 },
  'bpmn:ServiceTask': { width: 100, height: 80 },
  'bpmn:SendTask': { width: 100, height: 80 },
  'bpmn:ReceiveTask': { width: 100, height: 80 },
  'bpmn:ManualTask': { width: 100, height: 80 },
  'bpmn:BusinessRuleTask': { width: 100, height: 80 },
  'bpmn:ScriptTask': { width: 100, height: 80 },
  'bpmn:CallActivity': { width: 100, height: 80 },
  'bpmn:SubProcess': { width: 100, height: 80 },
  'bpmn:AdHocSubProcess': { width: 100, height: 80 },
  'bpmn:ExclusiveGateway': { width: 50, height: 50 },
  'bpmn:ParallelGateway': { width: 50, height: 50 },
  'bpmn:InclusiveGateway': { width: 50, height: 50 },
  'bpmn:ComplexGateway': { width: 50, height: 50 },
  'bpmn:EventBasedGateway': { width: 50, height: 50 },
  'bpmn:DataObjectReference': { width: 36, height: 50 },
  'bpmn:DataStoreReference': { width: 50, height: 50 },
  'bpmn:TextAnnotation': { width: 100, height: 30 },
};

export const DEFAULT_GRID_SPACING = 60;
export const SUBPROCESS_PADDING = 30;
export const SUBPROCESS_HEADER_HEIGHT = 35;
export const SUBPROCESS_MIN_WIDTH = 240;
export const SUBPROCESS_MIN_HEIGHT = 160;
export const LANE_MIN_HEIGHT = 120;
export const LANE_HEADER_WIDTH = 30;
export const POOL_PADDING = 20;
export const EVENT_LABEL_MARGIN = 10;
export const BOUNDARY_EVENT_LABEL_MARGIN = 0;
export const BOUNDARY_EVENT_DIAGONAL_MARGIN = -3;
export const GATEWAY_LABEL_MARGIN = 6;
export const ARTIFACT_LABEL_MARGIN = 10;
export const FLOW_LABEL_MARGIN = 10;
export const LABEL_LINE_HEIGHT = 14;
export const CANVAS_MARGIN = 20;

// Canvas & processes (src/layout-engine.ts)
export const POOL_X = 100;
export const PROCESS_START_Y = 100;
export const POOL_START_Y = 80;
export const INTER_ELEMENT_GAP_Y = 60;

// Pools
export const BLACKBOX_POOL_WIDTH = 400;
export const BLACKBOX_POOL_HEIGHT = 60;
export const PARTICIPANT_CONTENT_X = 150;
export const POOL_CONTENT_PADDING_Y = 25;
export const MIN_POOL_WIDTH = 400;
export const MIN_POOL_HEIGHT = 120;
export const POOL_WIDTH_MARGIN = 100;
export const POOL_HEIGHT_MARGIN = 50;

// Lanes. LANE_X is derived so the lane header band and pool x can't drift
// apart silently.
export const LANE_X = POOL_X + LANE_HEADER_WIDTH;
export const LANE_CONTENT_MARGIN_X = 30;
export const LANE_MIN_WIDTH = 400;

// Columns & tracks (src/graph/coordinate-assignment.ts).
// GRID_START_X_WITH_LANES (180) is close to, but not exactly, LANE_X (130) plus
// LANE_CONTENT_MARGIN_X (30) = 160: there's an extra 20px of content padding
// inside the lane that isn't named anywhere else. Keep the literal as-is rather
// than force a derivation that doesn't actually hold.
export const GRID_START_X_WITH_LANES = 180;
// A process without lanes has no pool either, but its grid still starts at the
// same x pools do. Named separately from POOL_X so a reader doesn't have to
// infer that connection from a reused pool constant.
export const GRID_START_X = POOL_X;
export const MIN_COLUMN_WIDTH = 36;
export const MIN_TRACK_HALF_HEIGHT = 40;
export const BOUNDARY_TRACK_PADDING = 20;

// Message-flow ports (src/layout-engine.ts)
export const MIN_PORT_SPACING = 30;
export const PORT_INSET = POOL_PADDING;

// Subprocess containers (src/hierarchy/subprocess-layout.ts). Derived from the
// same padding/header constants used for a child's offset inside its parent.
export const SUBPROCESS_CONTAINER_PADDING_X = 2 * SUBPROCESS_PADDING;
export const SUBPROCESS_CONTAINER_PADDING_Y = 2 * SUBPROCESS_HEADER_HEIGHT;
export const SUBPROCESS_WIDTH_BUDGET_FLOOR = 600;

export function getElementDimensions(elementType: string): ElementDimension {
  const dimension = DEFAULT_DIMENSIONS[elementType];
  if (dimension) {
    return dimension;
  }
  return { width: 100, height: 80 };
}

export function isSubProcessType(type: string | undefined): boolean {
  return type === 'bpmn:SubProcess' || type === 'bpmn:AdHocSubProcess';
}
