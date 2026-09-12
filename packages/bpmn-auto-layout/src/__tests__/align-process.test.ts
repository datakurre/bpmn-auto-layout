import { test } from "node:test";
import assert from "node:assert/strict";
import { alignProcess } from "../auto-layout";
import { parseDi, readFixture } from "./test-helpers";

test("alignProcess is idempotent: running it twice equals running it once", async () => {
  const xml = readFixture("gateways-branches-loops.bpmn");
  const once = await alignProcess(xml);
  const twice = await alignProcess(once);
  assert.equal(once, twice);
});

test("alignProcess does not increase any edge's waypoint count", async () => {
  const xml = readFixture("gateways-branches-loops.bpmn");
  const before = await parseDi(xml);
  const aligned = await alignProcess(xml);
  const after = await parseDi(aligned);
  const beforeCounts = new Map(before.edges.map((edge) => [edge.bpmnElement, edge.waypoints.length]));
  for (const edge of after.edges) {
    const beforeCount = beforeCounts.get(edge.bpmnElement);
    if (beforeCount === undefined) continue;
    assert.ok(
      edge.waypoints.length <= beforeCount,
      `${edge.bpmnElement} gained a waypoint: ${beforeCount} -> ${edge.waypoints.length}`,
    );
  }
});

test("alignProcess preserves the relative order of shape centers on both axes", async () => {
  const xml = readFixture("stress-dense-routing.bpmn");
  const before = await parseDi(xml);
  const aligned = await alignProcess(xml);
  const after = await parseDi(aligned);
  const beforeCenter = new Map(
    before.shapes.map((s) => [s.bpmnElement, { cx: s.bounds.x + s.bounds.width / 2, cy: s.bounds.y + s.bounds.height / 2 }]),
  );
  const afterCenter = new Map(
    after.shapes.map((s) => [s.bpmnElement, { cx: s.bounds.x + s.bounds.width / 2, cy: s.bounds.y + s.bounds.height / 2 }]),
  );
  const ids = [...beforeCenter.keys()].filter((id) => afterCenter.has(id));
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = ids[i]!;
      const b = ids[j]!;
      const beforeXSign = Math.sign(beforeCenter.get(a)!.cx - beforeCenter.get(b)!.cx);
      const afterXSign = Math.sign(afterCenter.get(a)!.cx - afterCenter.get(b)!.cx);
      if (beforeXSign !== 0 && afterXSign !== 0) {
        assert.equal(beforeXSign, afterXSign, `${a} and ${b} flipped x order`);
      }
      const beforeYSign = Math.sign(beforeCenter.get(a)!.cy - beforeCenter.get(b)!.cy);
      const afterYSign = Math.sign(afterCenter.get(a)!.cy - afterCenter.get(b)!.cy);
      if (beforeYSign !== 0 && afterYSign !== 0) {
        assert.equal(beforeYSign, afterYSign, `${a} and ${b} flipped y order`);
      }
    }
  }
});

test("alignProcess leaves a Lane's own bounds untouched", async () => {
  const xml = readFixture("collaboration-lanes-messages.bpmn");
  const before = await parseDi(xml);
  const aligned = await alignProcess(xml);
  const after = await parseDi(aligned);
  const laneIdsBefore = before.shapes.filter((s) => s.bpmnElement.startsWith("Lane")).map((s) => s.bpmnElement);
  assert.ok(laneIdsBefore.length > 0, "fixture should declare at least one lane");
  for (const laneId of laneIdsBefore) {
    const b = before.shapes.find((s) => s.bpmnElement === laneId)!;
    const a = after.shapes.find((s) => s.bpmnElement === laneId)!;
    assert.deepEqual(a.bounds, b.bounds, `${laneId}'s bounds should be untouched by v1`);
  }
});

test("alignProcess never widens the canvas by more than a small bounded amount", async () => {
  const xml = readFixture("boundary-and-subprocesses.bpmn");
  const before = await parseDi(xml);
  const aligned = await alignProcess(xml);
  const after = await parseDi(aligned);
  const bbox = (shapes: typeof before.shapes) => ({
    minX: Math.min(...shapes.map((s) => s.bounds.x)),
    minY: Math.min(...shapes.map((s) => s.bounds.y)),
    maxX: Math.max(...shapes.map((s) => s.bounds.x + s.bounds.width)),
    maxY: Math.max(...shapes.map((s) => s.bounds.y + s.bounds.height)),
  });
  const b = bbox(before.shapes);
  const a = bbox(after.shapes);
  const MAX_BOUND_SHIFT = 25;
  assert.ok(Math.abs(a.minX - b.minX) <= MAX_BOUND_SHIFT, "left edge should not shift far");
  assert.ok(Math.abs(a.minY - b.minY) <= MAX_BOUND_SHIFT, "top edge should not shift far");
  assert.ok(Math.abs(a.maxX - b.maxX) <= MAX_BOUND_SHIFT, "right edge should not shift far");
  assert.ok(Math.abs(a.maxY - b.maxY) <= MAX_BOUND_SHIFT, "bottom edge should not shift far");
});

test("alignProcess on a diagram with no DI at all returns it unchanged", async () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Definitions_1" targetNamespace="http://example.com">
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:startEvent id="Start_1" />
  </bpmn:process>
</bpmn:definitions>`;
  const aligned = await alignProcess(xml);
  const parsed = await parseDi(aligned);
  assert.equal(parsed.shapes.length, 0);
  assert.equal(parsed.edges.length, 0);
});
