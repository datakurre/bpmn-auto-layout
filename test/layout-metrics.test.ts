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

  it('evaluates compactness metrics for diagrams and containers', async () => {
    const score = await scoreDiagram(sampleWithOverlapAndCrossings);
    expect(score.compactness).toBeDefined();
    expect(score.compactness.width).toBeGreaterThan(0);
    expect(score.compactness.height).toBeGreaterThan(0);
    expect(score.compactness.area).toBeGreaterThan(0);
    expect(score.compactness.aspectRatio).toBeGreaterThan(0);
    expect(score.compactness.densityRatio).toBeGreaterThan(0);
  });

  it('tests segmentCrossesBox with various orthogonal and diagonal segments', async () => {
    const { segmentCrossesBox: testSegmentCrossesBox, boxesOverlap: testBoxesOverlap } =
      await import('../src/layout-metrics');
    const box = { x: 100, y: 100, width: 100, height: 80 };

    // Horizontal segment intersecting
    expect(testSegmentCrossesBox({ x: 50, y: 140 }, { x: 250, y: 140 }, box)).toBe(true);
    // Horizontal segment entering and ending inside
    expect(testSegmentCrossesBox({ x: 50, y: 140 }, { x: 150, y: 140 }, box)).toBe(true);
    // Horizontal segment strictly above or below
    expect(testSegmentCrossesBox({ x: 50, y: 90 }, { x: 250, y: 90 }, box)).toBe(false);
    expect(testSegmentCrossesBox({ x: 50, y: 190 }, { x: 250, y: 190 }, box)).toBe(false);
    // Horizontal segment outside x interval
    expect(testSegmentCrossesBox({ x: 10, y: 140 }, { x: 80, y: 140 }, box)).toBe(false);

    // Vertical segment intersecting
    expect(testSegmentCrossesBox({ x: 150, y: 50 }, { x: 150, y: 250 }, box)).toBe(true);
    // Vertical segment strictly left or right
    expect(testSegmentCrossesBox({ x: 50, y: 50 }, { x: 50, y: 250 }, box)).toBe(false);
    expect(testSegmentCrossesBox({ x: 250, y: 50 }, { x: 250, y: 250 }, box)).toBe(false);
    // Vertical segment outside y interval
    expect(testSegmentCrossesBox({ x: 150, y: 10 }, { x: 150, y: 80 }, box)).toBe(false);

    // Diagonal segment intersecting
    expect(testSegmentCrossesBox({ x: 50, y: 50 }, { x: 250, y: 250 }, box)).toBe(true);
    // Diagonal segment outside
    expect(testSegmentCrossesBox({ x: 10, y: 10 }, { x: 50, y: 50 }, box)).toBe(false);

    // boxesOverlap
    expect(testBoxesOverlap(box, { x: 150, y: 120, width: 50, height: 50 })).toBe(true);
    expect(testBoxesOverlap(box, { x: 300, y: 300, width: 50, height: 50 })).toBe(false);
  });

  it('evaluates container compactness for expanded subprocess', async () => {
    const subprocessXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:subProcess id="Sub_1">
      <bpmn:task id="SubTask_1" />
    </bpmn:subProcess>
    <bpmn:subProcess id="Zero_Sub" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_1">
      <bpmndi:BPMNShape id="Sub_1_di" bpmnElement="Sub_1" isExpanded="true">
        <dc:Bounds x="100" y="100" width="300" height="200" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="SubTask_1_di" bpmnElement="SubTask_1">
        <dc:Bounds x="150" y="150" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Zero_di" bpmnElement="Zero_Sub" isExpanded="true">
        <dc:Bounds x="100" y="100" width="0" height="0" />
      </bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

    const score = await scoreDiagram(subprocessXml);
    expect(score.compactness.containers.length).toBe(2);
    const subContainer = score.compactness.containers.find((c) => c.elementId === 'Sub_1');
    expect(subContainer).toBeDefined();
    expect(subContainer?.aspectRatio).toBe(1.5);
    expect(subContainer?.densityRatio).toBeGreaterThan(0);

    const zeroContainer = score.compactness.containers.find((c) => c.elementId === 'Zero_Sub');
    expect(zeroContainer?.aspectRatio).toBe(0);
    expect(zeroContainer?.densityRatio).toBe(0);
  });

  it('handles flat diagram with zero height in compactness evaluation', async () => {
    const flatXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:task id="Task_Flat" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_1">
      <bpmndi:BPMNShape id="Task_Flat_di" bpmnElement="Task_Flat">
        <dc:Bounds x="100" y="100" width="100" height="0" />
      </bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

    const score = await scoreDiagram(flatXml);
    expect(score.compactness.height).toBe(0);
    expect(score.compactness.aspectRatio).toBe(0);
    expect(score.compactness.densityRatio).toBe(0);
  });
});
