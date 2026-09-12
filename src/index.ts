import { BpmnModdle } from 'bpmn-moddle';

export interface AutoLayoutOptions {
  /**
   * Additional Moddle extensions to register
   */
  moddleExtensions?: Record<string, any>;
}

/**
 * Layout BPMN 2.0 XML diagram.
 *
 * @param xml BPMN 2.0 XML string
 * @param options Layout options
 * @returns Promise resolving to the layouted BPMN 2.0 XML string
 */
export async function layoutProcess(xml: string, options?: AutoLayoutOptions): Promise<string> {
  const moddle = new BpmnModdle(options?.moddleExtensions);
  const { rootElement } = await moddle.fromXML(xml);

  const { xml: outputXml } = await moddle.toXML(rootElement, { format: true });
  return outputXml;
}

export { BpmnModdle } from 'bpmn-moddle';
export { default as BpmnViewer } from 'bpmn-js';
export default layoutProcess;
