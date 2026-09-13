import { describe, it, expect } from 'vitest';
import { layoutProcess } from '../src/index';

describe('Issue #82: Flow Container Boundary & Resolution Validation', () => {
  it('throws descriptive error when sequence flow crosses from process to subprocess', async () => {
    const invalidXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Defs" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:startEvent id="Start_1" />
    <bpmn:subProcess id="Sub_1">
      <bpmn:startEvent id="SubStart_1" />
      <bpmn:task id="SubTask_1" />
      <bpmn:sequenceFlow id="SubFlow_1" sourceRef="SubStart_1" targetRef="SubTask_1" />
    </bpmn:subProcess>
    <bpmn:sequenceFlow id="CrossFlow_1" sourceRef="Start_1" targetRef="SubTask_1" />
  </bpmn:process>
</bpmn:definitions>`;

    await expect(layoutProcess(invalidXml)).rejects.toThrow(
      /Sequence flow "CrossFlow_1" belongs to container "Process_1" but its target "SubTask_1" lives in container "Sub_1"/
    );
  });

  it('allows cross-container sequence flow when lenientFlowValidation is true', async () => {
    const invalidXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Defs" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:startEvent id="Start_1" />
    <bpmn:subProcess id="Sub_1">
      <bpmn:startEvent id="SubStart_1" />
      <bpmn:task id="SubTask_1" />
      <bpmn:sequenceFlow id="SubFlow_1" sourceRef="SubStart_1" targetRef="SubTask_1" />
    </bpmn:subProcess>
    <bpmn:sequenceFlow id="CrossFlow_1" sourceRef="Start_1" targetRef="SubTask_1" />
  </bpmn:process>
</bpmn:definitions>`;

    await expect(layoutProcess(invalidXml, { lenientFlowValidation: true })).resolves.toBeDefined();
  });

  it('throws error when sequence flow has unresolvable sourceRef', async () => {
    const missingSourceXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Defs" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:endEvent id="End_1" />
    <bpmn:sequenceFlow id="Flow_Missing" sourceRef="Ghost_Node" targetRef="End_1" />
  </bpmn:process>
</bpmn:definitions>`;

    await expect(layoutProcess(missingSourceXml)).rejects.toThrow(
      /Sequence flow "Flow_Missing" references unresolvable sourceRef/
    );
  });

  it('throws error when sequence flow has unresolvable targetRef', async () => {
    const missingTargetXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Defs" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:startEvent id="Start_1" />
    <bpmn:sequenceFlow id="Flow_Missing" sourceRef="Start_1" targetRef="Ghost_Node" />
  </bpmn:process>
</bpmn:definitions>`;

    await expect(layoutProcess(missingTargetXml)).rejects.toThrow(
      /Sequence flow "Flow_Missing" references unresolvable targetRef/
    );
  });

  it('throws error when sequence flow source lives in a different container', async () => {
    const invalidSourceXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Defs" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:endEvent id="End_1" />
    <bpmn:subProcess id="Sub_1">
      <bpmn:task id="SubTask_1" />
    </bpmn:subProcess>
    <bpmn:sequenceFlow id="CrossFlow_1" sourceRef="SubTask_1" targetRef="End_1" />
  </bpmn:process>
</bpmn:definitions>`;

    await expect(layoutProcess(invalidSourceXml)).rejects.toThrow(
      /Sequence flow "CrossFlow_1" belongs to container "Process_1" but its source "SubTask_1" lives in container "Sub_1"/
    );
  });

  it('allows unresolvable references when lenientFlowValidation is true', async () => {
    const missingRefXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Defs" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:startEvent id="Start_1" />
    <bpmn:sequenceFlow id="Flow_Missing" sourceRef="Start_1" targetRef="Ghost_Node" />
  </bpmn:process>
</bpmn:definitions>`;

    await expect(
      layoutProcess(missingRefXml, { lenientFlowValidation: true })
    ).resolves.toBeDefined();
  });

  it('collects warnings in lenient mode for unresolvable source and cross-container source', async () => {
    const { validateFlowContainers } = await import('../src/validation/bpmn-validation');
    const mockDefs: any = {
      rootElements: [
        {
          $type: 'bpmn:Collaboration',
          id: 'Collab1',
        },
        {
          $type: 'bpmn:Process',
          id: 'EmptyP',
        },
        {
          $type: 'bpmn:Process',
          id: 'P1',
          flowElements: [
            { id: 'T1', $type: 'bpmn:Task' },
            {
              id: 'Sub1',
              $type: 'bpmn:SubProcess',
              flowElements: [{ id: 'SubT1', $type: 'bpmn:Task' }],
            },
            {
              id: 'F_MissingSource',
              $type: 'bpmn:SequenceFlow',
              sourceRef: 'NonExistent',
              targetRef: 'T1',
            },
            {
              id: 'F_CrossSource',
              $type: 'bpmn:SequenceFlow',
              sourceRef: 'SubT1',
              targetRef: 'T1',
            },
          ],
        },
      ],
    };

    const warnings = validateFlowContainers(mockDefs, { lenientFlowValidation: true });
    expect(warnings.length).toBe(2);
    expect(warnings[0]).toContain('unresolvable sourceRef');
    expect(warnings[1]).toContain('source "SubT1" lives in container');

    const emptyWarnings = validateFlowContainers(undefined);
    expect(emptyWarnings).toEqual([]);
  });
});
