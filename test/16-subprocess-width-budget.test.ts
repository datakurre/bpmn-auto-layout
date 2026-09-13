import { describe, it, expect } from 'vitest';
import { BpmnModdle } from 'bpmn-moddle';
import { layoutProcess } from '../src/index';
import { scoreDiagram } from '../src/layout-metrics';
import { routeOrthogonalEdge } from '../src/graph/orthogonal-router';
import type { Bounds } from '../src/types';

describe('Issue #80: Subprocess Width Budget & Multi-Row Wrap', () => {
  const longSubprocessXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" id="Defs_Wrap" targetNamespace="https://example.com/bpmn">
  <bpmn:process id="Process_Wrap" isExecutable="false">
    <bpmn:startEvent id="Start_1" />
    <bpmn:subProcess id="SubProcess_1" name="Long Chain">
      <bpmn:startEvent id="Sub_Start" />
      <bpmn:task id="Task_1" />
      <bpmn:task id="Task_2" />
      <bpmn:task id="Task_3" />
      <bpmn:task id="Task_4" />
      <bpmn:task id="Task_5" />
      <bpmn:task id="Task_6" />
      <bpmn:task id="Task_7" />
      <bpmn:task id="Task_8" />
      <bpmn:task id="Task_9" />
      <bpmn:task id="Task_10" />
      <bpmn:task id="Task_11" />
      <bpmn:task id="Task_12" />
      <bpmn:task id="Task_13" />
      <bpmn:task id="Task_14" />
      <bpmn:endEvent id="Sub_End" />
      <bpmn:sequenceFlow id="SF_0" sourceRef="Sub_Start" targetRef="Task_1" />
      <bpmn:sequenceFlow id="SF_1" sourceRef="Task_1" targetRef="Task_2" />
      <bpmn:sequenceFlow id="SF_2" sourceRef="Task_2" targetRef="Task_3" />
      <bpmn:sequenceFlow id="SF_3" sourceRef="Task_3" targetRef="Task_4" />
      <bpmn:sequenceFlow id="SF_4" sourceRef="Task_4" targetRef="Task_5" />
      <bpmn:sequenceFlow id="SF_5" sourceRef="Task_5" targetRef="Task_6" />
      <bpmn:sequenceFlow id="SF_6" sourceRef="Task_6" targetRef="Task_7" />
      <bpmn:sequenceFlow id="SF_7" sourceRef="Task_7" targetRef="Task_8" />
      <bpmn:sequenceFlow id="SF_8" sourceRef="Task_8" targetRef="Task_9" />
      <bpmn:sequenceFlow id="SF_9" sourceRef="Task_9" targetRef="Task_10" />
      <bpmn:sequenceFlow id="SF_10" sourceRef="Task_10" targetRef="Task_11" />
      <bpmn:sequenceFlow id="SF_11" sourceRef="Task_11" targetRef="Task_12" />
      <bpmn:sequenceFlow id="SF_12" sourceRef="Task_12" targetRef="Task_13" />
      <bpmn:sequenceFlow id="SF_13" sourceRef="Task_13" targetRef="Task_14" />
      <bpmn:sequenceFlow id="SF_14" sourceRef="Task_14" targetRef="Sub_End" />
    </bpmn:subProcess>
    <bpmn:endEvent id="End_1" />
    <bpmn:sequenceFlow id="F_In" sourceRef="Start_1" targetRef="SubProcess_1" />
    <bpmn:sequenceFlow id="F_Out" sourceRef="SubProcess_1" targetRef="End_1" />
  </bpmn:process>
</bpmn:definitions>`;

  it('wraps a long linear chain inside a subprocess to avoid extreme aspect ratios', async () => {
    const layoutedXml = await layoutProcess(longSubprocessXml);
    const score = await scoreDiagram(layoutedXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);

    const moddle = new BpmnModdle();
    const { rootElement } = await moddle.fromXML(layoutedXml);
    const plane = (rootElement as any).diagrams[0].plane;

    const subShape = plane.planeElement.find((el: any) => el.bpmnElement?.id === 'SubProcess_1');
    expect(subShape).toBeDefined();

    const subWidth = subShape.bounds.width;
    const subHeight = subShape.bounds.height;
    const ratio = subWidth / subHeight;

    // Without wrapping, the ratio would be ~15:1. With wrapping, it drops to <= 3:1.
    expect(ratio).toBeLessThanOrEqual(3.0);
    expect(subHeight).toBeGreaterThan(200);

    // All child tasks and events must remain strictly inside the container
    const childIds = [
      'Sub_Start',
      'Sub_End',
      ...Array.from({ length: 14 }, (_, i) => `Task_${i + 1}`),
    ];
    for (const childId of childIds) {
      const childShape = plane.planeElement.find((el: any) => el.bpmnElement?.id === childId);
      expect(childShape).toBeDefined();
      const cb = childShape.bounds;
      expect(cb.x).toBeGreaterThanOrEqual(subShape.bounds.x);
      expect(cb.y).toBeGreaterThanOrEqual(subShape.bounds.y);
      expect(cb.x + cb.width).toBeLessThanOrEqual(subShape.bounds.x + subShape.bounds.width);
      expect(cb.y + cb.height).toBeLessThanOrEqual(subShape.bounds.y + subShape.bounds.height);
    }
  });

  it('respects an explicit widthBudget option passed directly to layoutProcess', async () => {
    const simpleLinearXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Defs_Linear" targetNamespace="https://example.com/bpmn">
  <bpmn:process id="Proc_Linear" isExecutable="false">
    <bpmn:startEvent id="S1" />
    <bpmn:task id="T1" />
    <bpmn:task id="T2" />
    <bpmn:task id="T3" />
    <bpmn:task id="T4" />
    <bpmn:endEvent id="E1" />
    <bpmn:sequenceFlow id="F1" sourceRef="S1" targetRef="T1" />
    <bpmn:sequenceFlow id="F2" sourceRef="T1" targetRef="T2" />
    <bpmn:sequenceFlow id="F3" sourceRef="T2" targetRef="T3" />
    <bpmn:sequenceFlow id="F4" sourceRef="T3" targetRef="T4" />
    <bpmn:sequenceFlow id="F5" sourceRef="T4" targetRef="E1" />
  </bpmn:process>
</bpmn:definitions>`;

    const layoutedXml = await layoutProcess(simpleLinearXml, { widthBudget: 350 });
    const score = await scoreDiagram(layoutedXml);
    expect(score.isValid).toBe(true);

    const moddle = new BpmnModdle();
    const { rootElement } = await moddle.fromXML(layoutedXml);
    const plane = (rootElement as any).diagrams[0].plane;

    const findShape = (id: string) =>
      plane.planeElement.find((el: any) => el.bpmnElement?.id === id);
    const t1 = findShape('T1');
    const t4 = findShape('T4');

    // T4 should be wrapped onto a lower row (larger Y)
    expect(t4.bounds.y).toBeGreaterThan(t1.bounds.y);
  });

  it('routes forward wrapped row edges cleanly with 4 orthogonal bends', () => {
    const src: Bounds = { x: 500, y: 100, width: 100, height: 80 };
    const tgt: Bounds = { x: 100, y: 340, width: 100, height: 80 };

    const waypoints = routeOrthogonalEdge(src, tgt);
    expect(waypoints).toHaveLength(6);

    // Bends = waypoints.length - 2 = 4
    expect(waypoints[0]).toEqual({ x: 600, y: 140 }); // src exit right
    expect(waypoints[1]).toEqual({ x: 620, y: 140 }); // step right
    expect(waypoints[2]).toEqual({ x: 620, y: 260 }); // down to mid channel
    expect(waypoints[3]).toEqual({ x: 80, y: 260 }); // left past target
    expect(waypoints[4]).toEqual({ x: 80, y: 380 }); // down to target Y
    expect(waypoints[5]).toEqual({ x: 100, y: 380 }); // right into target entry
  });
});
