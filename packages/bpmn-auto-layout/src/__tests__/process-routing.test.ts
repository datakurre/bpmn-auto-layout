import { test } from "node:test";
import assert from "node:assert/strict";
import { routeProcessFlows, checkTerminalRouteInvariants, type RoutePoint } from "../process-routing";
import { DEFAULT_OPTIONS } from "../element-dimensions";
import type { NodeLayout, ProcessLayoutResult } from "../layout-types";
import type { LayoutWarning } from "../layout-warnings";

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

// The terminal invariant pass (#42) re-checks the *finished* layout as a
// whole rather than trusting that whichever pass produced a piece of
// geometry got it right -- the #41 regression was exactly a route that was
// fine when computed and wrong by the time routing finished, with nothing
// noticing. It is a separate function from routeProcessFlows (#51): a real
// pipeline must call it after every later pass that can still move a
// waypoint (di-creation.ts's label re-repair loop), not right after routing.
// These tests call it directly against a hand-built layout, the same way
// the routing tests above exercise routeProcessFlows directly.
test("routeProcessFlows warns when two unrelated shapes overlap, tagged with their §8 priority level", () => {
  const a = node({ id: "A", x: 0, y: 0, w: 100, h: 80, track: 0, col: 0 });
  const b = node({ id: "B", x: 50, y: 0, w: 100, h: 80, track: 0, col: 1 });
  const nodes = new Map<string, NodeLayout>([
    [a.id, a],
    [b.id, b],
  ]);
  const layout: ProcessLayoutResult = { nodes, allFlows: [] };

  const warnings: LayoutWarning[] = [];
  const edgeWaypoints = routeProcessFlows(layout, DEFAULT_OPTIONS, warnings);
  checkTerminalRouteInvariants(layout, edgeWaypoints, warnings);

  const overlap = warnings.find((w) => w.code === "SHAPE_OVERLAPS_SHAPE");
  assert.ok(overlap, `expected a SHAPE_OVERLAPS_SHAPE warning, got ${JSON.stringify(warnings)}`);
  assert.equal(overlap!.priorityLevel, 2, "no-overlaps is §8 priority level 2");
});

// #51: a ROUTE_INTERSECTS_OBSTACLE message used to say only "overlaps a
// node, container, or another route" -- which sent readers investigating
// what it actually hit instead of being a one-line read. Pin that the
// message names the obstacle's kind and id.
test("checkTerminalRouteInvariants names the obstacle kind and id a route still hits", () => {
  const src = node({ id: "Src", x: 0, y: 100, w: 100, h: 80, track: 0, col: 0 });
  const obstacle = node({ id: "Obstacle", x: 200, y: 100, w: 100, h: 80, track: 0, col: 1 });
  const tgt = node({ id: "Tgt", x: 400, y: 100, w: 100, h: 80, track: 0, col: 2 });
  const nodes = new Map<string, NodeLayout>([
    [src.id, src],
    [obstacle.id, obstacle],
    [tgt.id, tgt],
  ]);
  const flow = { id: "Flow_1", sourceRef: { id: "Src" }, targetRef: { id: "Tgt" } };
  const layout: ProcessLayoutResult = { nodes, allFlows: [flow] };

  // A route drawn straight through Obstacle's bounds, set up directly
  // rather than produced by routing -- this test pins only what the
  // warning reports, not whether routing would ever ship this geometry.
  const edgeWaypoints = new Map<string, RoutePoint[]>([
    ["Flow_1", [
      { x: 100, y: 140 },
      { x: 400, y: 140 },
    ]],
  ]);

  const warnings: LayoutWarning[] = [];
  checkTerminalRouteInvariants(layout, edgeWaypoints, warnings);

  const hit = warnings.find((w) => w.code === "ROUTE_INTERSECTS_OBSTACLE");
  assert.ok(hit, `expected a ROUTE_INTERSECTS_OBSTACLE warning, got ${JSON.stringify(warnings)}`);
  assert.ok(hit!.message.includes("shape Obstacle"), `expected the message to name the obstacle it hit, got: ${hit!.message}`);
});

test("routeProcessFlows does not warn about a subprocess containing its own child", () => {
  const outer = node({ id: "Outer", type: "bpmn:SubProcess", x: 0, y: 0, w: 300, h: 200, track: 0, col: 0 });
  const child: NodeLayout = { ...node({ id: "Child", x: 20, y: 20, w: 100, h: 80, track: 0, col: 0 }), isSubProcessChild: true, containerId: "Outer" };
  const nodes = new Map<string, NodeLayout>([
    [outer.id, outer],
    [child.id, child],
  ]);
  const layout: ProcessLayoutResult = { nodes, allFlows: [] };

  const warnings: LayoutWarning[] = [];
  const edgeWaypoints = routeProcessFlows(layout, DEFAULT_OPTIONS, warnings);
  checkTerminalRouteInvariants(layout, edgeWaypoints, warnings);

  assert.ok(
    !warnings.some((w) => w.code === "SHAPE_OVERLAPS_SHAPE"),
    `a subprocess containing its own child is not an overlap: ${JSON.stringify(warnings)}`,
  );
});

// #49: a boundary event is required by BPMN to straddle its host activity's
// border -- #20 exempted that legitimate overlap from the Python metric
// (tools/bpmn_feedback.py), but the engine's own terminal check reintroduced
// it as a false positive because it had no equivalent exemption.
test("routeProcessFlows does not warn about a boundary event overlapping its own host", () => {
  const host = node({ id: "Host", type: "bpmn:Task", x: 0, y: 0, w: 100, h: 80, track: 0, col: 0 });
  const boundary: NodeLayout = {
    ...node({ id: "Boundary", type: "bpmn:BoundaryEvent", x: 82, y: 62, w: 36, h: 36, track: 0, col: 0 }),
    element: { $type: "bpmn:BoundaryEvent", id: "Boundary", incoming: [], outgoing: [], attachedToRef: { id: "Host" } },
  };
  const nodes = new Map<string, NodeLayout>([
    [host.id, host],
    [boundary.id, boundary],
  ]);
  const layout: ProcessLayoutResult = { nodes, allFlows: [] };

  const warnings: LayoutWarning[] = [];
  const edgeWaypoints = routeProcessFlows(layout, DEFAULT_OPTIONS, warnings);
  checkTerminalRouteInvariants(layout, edgeWaypoints, warnings);

  assert.ok(
    !warnings.some((w) => w.code === "SHAPE_OVERLAPS_SHAPE"),
    `a boundary event straddling its host's border is not an overlap: ${JSON.stringify(warnings)}`,
  );
});

test("routeProcessFlows still warns when a boundary event overlaps a shape that is not its host", () => {
  const host = node({ id: "Host", type: "bpmn:Task", x: 0, y: 0, w: 100, h: 80, track: 0, col: 0 });
  // Positioned to overlap the boundary event but not the host itself, so the
  // only expected SHAPE_OVERLAPS_SHAPE warning is Boundary/Bystander.
  const bystander = node({ id: "Bystander", type: "bpmn:Task", x: 100, y: 62, w: 100, h: 80, track: 0, col: 1 });
  const boundary: NodeLayout = {
    ...node({ id: "Boundary", type: "bpmn:BoundaryEvent", x: 82, y: 62, w: 36, h: 36, track: 0, col: 0 }),
    element: { $type: "bpmn:BoundaryEvent", id: "Boundary", incoming: [], outgoing: [], attachedToRef: { id: "Host" } },
  };
  const nodes = new Map<string, NodeLayout>([
    [host.id, host],
    [bystander.id, bystander],
    [boundary.id, boundary],
  ]);
  const layout: ProcessLayoutResult = { nodes, allFlows: [] };

  const warnings: LayoutWarning[] = [];
  const edgeWaypoints = routeProcessFlows(layout, DEFAULT_OPTIONS, warnings);
  checkTerminalRouteInvariants(layout, edgeWaypoints, warnings);

  assert.ok(
    warnings.some((w) => w.code === "SHAPE_OVERLAPS_SHAPE" && w.message.includes("Boundary") && w.message.includes("Bystander")),
    `expected a SHAPE_OVERLAPS_SHAPE warning for the boundary/bystander overlap, got ${JSON.stringify(warnings)}`,
  );
});
