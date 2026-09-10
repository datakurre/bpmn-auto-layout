import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutProcess } from "../auto-layout";
import { listFixtures, readFixture, parseDi } from "./test-helpers";

function isAxisAligned(waypoints: Array<{ x: number; y: number }>): boolean {
  for (let i = 1; i < waypoints.length; i += 1) {
    const a = waypoints[i - 1]!;
    const b = waypoints[i]!;
    if (a.x !== b.x && a.y !== b.y) return false;
  }
  return true;
}

for (const fixture of listFixtures()) {
  test(`${fixture}: lays out without throwing and produces valid DI`, async () => {
    const xml = readFixture(fixture);
    const result = await layoutProcess(xml);
    assert.match(result, /<bpmn:definitions/);
    const { shapes, edges } = await parseDi(result);
    assert.ok(shapes.length > 0, "expected at least one shape");

    for (const shape of shapes) {
      assert.ok(shape.bounds.width > 0, `${shape.id} has non-positive width`);
      assert.ok(shape.bounds.height > 0, `${shape.id} has non-positive height`);
    }

    for (const edge of edges) {
      assert.ok(edge.waypoints.length >= 2, `${edge.id} has fewer than 2 waypoints`);
      assert.ok(
        isAxisAligned(edge.waypoints),
        `${edge.id} has a non-orthogonal segment: ${JSON.stringify(edge.waypoints)}`,
      );
    }
  });

  test(`${fixture}: DI shape and edge ids are unique`, async () => {
    const xml = readFixture(fixture);
    const result = await layoutProcess(xml);
    const { shapes, edges } = await parseDi(result);
    const ids = [...shapes.map((s) => s.id), ...edges.map((e) => e.id)];
    assert.equal(new Set(ids).size, ids.length, "duplicate DI element ids found");
  });

  test(`${fixture}: layout is deterministic across repeated runs`, async () => {
    const xml = readFixture(fixture);
    const [first, second] = await Promise.all([layoutProcess(xml), layoutProcess(xml)]);
    assert.equal(first, second);
  });
}
