import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAlignmentDeltas, stretchWaypoints } from "../align-layout";
import type { NodeLayout } from "../layout-types";
import { DEFAULT_OPTIONS } from "../element-dimensions";

function node(id: string, centerX: number, centerY: number, width = 100, height = 80): NodeLayout {
  return {
    id,
    element: { $type: "bpmn:Task" },
    col: 0,
    track: 0,
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height,
    centerX,
    centerY,
  };
}

test("computeAlignmentDeltas clusters centers within the threshold onto the same grid-snapped value", () => {
  // 100 and 104 are 4px apart (within ALIGN_CLUSTER_THRESHOLD=10) on the x
  // axis -- they should end up at the exact same aligned x.
  const nodes = [node("A", 100, 50), node("B", 104, 50)];
  const { dx } = computeAlignmentDeltas(nodes, DEFAULT_OPTIONS);
  const newAX = 100 + dx.get("A")!;
  const newBX = 104 + dx.get("B")!;
  assert.equal(newAX, newBX, "centers within the cluster threshold should land on the same value");
  assert.equal(newAX % DEFAULT_OPTIONS.gridSize, 0, "the shared value should be on the grid");
});

test("computeAlignmentDeltas leaves centers further apart than the threshold independent", () => {
  const nodes = [node("A", 100, 50), node("B", 400, 50)];
  const { dx } = computeAlignmentDeltas(nodes, DEFAULT_OPTIONS);
  const newAX = 100 + dx.get("A")!;
  const newBX = 400 + dx.get("B")!;
  assert.notEqual(newAX, newBX, "centers well apart should not be merged");
});

test("computeAlignmentDeltas is idempotent: aligning already-aligned centers changes nothing", () => {
  const nodes = [node("A", 100, 50), node("B", 250, 50)];
  const first = computeAlignmentDeltas(nodes, DEFAULT_OPTIONS);
  const movedA = node("A", 100 + first.dx.get("A")!, 50 + first.dy.get("A")!);
  const movedB = node("B", 250 + first.dx.get("B")!, 50 + first.dy.get("B")!);
  const second = computeAlignmentDeltas([movedA, movedB], DEFAULT_OPTIONS);
  assert.equal(second.dx.get("A"), 0);
  assert.equal(second.dx.get("B"), 0);
  assert.equal(second.dy.get("A"), 0);
  assert.equal(second.dy.get("B"), 0);
});

test("stretchWaypoints keeps a vertical opening segment vertical when the two endpoints get different x deltas", () => {
  // Regression case: interpolating an offset by point *index* (0%, 33%,
  // 67%, 100% along the array) instead of by each point's own coordinate
  // turned this exact shape -- a straight-up-then-across-then-down
  // "bidirectional bypass" route -- diagonal at its very first segment,
  // which then needed an extra corner to fix, increasing the waypoint
  // count. Interpolating by coordinate keeps points that already share an
  // x (or y) sharing it after the stretch.
  const points = [
    { x: 173, y: 75 },
    { x: 173, y: 20 },
    { x: 448, y: 20 },
    { x: 448, y: 60 },
  ];
  const stretched = stretchWaypoints(points, { dx: -3, dy: 0 }, { dx: 2, dy: 0 });
  assert.equal(stretched.length, 4, "no corner should need to be added");
  assert.equal(stretched[0]!.x, stretched[1]!.x, "the opening vertical segment should stay vertical");
  assert.equal(stretched[2]!.x, stretched[3]!.x, "the closing vertical segment should stay vertical");
  assert.equal(stretched[0]!.x, 170);
  assert.equal(stretched[2]!.x, 450);
});

test("stretchWaypoints leaves a 2-point straight edge straight when both endpoints move together", () => {
  const points = [
    { x: 100, y: 50 },
    { x: 200, y: 50 },
  ];
  const stretched = stretchWaypoints(points, { dx: 5, dy: 0 }, { dx: 5, dy: 0 });
  assert.deepEqual(stretched, [
    { x: 105, y: 50 },
    { x: 205, y: 50 },
  ]);
});
