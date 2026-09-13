import { LayoutEngine } from './layout-engine';
import type { AutoLayoutOptions, LayoutWarning } from './types';

/**
 * Layout BPMN 2.0 XML diagram.
 *
 * @param xml BPMN 2.0 XML string
 * @param options Layout options
 * @returns Promise resolving to the layouted BPMN 2.0 XML string
 */
export async function layoutProcess(xml: string, options?: AutoLayoutOptions): Promise<string> {
  const engine = new LayoutEngine(options);
  return engine.layout(xml);
}

/**
 * Layout BPMN 2.0 XML diagram and collect structured layout diagnostics/warnings.
 *
 * @param xml BPMN 2.0 XML string
 * @param options Layout options
 * @returns Promise resolving to { xml, warnings }
 */
export async function layoutProcessWithDiagnostics(
  xml: string,
  options?: AutoLayoutOptions
): Promise<{ xml: string; warnings: LayoutWarning[] }> {
  const engine = new LayoutEngine(options);
  return engine.layoutWithDiagnostics(xml);
}

export { BpmnModdle } from 'bpmn-moddle';
export { default as BpmnViewer } from 'bpmn-js';
export { LayoutEngine } from './layout-engine';
export { BpmnBuilder } from './bpmn-builder';
export { scoreDiagram, segmentCrossesBox, boxesOverlap } from './layout-metrics';
export type {
  AutoLayoutOptions,
  Bounds,
  Point,
  DiagramQualityScore,
  HardViolations,
  QualityMetrics,
  CompactnessMetrics,
  ContainerCompactness,
  LayoutWarning,
  LayoutWarningCode,
} from './types';
export default layoutProcess;
