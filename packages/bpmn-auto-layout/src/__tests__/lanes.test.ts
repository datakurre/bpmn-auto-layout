import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutProcess } from "../auto-layout";
import { parseDi, type DiShape } from "./test-helpers";

function overlaps(a: DiShape["bounds"], b: DiShape["bounds"]): boolean {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0;
}

function contains(outer: DiShape["bounds"], inner: DiShape["bounds"]): boolean {
  return (
    inner.x >= outer.x - 0.5 &&
    inner.y >= outer.y - 0.5 &&
    inner.x + inner.width <= outer.x + outer.width + 0.5 &&
    inner.y + inner.height <= outer.y + outer.height + 0.5
  );
}

// A standalone process (no collaboration/participant) with three sibling
// lanes: one with a member, one with no members at all, and one that is
// itself split into two nested lanes via childLaneSet.
const standaloneXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Definitions_1" targetNamespace="http://example.com">
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:laneSet id="LaneSet_1">
      <bpmn:lane id="Lane_Top" name="Top">
        <bpmn:flowNodeRef>Start_1</bpmn:flowNodeRef>
        <bpmn:flowNodeRef>Task_1</bpmn:flowNodeRef>
      </bpmn:lane>
      <bpmn:lane id="Lane_Empty" name="Empty" />
      <bpmn:lane id="Lane_Nested" name="Nested">
        <bpmn:childLaneSet id="ChildLaneSet_1">
          <bpmn:lane id="Lane_Child_A" name="Child A">
            <bpmn:flowNodeRef>End_1</bpmn:flowNodeRef>
          </bpmn:lane>
          <bpmn:lane id="Lane_Child_B" name="Child B" />
        </bpmn:childLaneSet>
      </bpmn:lane>
    </bpmn:laneSet>
    <bpmn:startEvent id="Start_1" name="Start" />
    <bpmn:task id="Task_1" name="Do work" />
    <bpmn:endEvent id="End_1" name="End" />
    <bpmn:sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="Task_1" />
    <bpmn:sequenceFlow id="Flow_2" sourceRef="Task_1" targetRef="End_1" />
  </bpmn:process>
</bpmn:definitions>`;

test("standalone process: empty and nested lanes all get DI shapes", async () => {
  const result = await layoutProcess(standaloneXml);
  const { shapes } = await parseDi(result);
  const laneIds = ["Lane_Top", "Lane_Empty", "Lane_Nested", "Lane_Child_A", "Lane_Child_B"];
  const lanes = new Map(laneIds.map((id) => [id, shapes.find((s) => s.bpmnElement === id)]));
  for (const id of laneIds) {
    assert.ok(lanes.get(id), `expected a DI shape for lane ${id}`);
  }

  // Top-level siblings must partition the pool: same width, no overlap.
  const top = lanes.get("Lane_Top")!;
  const empty = lanes.get("Lane_Empty")!;
  const nested = lanes.get("Lane_Nested")!;
  for (const lane of [top, empty, nested]) {
    assert.equal(lane.bounds.x, top.bounds.x);
    assert.equal(lane.bounds.width, top.bounds.width);
  }
  assert.ok(!overlaps(top.bounds, empty.bounds));
  assert.ok(!overlaps(empty.bounds, nested.bounds));
  assert.ok(!overlaps(top.bounds, nested.bounds));

  // Nested children must be contained within their parent lane's band and
  // partition it between themselves.
  const childA = lanes.get("Lane_Child_A")!;
  const childB = lanes.get("Lane_Child_B")!;
  assert.ok(contains(nested.bounds, childA.bounds));
  assert.ok(contains(nested.bounds, childB.bounds));
  assert.ok(!overlaps(childA.bounds, childB.bounds));
});

test("collaboration lanes fixture: sibling lanes partition their pool", async () => {
  const { readFixture } = await import("./test-helpers");
  const xml = readFixture("subprocess-boundary-data-lanes.bpmn");
  const result = await layoutProcess(xml);
  const { shapes } = await parseDi(result);
  const laneShapes = shapes.filter((s) => s.bpmnElement.startsWith("Lane_"));
  assert.ok(laneShapes.length >= 2, "expected at least the two persisted lanes");
  for (let i = 0; i < laneShapes.length; i += 1) {
    for (let j = i + 1; j < laneShapes.length; j += 1) {
      assert.ok(
        !overlaps(laneShapes[i]!.bounds, laneShapes[j]!.bounds),
        `${laneShapes[i]!.bpmnElement} overlaps ${laneShapes[j]!.bpmnElement}`,
      );
    }
  }
  const widths = new Set(laneShapes.map((s) => s.bounds.width));
  assert.equal(widths.size, 1, "sibling lanes should share the same width");
});
