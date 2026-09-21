import { describe, it, expect } from 'vitest';
import { layoutProcessWithDiagnostics } from '../src/index';
import { addWarning, collectPlaneDiagnostics, type LayoutWarning } from '../src/layout-warnings';

describe('Issue #83: Layout Diagnostics & Warnings', () => {
  it('returns clean layout and empty warnings for valid process', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Defs_Clean" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:startEvent id="Start_1" />
    <bpmn:task id="Task_1" />
    <bpmn:endEvent id="End_1" />
    <bpmn:sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_1" />
    <bpmn:sequenceFlow id="Flow_2" sourceRef="Task_1" targetRef="End_1" />
  </bpmn:process>
</bpmn:definitions>`;

    const result = await layoutProcessWithDiagnostics(xml);
    expect(result.xml).toContain('bpmndi:BPMNDiagram');
    expect(result.warnings).toEqual([]);
  });

  it('handles diagram with no target elements gracefully', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Defs_Empty" targetNamespace="http://bpmn.io/schema/bpmn">
</bpmn:definitions>`;

    const result = await layoutProcessWithDiagnostics(xml);
    expect(result.xml).toBeDefined();
    expect(result.warnings).toEqual([]);
  });

  it('collects warnings when lenientFlowValidation allows invalid flows', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Defs_Lenient" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:startEvent id="Start_1" />
    <bpmn:subProcess id="Sub_1">
      <bpmn:task id="SubTask_1" />
    </bpmn:subProcess>
    <bpmn:sequenceFlow id="CrossFlow_1" sourceRef="Start_1" targetRef="SubTask_1" />
    <bpmn:sequenceFlow id="GhostFlow_1" sourceRef="Start_1" targetRef="NonExistent" />
  </bpmn:process>
</bpmn:definitions>`;

    const result = await layoutProcessWithDiagnostics(xml, { lenientFlowValidation: true });
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);

    const crossWarning = result.warnings.find((w) => w.code === 'CROSS_CONTAINER_FLOW');
    expect(crossWarning).toBeDefined();
    expect(crossWarning?.elementId).toBe('CrossFlow_1');

    const ghostWarning = result.warnings.find((w) => w.code === 'UNRESOLVED_SEQUENCE_FLOW');
    expect(ghostWarning).toBeDefined();
    expect(ghostWarning?.elementId).toBe('GhostFlow_1');
  });

  it('collects shape overlap diagnostics', () => {
    const warnings: LayoutWarning[] = [];
    const mockPlane = {
      planeElement: [
        {
          $type: 'bpmndi:BPMNShape',
          bpmnElement: { id: 'Task_A', $type: 'bpmn:Task' },
          bounds: { x: 100, y: 100, width: 100, height: 80 },
        },
        {
          $type: 'bpmndi:BPMNShape',
          bpmnElement: { id: 'Task_B', $type: 'bpmn:Task' },
          bounds: { x: 150, y: 120, width: 100, height: 80 },
        },
        {
          $type: 'bpmndi:BPMNShape',
          bpmnElement: {
            id: 'Boundary_1',
            $type: 'bpmn:BoundaryEvent',
            attachedToRef: { id: 'Task_A' },
          },
          bounds: { x: 130, y: 160, width: 36, height: 36 },
        },
      ],
    };

    collectPlaneDiagnostics(mockPlane, warnings);
    expect(
      warnings.some((w) => w.code === 'SHAPE_OVERLAPS_SHAPE' && w.elementId === 'Task_A')
    ).toBe(true);
    // Boundary event attached to Task_A should not be reported as overlapping Task_A
    expect(warnings.some((w) => w.elementId === 'Boundary_1')).toBe(false);
  });

  it('collects container overflow diagnostics', () => {
    const warnings: LayoutWarning[] = [];
    const mockPlane = {
      planeElement: [
        {
          $type: 'bpmndi:BPMNShape',
          isExpanded: true,
          bpmnElement: {
            id: 'Sub_1',
            $type: 'bpmn:SubProcess',
            flowElements: [{ id: 'Child_Task_1' }, { id: 'Child_No_Bounds' }],
          },
          bounds: { x: 100, y: 100, width: 200, height: 200 },
        },
        {
          $type: 'bpmndi:BPMNShape',
          bpmnElement: { id: 'Child_Task_1', $type: 'bpmn:Task' },
          // Escapes the subprocess bounds: x + width = 350 > 300
          bounds: { x: 250, y: 150, width: 100, height: 80 },
        },
      ],
    };

    collectPlaneDiagnostics(mockPlane, warnings);
    const overflow = warnings.find((w) => w.code === 'CONTAINER_OVERFLOW');
    expect(overflow).toBeDefined();
    expect(overflow?.elementId).toBe('Sub_1');
    expect(overflow?.message).toContain('Child_Task_1');
  });

  it('collects non-orthogonal sequence flow and obstacle crossing diagnostics', () => {
    const warnings: LayoutWarning[] = [];
    const mockPlane = {
      planeElement: [
        {
          $type: 'bpmndi:BPMNShape',
          bpmnElement: { id: 'Task_Obstacle', $type: 'bpmn:Task' },
          bounds: { x: 200, y: 100, width: 100, height: 80 },
        },
        {
          $type: 'bpmndi:BPMNShape',
          bpmnElement: { id: 'Start_1', $type: 'bpmn:StartEvent' },
          bounds: { x: 50, y: 120, width: 36, height: 36 },
        },
        {
          $type: 'bpmndi:BPMNShape',
          bpmnElement: { id: 'End_1', $type: 'bpmn:EndEvent' },
          bounds: { x: 400, y: 120, width: 36, height: 36 },
        },
        {
          $type: 'bpmndi:BPMNEdge',
          bpmnElement: {
            id: 'Flow_Crossing',
            $type: 'bpmn:SequenceFlow',
            sourceRef: { id: 'Start_1' },
            targetRef: { id: 'End_1' },
          },
          // Passes right through Task_Obstacle at y=140
          waypoint: [
            { x: 86, y: 140 },
            { x: 400, y: 140 },
          ],
        },
        {
          $type: 'bpmndi:BPMNEdge',
          bpmnElement: {
            id: 'Flow_Diagonal',
            $type: 'bpmn:SequenceFlow',
            sourceRef: { id: 'Start_1' },
            targetRef: { id: 'End_1' },
          },
          waypoint: [
            { x: 50, y: 50 },
            { x: 150, y: 250 },
          ],
        },
        {
          $type: 'bpmndi:BPMNEdge',
          bpmnElement: {
            id: 'Assoc_Diagonal',
            $type: 'bpmn:Association',
          },
          waypoint: [
            { x: 10, y: 10 },
            { x: 90, y: 90 },
          ],
        },
      ],
    };

    collectPlaneDiagnostics(mockPlane, warnings);
    expect(
      warnings.some(
        (w) => w.code === 'ROUTE_INTERSECTS_OBSTACLE' && w.elementId === 'Flow_Crossing'
      )
    ).toBe(true);
    expect(
      warnings.some((w) => w.code === 'ROUTE_NOT_ORTHOGONAL' && w.elementId === 'Flow_Diagonal')
    ).toBe(true);
    // Association should not trigger ROUTE_NOT_ORTHOGONAL
    expect(warnings.some((w) => w.elementId === 'Assoc_Diagonal')).toBe(false);
  });

  it('handles addWarning with undefined warnings array and empty planes safely', () => {
    expect(() => {
      addWarning(undefined, { code: 'CONTAINER_OVERFLOW', message: 'test' });
    }).not.toThrow();

    const emptyWarnings: LayoutWarning[] = [];
    collectPlaneDiagnostics(undefined, emptyWarnings);
    collectPlaneDiagnostics({ planeElement: null }, emptyWarnings);
    collectPlaneDiagnostics({ planeElement: [{ $type: 'unknown' }] }, emptyWarnings);
    expect(emptyWarnings).toEqual([]);
  });

  it('collects DETACHED_BOUNDARY_EVENT when boundary event is detached or missing host', () => {
    const warnings: LayoutWarning[] = [];
    const mockPlane = {
      planeElement: [
        {
          $type: 'bpmndi:BPMNShape',
          bpmnElement: { id: 'Task_1', $type: 'bpmn:Task' },
          bounds: { x: 100, y: 100, width: 100, height: 80 },
        },
        {
          $type: 'bpmndi:BPMNShape',
          bpmnElement: { id: 'BE_NoHostRef', $type: 'bpmn:BoundaryEvent' },
          bounds: { x: 132, y: 162, width: 36, height: 36 },
        },
        {
          $type: 'bpmndi:BPMNShape',
          bpmnElement: {
            id: 'BE_MissingHost',
            $type: 'bpmn:BoundaryEvent',
            attachedToRef: 'Task_NonExistent',
          },
          bounds: { x: 132, y: 162, width: 36, height: 36 },
        },
        {
          $type: 'bpmndi:BPMNShape',
          bpmnElement: { id: 'BE_Detached', $type: 'bpmn:BoundaryEvent', attachedToRef: 'Task_1' },
          bounds: { x: 300, y: 300, width: 36, height: 36 },
        },
        {
          $type: 'bpmndi:BPMNShape',
          bpmnElement: { id: 'BE_Attached', $type: 'bpmn:BoundaryEvent', attachedToRef: 'Task_1' },
          bounds: { x: 132, y: 162, width: 36, height: 36 },
        },
      ],
    };

    collectPlaneDiagnostics(mockPlane, warnings);
    expect(
      warnings.some((w) => w.code === 'DETACHED_BOUNDARY_EVENT' && w.elementId === 'BE_NoHostRef')
    ).toBe(true);
    expect(
      warnings.some((w) => w.code === 'DETACHED_BOUNDARY_EVENT' && w.elementId === 'BE_MissingHost')
    ).toBe(true);
    expect(
      warnings.some((w) => w.code === 'DETACHED_BOUNDARY_EVENT' && w.elementId === 'BE_Detached')
    ).toBe(true);
    expect(warnings.some((w) => w.elementId === 'BE_Attached')).toBe(false);
  });
});
