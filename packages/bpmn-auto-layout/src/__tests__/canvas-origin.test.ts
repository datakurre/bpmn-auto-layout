import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutProcess } from "../auto-layout";
import { parseDi } from "./test-helpers";

// A gateway branch named "error" is routed upward (onto a negative track),
// carrying its subprocess with it, so the subprocess and its children land
// above y=0 unless the final plane is normalized back to a positive origin.
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Definitions_1" targetNamespace="http://example.com">
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:startEvent id="Start_1" name="Start" />
    <bpmn:task id="Task_1" name="Do work" />
    <bpmn:exclusiveGateway id="Gateway_1" name="OK?" />
    <bpmn:endEvent id="End_1" name="End" />
    <bpmn:subProcess id="SubProcess_1" name="Handle error">
      <bpmn:startEvent id="Sub_Start" name="Begin" />
      <bpmn:exclusiveGateway id="Sub_Gateway" name="Which path?" />
      <bpmn:task id="Sub_Alpha" name="Alpha" />
      <bpmn:task id="Sub_Beta" name="Beta" />
      <bpmn:endEvent id="Sub_End" name="Done" />
      <bpmn:sequenceFlow id="Sub_Flow_1" sourceRef="Sub_Start" targetRef="Sub_Gateway" />
      <bpmn:sequenceFlow id="Sub_Flow_2" sourceRef="Sub_Gateway" targetRef="Sub_Alpha" name="alpha" />
      <bpmn:sequenceFlow id="Sub_Flow_3" sourceRef="Sub_Gateway" targetRef="Sub_Beta" name="beta" />
      <bpmn:sequenceFlow id="Sub_Flow_4" sourceRef="Sub_Alpha" targetRef="Sub_End" />
      <bpmn:sequenceFlow id="Sub_Flow_5" sourceRef="Sub_Beta" targetRef="Sub_End" />
    </bpmn:subProcess>
    <bpmn:endEvent id="End_Error" name="Errored" />
    <bpmn:sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_1" />
    <bpmn:sequenceFlow id="Flow_2" sourceRef="Task_1" targetRef="Gateway_1" />
    <bpmn:sequenceFlow id="Flow_3" sourceRef="Gateway_1" targetRef="End_1" name="ok" />
    <bpmn:sequenceFlow id="Flow_4" sourceRef="Gateway_1" targetRef="SubProcess_1" name="error" />
    <bpmn:sequenceFlow id="Flow_5" sourceRef="SubProcess_1" targetRef="End_Error" />
  </bpmn:process>
</bpmn:definitions>`;

test("the finished plane never has negative shape, label, or waypoint coordinates", async () => {
  const result = await layoutProcess(xml);
  const { shapes, edges } = await parseDi(result);
  assert.ok(shapes.length > 0);

  for (const shape of shapes) {
    assert.ok(shape.bounds.x >= 0, `${shape.id} has negative x: ${shape.bounds.x}`);
    assert.ok(shape.bounds.y >= 0, `${shape.id} has negative y: ${shape.bounds.y}`);
  }
  for (const edge of edges) {
    for (const point of edge.waypoints) {
      assert.ok(point.x >= 0, `${edge.id} has a negative-x waypoint: ${JSON.stringify(point)}`);
      assert.ok(point.y >= 0, `${edge.id} has a negative-y waypoint: ${JSON.stringify(point)}`);
    }
  }
});
