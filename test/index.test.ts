import { describe, it, expect } from 'vitest';
import defaultLayoutProcess, { layoutProcess, BpmnModdle, BpmnViewer } from '../src/index';

const sampleBpmn = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:startEvent id="StartEvent_1" />
  </bpmn:process>
</bpmn:definitions>`;

describe('bpmn-auto-layout', () => {
  it('exports BpmnModdle and BpmnViewer', () => {
    expect(BpmnModdle).toBeDefined();
    expect(BpmnViewer).toBeDefined();
  });

  it('can parse and process sample BPMN XML without options', async () => {
    const result = await layoutProcess(sampleBpmn);
    expect(result).toContain('bpmn:definitions');
    expect(result).toContain('Process_1');
    expect(result).toContain('StartEvent_1');
  });

  it('supports custom moddle extensions option and default export', async () => {
    const result = await defaultLayoutProcess(sampleBpmn, {
      moddleExtensions: {},
    });
    expect(result).toContain('bpmn:definitions');
    expect(result).toContain('Process_1');
  });
});
