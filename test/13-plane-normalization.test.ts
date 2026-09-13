import { describe, it, expect } from 'vitest';
import { BpmnModdle } from 'bpmn-moddle';
import { layoutProcess } from '../src/index';
import { normalizePlaneOrigin } from '../src/plane-normalization';
import { CANVAS_MARGIN } from '../src/di-constants';

describe('Issue #79: Plane Origin Normalization', () => {
  it('translates diagram so no coordinates are negative or below CANVAS_MARGIN', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Defs" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:startEvent id="Start_1" />
    <bpmn:exclusiveGateway id="Split_1" />
    <bpmn:task id="Task_Top" name="Top" />
    <bpmn:task id="Task_Mid" name="Middle" />
    <bpmn:task id="Task_Bot" name="Bottom" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start_1" targetRef="Split_1" />
    <bpmn:sequenceFlow id="f1" sourceRef="Split_1" targetRef="Task_Top" />
    <bpmn:sequenceFlow id="f2" sourceRef="Split_1" targetRef="Task_Mid" />
    <bpmn:sequenceFlow id="f3" sourceRef="Split_1" targetRef="Task_Bot" />
  </bpmn:process>
</bpmn:definitions>`;

    const layoutedXml = await layoutProcess(xml);
    const moddle = new BpmnModdle();
    const { rootElement } = await moddle.fromXML(layoutedXml);
    const plane = (rootElement as any).diagrams[0].plane;

    for (const el of plane.planeElement) {
      if (el.bounds) {
        expect(el.bounds.x).toBeGreaterThanOrEqual(CANVAS_MARGIN);
        expect(el.bounds.y).toBeGreaterThanOrEqual(CANVAS_MARGIN);
      }
      if (el.label?.bounds) {
        expect(el.label.bounds.x).toBeGreaterThanOrEqual(CANVAS_MARGIN);
        expect(el.label.bounds.y).toBeGreaterThanOrEqual(CANVAS_MARGIN);
      }
      if (Array.isArray(el.waypoint)) {
        for (const pt of el.waypoint) {
          expect(pt.x).toBeGreaterThanOrEqual(CANVAS_MARGIN);
          expect(pt.y).toBeGreaterThanOrEqual(CANVAS_MARGIN);
        }
      }
    }
  });

  it('handles empty or coordinate-free plane gracefully', () => {
    expect(() => normalizePlaneOrigin(undefined)).not.toThrow();

    const emptyPlane: any = { planeElement: [] };
    expect(() => normalizePlaneOrigin(emptyPlane)).not.toThrow();

    const planeWithoutCoords: any = { planeElement: [{ id: 'Shape_1' }] };
    expect(() => normalizePlaneOrigin(planeWithoutCoords)).not.toThrow();
  });

  it('shifts elements horizontally when minX is below margin', () => {
    const plane: any = {
      planeElement: [
        { bounds: { x: 5, y: 100, width: 50, height: 50 } },
        {
          waypoint: [
            { x: 55, y: 125 },
            { x: 100, y: 125 },
          ],
        },
      ],
    };
    normalizePlaneOrigin(plane, 20);
    expect(plane.planeElement[0].bounds.x).toBe(20);
    expect(plane.planeElement[0].bounds.y).toBe(100);
    expect(plane.planeElement[1].waypoint[0].x).toBe(70);
  });

  it('does not shift when all elements already satisfy margin', () => {
    const plane: any = {
      planeElement: [
        { bounds: { x: 100, y: 100, width: 50, height: 50 } },
        {
          waypoint: [
            { x: 150, y: 125 },
            { x: 200, y: 125 },
          ],
        },
      ],
    };
    normalizePlaneOrigin(plane, 20);
    expect(plane.planeElement[0].bounds.x).toBe(100);
    expect(plane.planeElement[0].bounds.y).toBe(100);
    expect(plane.planeElement[1].waypoint[0].x).toBe(150);
  });
});
