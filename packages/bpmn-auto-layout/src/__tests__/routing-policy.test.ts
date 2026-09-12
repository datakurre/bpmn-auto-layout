import { test } from "node:test";
import assert from "node:assert/strict";
import { repairSegmentCollisions, pathObstacles, segmentHitCount, type SharedEndpointContext } from "../collision-repair";
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

// #59 (reopened): a gateway's straight, same-track outgoing flow was being
// detoured because collision-repair treated a *sibling* flow's fanned-out
// departure segment -- leaving the same gateway a few px away, headed to a
// different track -- as a real obstacle. Two flows meeting at the same
// node are expected to run close together right there (the same rationale
// edge_crossings' own shared-endpoint exemption already applies at the
// metrics level, #48); an unrelated flow that merely happens to sit at the
// same spot must still count as a real obstacle.
test("pathObstacles exempts a sibling's departure inside the shared node's zone, but not an unrelated flow at the same spot", () => {
  // Both paths depart 4px from where "Current" would leave its own source --
  // the exact near-miss margin from the reopened bug's repro.
  const nearbyDeparture = [
    { x: 50, y: 4 },
    { x: 100, y: 4 },
  ];
  const paths = new Map([
    ["Sibling", nearbyDeparture],
    ["Unrelated", nearbyDeparture],
  ]);
  const sharedEndpoints: SharedEndpointContext = {
    sourceId: "Gateway",
    targetId: "Target",
    // The gateway's own bounds (x:0,y:-20,w:50,h:50) inflated by
    // ROUTE_DEPARTURE_GAP -- exactly what routeObstacles computes.
    sourceZone: { x: -40, y: -60, width: 130, height: 90 },
    endpointsById: new Map([
      ["Sibling", { sourceId: "Gateway", targetId: "OtherTarget" }],
      ["Unrelated", { sourceId: "SomeOtherNode", targetId: "AnotherNode" }],
    ]),
  };

  const obstacles = pathObstacles(paths, undefined, sharedEndpoints);
  const obstacleFlowIds = new Set(obstacles.map((o) => o.id.split(":")[0]));
  assert.ok(
    !obstacleFlowIds.has("Sibling"),
    `a sibling departing the shared gateway a few px away must not become an obstacle there: ${JSON.stringify(obstacles)}`,
  );
  assert.ok(
    obstacleFlowIds.has("Unrelated"),
    "an unrelated flow at the exact same spot, sharing no endpoint with the current flow, must still be a real obstacle",
  );

  // And the exemption must actually clear a route through that zone: the
  // straight candidate a route out of "Gateway" would use must register 0
  // hits against the sibling but still register a hit if the "unrelated"
  // flow occupied that same spot.
  const straightThroughZone = [
    { x: 40, y: 4 },
    { x: 110, y: 4 },
  ];
  const withoutUnrelated = pathObstacles(paths, "Unrelated", sharedEndpoints);
  assert.equal(
    segmentHitCount(straightThroughZone[0]!, straightThroughZone[1]!, withoutUnrelated),
    0,
    "with only the sibling present, the straight route through the shared zone must be hit-free",
  );
  const onlyUnrelated = pathObstacles(paths, "Sibling", sharedEndpoints);
  assert.ok(
    segmentHitCount(straightThroughZone[0]!, straightThroughZone[1]!, onlyUnrelated) > 0,
    "with the unrelated flow present, the same straight route must still register a hit",
  );
});
