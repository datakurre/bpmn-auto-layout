import { test } from "node:test";
import assert from "node:assert/strict";
import { routeProcessFlows } from "../process-routing";
import { DEFAULT_OPTIONS } from "../element-dimensions";
import type { NodeLayout, ProcessLayoutResult } from "../layout-types";

interface NodeSpec {
  id: string;
  type?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  track: number;
  col: number;
}

function node({ id, type = "bpmn:Task", x, y, w, h, track, col }: NodeSpec): NodeLayout {
  return {
    id,
    element: { $type: type, id, incoming: [], outgoing: [] },
    col,
    track,
    x,
    y,
    width: w,
    height: h,
    centerX: x + w / 2,
    centerY: y + h / 2,
  };
}

// This test exercises route geometry directly against a hand-built
// ProcessLayoutResult -- no BPMN XML, no moddle, no DI serialization. That
// is the point of extracting routing out of di-creation.ts (#31): "this
// flow takes two bends" is now a plain assertion on routeProcessFlows'
// return value, not something that requires parsing rendered XML.
test("routeProcessFlows detours around a same-track obstacle instead of crossing it", () => {
  const src = node({ id: "Src", x: 0, y: 100, w: 100, h: 80, track: 0, col: 0 });
  const blocker = node({ id: "Blocker", x: 200, y: 100, w: 100, h: 80, track: 0, col: 1 });
  const tgt = node({ id: "Tgt", x: 400, y: 100, w: 100, h: 80, track: 0, col: 2 });
  const nodes = new Map<string, NodeLayout>([
    [src.id, src],
    [blocker.id, blocker],
    [tgt.id, tgt],
  ]);
  const flow = { id: "Flow_1", sourceRef: { id: "Src" }, targetRef: { id: "Tgt" } };
  const layout: ProcessLayoutResult = { nodes, allFlows: [flow] };

  const waypoints = routeProcessFlows(layout, DEFAULT_OPTIONS);
  const route = waypoints.get("Flow_1");
  assert.ok(route, "Flow_1 should have a routed waypoint list");
  assert.ok(route!.length > 2, `expected a detour around the blocker, got a direct route: ${JSON.stringify(route)}`);

  // Every segment must be axis-aligned (orthogonal routing, §2) and must not
  // pass through the blocker's bounds.
  for (let i = 0; i < route!.length - 1; i += 1) {
    const a = route![i]!;
    const b = route![i + 1]!;
    assert.ok(a.x === b.x || a.y === b.y, `segment ${i} is not orthogonal: ${JSON.stringify([a, b])}`);
    if (a.y === b.y && a.y > blocker.y && a.y < blocker.y + blocker.height) {
      const lo = Math.min(a.x, b.x);
      const hi = Math.max(a.x, b.x);
      assert.ok(
        hi <= blocker.x || lo >= blocker.x + blocker.width,
        `segment ${i} passes through the blocker: ${JSON.stringify([a, b])}`,
      );
    }
  }
});

test("routeProcessFlows returns a direct two-point route when nothing obstructs it", () => {
  const src = node({ id: "Src", x: 0, y: 100, w: 100, h: 80, track: 0, col: 0 });
  const tgt = node({ id: "Tgt", x: 300, y: 100, w: 100, h: 80, track: 0, col: 2 });
  const nodes = new Map<string, NodeLayout>([
    [src.id, src],
    [tgt.id, tgt],
  ]);
  const flow = { id: "Flow_1", sourceRef: { id: "Src" }, targetRef: { id: "Tgt" } };
  const layout: ProcessLayoutResult = { nodes, allFlows: [flow] };

  const waypoints = routeProcessFlows(layout, DEFAULT_OPTIONS);
  const route = waypoints.get("Flow_1");
  assert.deepEqual(
    route,
    [
      { x: 100, y: 140 },
      { x: 300, y: 140 },
    ],
    `expected a plain 2-point route, got ${JSON.stringify(route)}`,
  );
});
