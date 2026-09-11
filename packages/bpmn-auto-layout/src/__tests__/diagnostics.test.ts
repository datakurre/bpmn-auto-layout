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
  }
});
