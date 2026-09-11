import { test } from "node:test";
import assert from "node:assert/strict";
import { comparePriorityViolations, LAYOUT_PRIORITY_LEVELS } from "../layout-policy";

test("LAYOUT_PRIORITY_LEVELS lists the seven §8 levels in order, 1 through 7", () => {
  assert.equal(LAYOUT_PRIORITY_LEVELS.length, 7);
  assert.deepEqual(
    LAYOUT_PRIORITY_LEVELS.map((l) => l.level),
    [1, 2, 3, 4, 5, 6, 7],
  );
});

test("comparePriorityViolations prefers a candidate violating only a higher-numbered level", () => {
  // Violates compactness (7) only -- the lowest-priority level.
  const compactOnly = new Set([7]);
  // Violates no-overlaps (2) -- a much more important level, even though
  // it violates nothing else.
  const overlapOnly = new Set([2]);
  assert.ok(
    comparePriorityViolations(compactOnly, overlapOnly) < 0,
    "a single level-7 violation must be preferred over a single level-2 violation",
  );
});

test("comparePriorityViolations never lets more numerous high-level violations outweigh one low-level violation", () => {
  // Violates every level from 4 through 7, but not 1-3.
  const manyLowPriority = new Set([4, 5, 6, 7]);
  // Violates only level 1, the single most important constraint.
  const oneHighPriority = new Set([1]);
  assert.ok(
    comparePriorityViolations(manyLowPriority, oneHighPriority) < 0,
    "four violations at levels 4-7 must still beat a single violation at level 1",
  );
});

test("comparePriorityViolations is 0 when the same levels are violated", () => {
  assert.equal(comparePriorityViolations(new Set([5, 6]), new Set([5, 6])), 0);
});
