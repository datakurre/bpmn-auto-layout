import { describe, it, expect } from 'vitest';
import { scoreDiagram } from '../src/layout-metrics';
import { getElementDimensions } from '../src/di-constants';

const sampleWithOverlapAndCrossings = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:startEvent id="Start_1" />
    <bpmn:task id="Task_1" />
    <bpmn:task id="Task_2" />
    <bpmn:endEvent id="End_1" />
    <bpmn:sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="End_1" />
    <bpmn:sequenceFlow id="Flow_2" sourceRef="Task_1" targetRef="Task_2" />
    <bpmn:sequenceFlow id="Flow_Diagonal" sourceRef="Start_1" targetRef="Task_2" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_1">
      <bpmndi:BPMNShape id="Start_1_di" bpmnElement="Start_1">
        <dc:Bounds x="100" y="100" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Task_1_di" bpmnElement="Task_1">
        <dc:Bounds x="150" y="120" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Task_2_di" bpmnElement="Task_2">
        <dc:Bounds x="300" y="100" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="End_1_di" bpmnElement="End_1">
        <dc:Bounds x="500" y="100" width="36" height="36" />
      </bpmndi:BPMNShape>
      <!-- Flow_1 cuts horizontally through Task_2 -->
      <bpmndi:BPMNEdge id="Flow_1_di" bpmnElement="Flow_1">
        <di:waypoint x="200" y="140" />
        <di:waypoint x="500" y="140" />
      </bpmndi:BPMNEdge>
      <!-- Flow_2 is vertical crossing Flow_1 -->
      <bpmndi:BPMNEdge id="Flow_2_di" bpmnElement="Flow_2">
        <di:waypoint x="250" y="50" />
        <di:waypoint x="250" y="250" />
      </bpmndi:BPMNEdge>
      <!-- Flow_Diagonal has non-orthogonal segment -->
      <bpmndi:BPMNEdge id="Flow_Diagonal_di" bpmnElement="Flow_Diagonal">
        <di:waypoint x="100" y="100" />
        <di:waypoint x="300" y="200" />
      </bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

const emptyDiagramXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="false" />
</bpmn:definitions>`;

describe('LayoutMetrics', () => {
  it('detects shape overlaps, edge crossings, and non-orthogonal segments', async () => {
    const score = await scoreDiagram(sampleWithOverlapAndCrossings);

    expect(score.isValid).toBe(false);
    expect(score.hardViolations.shapeOverlaps).toBeGreaterThan(0);
    expect(score.hardViolations.edgeShapeCrossings).toBeGreaterThan(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBeGreaterThan(0);
    expect(score.metrics.edgeCrossings).toBeGreaterThan(0);
    expect(score.metrics.totalBends).toBe(0);
  });

  it('handles empty diagram gracefully', async () => {
    const score = await scoreDiagram(emptyDiagramXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.metrics.totalEdgeLength).toBe(0);
  });

  it('returns default dimension for unknown element type', () => {
    const dim = getElementDimensions('bpmn:UnknownCustomType');
    expect(dim).toEqual({ width: 100, height: 80 });
  });
});
