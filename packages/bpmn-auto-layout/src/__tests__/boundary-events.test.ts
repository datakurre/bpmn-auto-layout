import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutProcess } from "../auto-layout";
import { parseDi } from "./test-helpers";

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Definitions_1" targetNamespace="http://example.com">
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:startEvent id="Start_1" name="Start" />
    <bpmn:task id="Task_1" name="Process request" />
    <bpmn:boundaryEvent id="Boundary_A" name="Timeout A" attachedToRef="Task_1">
      <bpmn:timerEventDefinition />
    </bpmn:boundaryEvent>
    <bpmn:boundaryEvent id="Boundary_B" name="Timeout B" attachedToRef="Task_1">
      <bpmn:timerEventDefinition />
    </bpmn:boundaryEvent>
    <bpmn:boundaryEvent id="Boundary_C" name="Timeout C" attachedToRef="Task_1">
      <bpmn:timerEventDefinition />
    </bpmn:boundaryEvent>
    <bpmn:endEvent id="End_1" name="End" />
    <bpmn:endEvent id="End_A" name="End A" />
    <bpmn:endEvent id="End_B" name="End B" />
    <bpmn:endEvent id="End_C" name="End C" />
    <bpmn:sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_1" />
    <bpmn:sequenceFlow id="Flow_2" sourceRef="Task_1" targetRef="End_1" />
    <bpmn:sequenceFlow id="Flow_A" sourceRef="Boundary_A" targetRef="End_A" />
    <bpmn:sequenceFlow id="Flow_B" sourceRef="Boundary_B" targetRef="End_B" />
    <bpmn:sequenceFlow id="Flow_C" sourceRef="Boundary_C" targetRef="End_C" />
  </bpmn:process>
</bpmn:definitions>`;

test("three boundary events on one host are placed at distinct points", async () => {
  const result = await layoutProcess(xml);
  const { shapes } = await parseDi(result);
  const boundaries = ["Boundary_A", "Boundary_B", "Boundary_C"].map(
    (id) => shapes.find((s) => s.bpmnElement === id)!,
  );
  assert.ok(boundaries.every(Boolean), "expected all three boundary shapes to exist");

  const points = boundaries.map((s) => `${s.bounds.x},${s.bounds.y}`);
  assert.equal(new Set(points).size, points.length, `boundary events overlap: ${points.join(" | ")}`);
});
