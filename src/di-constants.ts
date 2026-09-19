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
export const SUBPROCESS_HEADER_HEIGHT = 30;
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
