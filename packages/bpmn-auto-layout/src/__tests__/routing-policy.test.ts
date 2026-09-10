import { test } from "node:test";
import assert from "node:assert/strict";
import { repairSegmentCollisions } from "../collision-repair";
import type { NodeLayout, ProcessLayoutResult } from "../layout-types";

interface NodeSpec {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  track: number;
}

function node({ id, x, y, w, h, track }: NodeSpec): NodeLayout {
  return {
    id,
    element: { $type: "bpmn:Task", id, incoming: [], outgoing: [] },
    col: 0,
    track,
    x,
    y,
    width: w,
    height: h,
    centerX: x + w / 2,
    centerY: y + h / 2,
  };
}

test("repairSegmentCollisions consults routingPolicy even for a collision-free primary route", () => {
  // Source and target sit on different tracks but happen to align on centerY,
  // so the primary (case-based) router hands back a plain 2-point, 0-turn
  // route. Nothing obstructs that route, so it is collision-free.
  const src = node({ id: "Src", x: 0, y: 100, w: 100, h: 80, track: 0 });
  const tgt = node({ id: "Tgt", x: 400, y: 100, w: 100, h: 80, track: 1 });
  // At least one other node must exist for the visibility-graph fallback to
  // consider alternate routes at all.
  const obstacle = node({ id: "Obstacle", x: 200, y: 300, w: 100, h: 80, track: 0 });
  const nodes = new Map<string, NodeLayout>([
    [src.id, src],
    [tgt.id, tgt],
    [obstacle.id, obstacle],
  ]);
  const layout: ProcessLayoutResult = { nodes, allFlows: [] };
  const flow = { id: "Flow_1", sourceRef: { id: "Src" }, targetRef: { id: "Tgt" } };
  const straight = [
    { x: src.x + src.width, y: src.centerY },
    { x: tgt.x, y: tgt.centerY },
  ];

  const withDefaultPolicy = repairSegmentCollisions(straight, layout, flow, new Map());
  assert.equal(withDefaultPolicy.length, 2, "default policy keeps the direct route");

  const withMinimumTurns = repairSegmentCollisions(straight, layout, flow, new Map(), {
    requireOrthogonal: true,
    minimumTurns: 1,
    preferFewestTurns: true,
    preferredPathLengthFactor: Number.POSITIVE_INFINITY,
  });
  assert.ok(
    withMinimumTurns.length > 2,
    `a minimumTurns:1 policy should reject the 0-turn direct route, got ${JSON.stringify(withMinimumTurns)}`,
  );
});
