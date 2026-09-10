import { test } from "node:test";
import assert from "node:assert/strict";
import { leafLaneOrderIndex } from "../lane-layout";

test("leafLaneOrderIndex assigns distinct indices across multiple laneSets", () => {
  // Two laneSets, two lanes each. The old `laneSetIndex + laneIndex` formula
  // collided here: laneSet 0's second lane (0+1=1) and laneSet 1's first
  // lane (1+0=1) both mapped to index 1.
  const laneSets = [
    {
      lanes: [
        { id: "LS0_L0", flowNodeRef: [{ id: "A" }] },
        { id: "LS0_L1", flowNodeRef: [{ id: "B" }] },
      ],
    },
    {
      lanes: [
        { id: "LS1_L0", flowNodeRef: [{ id: "C" }] },
        { id: "LS1_L1", flowNodeRef: [{ id: "D" }] },
      ],
    },
  ];

  const index = leafLaneOrderIndex(laneSets);
  const values = [index.get("A"), index.get("B"), index.get("C"), index.get("D")];
  assert.ok(
    values.every((v) => typeof v === "number"),
    "every node should get an index",
  );
  assert.equal(new Set(values).size, 4, `expected 4 distinct indices, got ${JSON.stringify(values)}`);
});

test("leafLaneOrderIndex assigns each nested lane its own index", () => {
  const laneSets = [
    {
      lanes: [
        { id: "Parent", childLaneSet: { lanes: [
          { id: "Child_A", flowNodeRef: [{ id: "A" }] },
          { id: "Child_B", flowNodeRef: [{ id: "B" }] },
        ] } },
        { id: "Sibling", flowNodeRef: [{ id: "C" }] },
      ],
    },
  ];

  const index = leafLaneOrderIndex(laneSets);
  const a = index.get("A");
  const b = index.get("B");
  const c = index.get("C");
  assert.equal(new Set([a, b, c]).size, 3, `expected 3 distinct indices, got ${JSON.stringify([a, b, c])}`);
});
