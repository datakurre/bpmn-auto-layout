import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutProcess, layoutProcessWithDiagnostics } from "../auto-layout";
import { readFixture } from "./test-helpers";

test("layoutProcessWithDiagnostics produces the same XML as layoutProcess", async () => {
  const xml = readFixture("gateways-branches-loops.bpmn");
  const [plain, withDiagnostics] = await Promise.all([layoutProcess(xml), layoutProcessWithDiagnostics(xml)]);
  assert.equal(withDiagnostics.xml, plain);
});

test("layoutProcessWithDiagnostics reports no warnings for a clean fixture", async () => {
  const xml = readFixture("basic-events-tasks.bpmn");
  const { warnings } = await layoutProcessWithDiagnostics(xml);
  assert.deepEqual(warnings, []);
});

test("layoutProcessWithDiagnostics does not warn SHAPE_OVERLAPS_SHAPE for a boundary event overlapping its own host (#49)", async () => {
  // A boundary event straddling its host's border is required BPMN
  // notation, not a layout defect (#20's exemption for the Python metric).
  // The engine's own terminal shape-overlap check lacked the same
  // exemption and reported a false positive here. This fixture's three
  // boundary events straddle "Task_Host", each attached via attachedToRef;
  // none of that should surface as a SHAPE_OVERLAPS_SHAPE warning naming
  // Task_Host as the other shape (this pins only the #49 regression --
  // unrelated pre-existing overlaps this fixture may have, if any, are out
  // of scope here).
  const xml = readFixture("regression/boundary-events-three-on-one-host.bpmn");
  const { warnings } = await layoutProcessWithDiagnostics(xml);
  const boundaryIds = ["Boundary_Timer", "Boundary_Message", "Boundary_Error"];
  const hostOverlapWarning = warnings.find(
    (w) => w.code === "SHAPE_OVERLAPS_SHAPE" && w.message.includes("Task_Host") && boundaryIds.some((id) => w.message.includes(id)),
  );
  assert.ok(
    !hostOverlapWarning,
    `expected no SHAPE_OVERLAPS_SHAPE warning between a boundary event and its host, got ${JSON.stringify(hostOverlapWarning)}`,
  );
});

test("layoutProcessWithDiagnostics surfaces a structured warning instead of a silent or thrown degradation", async () => {
  // This fixture is known (via the bpmn-feedback quality gate) to have a
  // label that cannot avoid overlapping a shape/edge no matter which
  // candidate is chosen -- exactly the class of degradation #32 asks to be
  // reported rather than silently accepted or thrown.
  const xml = readFixture("gateways-branches-loops.bpmn");
  const { warnings } = await layoutProcessWithDiagnostics(xml);
  assert.ok(warnings.length > 0, "expected at least one warning for a fixture with known unresolved overlaps");
  for (const warning of warnings) {
    assert.ok(warning.code, "every warning must carry a code");
    assert.ok(warning.message, "every warning must carry a human-readable message");
    // Every warning code is evidence against one of the seven §8 priority
    // levels (#42) -- the priority ladder has a real call site producing
    // these, not just a structure that tests assert shape on.
    assert.ok(
      Number.isInteger(warning.priorityLevel) && warning.priorityLevel >= 1 && warning.priorityLevel <= 7,
      `warning ${warning.code} has an invalid priorityLevel: ${warning.priorityLevel}`,
    );
  }
});
