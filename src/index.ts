import { LayoutEngine } from './layout-engine';
import type { AutoLayoutOptions } from './types';

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

export { BpmnModdle } from 'bpmn-moddle';
export { default as BpmnViewer } from 'bpmn-js';
export { LayoutEngine } from './layout-engine';
export { BpmnBuilder } from './bpmn-builder';
export { scoreDiagram } from './layout-metrics';
export type { AutoLayoutOptions, Bounds, Point, DiagramQualityScore } from './types';
export default layoutProcess;
