import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutProcess } from "../auto-layout";

// A long gateway name that requires wrapping onto multiple label lines.
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Definitions_1" targetNamespace="http://example.com">
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:startEvent id="Start_1" name="Start" />
    <bpmn:exclusiveGateway id="Gateway_1" name="Does this request need a second round of manual review?" />
    <bpmn:task id="Task_1" name="Do work" />
    <bpmn:endEvent id="End_1" name="End" />
    <bpmn:sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Gateway_1" />
    <bpmn:sequenceFlow id="Flow_2" sourceRef="Gateway_1" targetRef="Task_1" name="yes" />
    <bpmn:sequenceFlow id="Flow_3" sourceRef="Task_1" targetRef="End_1" />
    <bpmn:sequenceFlow id="Flow_4" sourceRef="Gateway_1" targetRef="End_1" name="no" />
  </bpmn:process>
</bpmn:definitions>`;

test("laying out a gateway with a long name does not rewrite bpmn:name", async () => {
  const result = await layoutProcess(xml);
  // The semantic name must stay exactly as authored: no injected newlines
  // from multi-line label wrapping (that's a DI/rendering concern only).
  assert.match(
    result,
    /<bpmn:exclusiveGateway id="Gateway_1" name="Does this request need a second round of manual review\?"/,
  );
});
