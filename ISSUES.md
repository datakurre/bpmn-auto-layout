# Layout review findings

## Review scope

These findings come from laying out isolated copies of every checked-in fixture
and rendering the results with `bpmn-to-image`. The source fixtures were not
modified. This was a manual visual review, not an acceptance of the current
feedback-loop quality gate.

The layout is already good enough for simple horizontal processes. The main
remaining problems are concentrated in gateway-heavy graphs, boundary events,
expanded subprocesses, and layouts where a route must travel around several
tracks.

## Priority order

1. Fix label and route separation around gateways and loop-backs.
2. Reserve explicit header/attachment space for boundary events and expanded
   subprocesses.
3. Improve long-route channel selection so routes do not dominate the diagram
   perimeter or run immediately alongside container borders.
4. Repair the fixture validation contract before using the self-test as a
   regression gate.
5. Add objective geometry checks only after the expected visual behavior above
   is documented with small regression cases.

## Fixture: `basic-events-tasks.bpmn`

**Assessment: good baseline.**

The main spine, event labels, service-task icons, gateway labels, and the
retry/cancellation branches are readable. The lower `Revise draft` branch and
the notification/archive split are separated well enough to understand the
process at a glance.

No urgent issue was found here. Keep this fixture as a smoke test for:

- ordinary horizontal placement;
- named start/end events;
- named gateway and sequence-flow labels;
- a simple lower-track branch;
- a loop returning to an earlier task.

## Fixture: `collaboration-lanes-messages.bpmn`

**Assessment: pool separation is good; the newly-added lanes expose the
untested lane-emitting branch of collaboration DI generation (see #38).**

The two pools and the dashed message-flow routing are still compact and
readable, as before. Each participant now also carries two lanes (added to
close a corpus coverage gap: pools and lanes previously never co-occurred in
any fixture, so the lane-emitting branch of `createCollaborationDi`
(`di-creation.ts:152-186`) ran nowhere in the corpus). With that branch now
exercised, `nix develop --command python3 tools/bpmn_feedback.py check`
reports real §8 L1 defects that this fixture previously could not surface:

- `Catch_Confirmation`'s label escapes both its lane (`Lane_Customer_Fulfilment`)
  and its participant (`Participant_Customer`).
- `MessageFlow_Order` and `MessageFlow_Confirmation` cross lane bands they do
  not belong to (`Lane_Customer_Fulfilment`, `Lane_Supplier_Intake`).
- Several lane/participant label boxes overlap each other and the lane bands
  themselves (L2).

These were not visible before this fixture had lanes; they are open work, not
something this corpus-coverage change attempted to fix. Preserve the pool
separation and message-flow routing as the baseline to protect while fixing
the lane-label and message-flow-vs-lane-band defects above.

## Fixture: `data-artifacts.bpmn`

**Assessment: functionally readable, but spatially inefficient.**

The process spine is clear, but `Input document` and `Output store` are placed
as disconnected artifacts in a large empty area below the process. In this
fixture the artifacts do not have associations connecting them to the tasks, so
the disconnected placement is not necessarily incorrect. However, the result
does not communicate whether the artifacts are intentionally detached or simply
not considered by the component packer.

Follow-up:

- Preserve the current behavior if disconnected data artifacts are explicitly
  allowed.
- Otherwise add a separate artifact-packing rule that keeps disconnected data
  objects near the process without pushing the process far away.
- Add an association-bearing fixture before changing this behavior; otherwise
  there is no evidence for the desired placement of connected data.

## Fixture: `gateways-branches-loops.bpmn`

**Assessment: highest-priority routing issue.**

This graph contains the `Need review?` and `Accepted?` exclusive gateways, a
retry loop from `Revise draft` back to `Review draft`, a cancellation branch,
and a parallel split/join.

Observed issues:

- The direct `no` route from `Gateway_ReviewNeeded` to `Task_Publish` is sent
  through a channel above the main spine. It is readable in isolation, but its
  label and line are visually detached from the gateway decision and consume
  an unnecessarily large top margin.
- The `retry` loop from `Task_Revise` back to `Task_Review` creates a large
  rectangular route under the process. It competes visually with the
  cancellation route and makes the left-side gateway area feel congested.
- The `changes` branch, retry return, and nearby `Review draft`/`Revise draft`
  nodes form a tight cluster. Labels sit close to route bends and node edges,
  particularly around the `Accepted?` gateway.
- The cancellation route descends much farther than the other exception branch
  and leaves a large unused vertical gap. The result is technically
  orthogonal but not balanced.
- The split/join on the right is substantially better than the gateway/loop
  section, so the problem is not all gateway routing; it is specifically
  competing forward, backward, and terminal branches at the same gateway.

Relevant generated elements:

- `Gateway_ReviewNeeded`
- `Flow_NoReview_Publish`
- `Flow_Cancelled`
- `Gateway_Accepted`
- `Flow_Changes_Revise`
- `Flow_Revise_Back_To_Review`

Recommended direction:

- Allocate independent channels for a gateway's forward bypass, terminal
  exception, and loop-back instead of selecting only `above`/`below`.
- Keep the loop channel close enough to the source/target pair that it does not
  become the dominant outer frame of the graph.
- Place edge labels after final route-channel assignment, with a minimum gap
  from bends and neighboring labels.
- Prefer a shorter lower route for the cancellation branch when it does not
  collide with the retry loop.

## Fixture: `stress-dense-routing.bpmn`

**Assessment: stress case exposes the same issue at larger scale.**

This graph combines a three-way validation gateway, a review loop, a parallel
split with three branches, an inclusive merge, long labels, and a shared end
event.

Observed issues:

- `Stress_Reject` is placed above the normal diagram at approximately `y=-50`.
  Its incoming route and the route from `Stress_Reject` to `Stress_End` run
  along the top perimeter. This creates a very wide outer frame instead of a
  compact exception branch.
- The rejection route and the review route leave the same
  `Stress_Decide` gateway through closely related vertical channels. The
  `reject`, `review`, `repair`, and `needs another pass` labels compete around
  the gateway and loop area.
- The review loop (`Stress_Flow_Review_Decide`) travels below the process and
  returns to the gateway. It is legible but consumes most of the diagram's
  vertical height and visually competes with the parallel work below.
- The parallel branch channels are understandable, but the long vertical
  segments from `Stress_Parallel` to `Stress_Audit` and `Stress_Archive`
  amplify the whitespace problem.
- Long task and event labels make the available channel widths much less
  forgiving than in the basic fixture. Labels need more than collision-free
  placement; they need a route segment with enough clear horizontal length.

Relevant generated elements:

- `Stress_Decide`
- `Stress_Reject`
- `Stress_Review`
- `Stress_Repair`
- `Stress_Flow_Review_Decide`
- `Stress_Parallel`
- `Stress_Merge`
- `Stress_End`

Recommended direction:

- Treat long labels as a placement constraint during node/track planning, not
  only during final label placement.
- Avoid placing terminal exception activities at negative coordinates solely to
  obtain an upper route. Prefer an upper track with explicit clearance from
  labels, or use a compact side channel.
- Reserve separate channels for the review back-edge and the parallel branch
  lanes.
- Add a compactness metric later, but do not optimize only for bounding-box
  area: a shorter diagram is not acceptable if it introduces label or route
  collisions.

## Fixture: `boundary-and-subprocesses.bpmn`

**Assessment: boundary-event/subprocess spacing issue.**

This graph has `Boundary_Task`, two attached boundary events, an expanded
`Boundary_SubProcess`, and independent timeout/message branches.

Observed issues:

- The expanded subprocess is laid out with its child flow correctly inside its
  boundary, but the outer container has little visual separation from nearby
  external routes.
- The message boundary event is attached near the top of `Boundary_Task`, and
  its multiline `Message override` label is close to the task, attachment
  symbol, and upper route.
- The timer boundary event and its `Timeout` label are close to the lower
  task edge and the outgoing route. The attachment and label do not read as a
  single clean group.
- The `Review override` branch is routed along the top of the diagram and the
  `Recover timeout` branch along the bottom. This is understandable, but it
  creates a very tall layout for a small central process.
- The external branch routes run close to the subprocess's top/bottom boundary.
  Future changes to subprocess padding or child dimensions are likely to cause
  label/route collisions here.

Relevant generated elements:

- `Boundary_Task`
- `Boundary_NonInterruptingMessage`
- `Boundary_InterruptingTimer`
- `Boundary_SubProcess`
- `Boundary_MessageTask`
- `Boundary_TimeoutTask`

Recommended direction:

- Reserve a label-safe attachment zone around every host with boundary events.
  The zone must include the event symbol, its label, and the first orthogonal
  segment.
- Compute subprocess header padding from attached boundary-event labels rather
  than using only the generic subprocess padding.
- Keep external routes outside the container's label/header clearance area.
- Consider placing short boundary branches on dedicated side channels before
  falling back to full top/bottom perimeter routes.

## Fixture: `subprocess-boundary-data-lanes.bpmn`

**Assessment: strongest evidence of container/lane interaction problems.**

This graph combines requester and automation lanes, an expanded
`SubProcess_Handle`, a timer boundary event, escalation, data object/store
references, and two end events.

Observed issues:

- The rendered bounds extend to a negative top coordinate (`viewBox` starts
  around `y=-10`), indicating that the layout uses routes or nodes outside the
  nominal lane/container area.
- The `Timeout` boundary event is attached to the bottom of the subprocess.
  Its label is placed immediately beside the event and close to the outgoing
  `timeout` route, making the attachment area visually crowded.
- The `Handle request` subprocess title/header, the boundary event, and the
  `Timeout`/`timeout` text compete for the same vertical neighborhood.
- `Task_Escalate` is placed well below/right of the subprocess. The route from
  the boundary event to escalation runs along the outside of the automation
  lane, making the exception path look like it leaves the process even though
  it remains a sequence flow in the same process.
- The disconnected `Order data` and `Inventory store` shapes occupy the lower
  left of the automation lane, increasing the lane height and leaving large
  unused gaps between the actual process and artifacts.
- The normal path from `Task_Submit` to the subprocess requires a long
  downward bend from the requester lane. It is valid-looking, but the lane
  transition is visually heavier than the rest of the process.

Relevant generated elements:

- `Lane_Requester`
- `Lane_Automation`
- `SubProcess_Handle`
- `Boundary_Timeout`
- `Task_Escalate`
- `Data_Order`
- `Store_Inventory`

Recommended direction:

- Make lane boundaries first-class routing obstacles and clearance zones.
- Keep same-process exception routes inside the owning lane/container when
  possible; do not route them along the outside edge merely because the target
  is on another track.
- Add subprocess-header and boundary-label clearance before packing artifacts.
- Separate data-artifact packing from flow-node track assignment so unused
  artifacts do not dictate the exception-route geometry.

## Fixture: `nested-subprocess-exceptions.bpmn`

**Assessment: new fixture, added to close a corpus coverage gap (#38); its
first report already surfaces a real §8 L1 containment defect.**

Added because the corpus had no nesting depth beyond one level, no gateway
branch inside a subprocess, and no `default`/`conditionExpression`/
`errorEventDefinition` semantics anywhere (see the coverage-gap issue for the
full inventory). This fixture nests `SubProcess_Inner` inside
`SubProcess_Outer`, branches on a gateway inside each container, marks a
`default` flow on both gateways, attaches a `conditionExpression` to the
non-default branches, routes an `eventBasedGateway` to a timer/message race,
and ends one branch on an `errorEventDefinition` end event.

`nix develop --command python3 tools/bpmn_feedback.py check` on this fixture
reports:

- ~~`Inner_Flow_Start_Task` and `Inner_Flow_Task_End` (both entirely inside
  `SubProcess_Inner`) intersect the *outer* container `SubProcess_Outer`
  (L1).~~ **Correction (#64):** this was a checker defect, not an engine
  one. `edge_container_intersections` resolved only the *immediate*
  subprocess parent, so at nesting depth 2 an edge wholly inside
  `SubProcess_Inner` never matched `SubProcess_Outer` by direct equality and
  fell through to the blanket intersection check against it -- which is of
  course true, since `SubProcess_Inner` sits entirely inside
  `SubProcess_Outer`. The geometry was correct on every axis; 134 of 153
  such findings across the full corpus were this same false positive.
  Fixed by resolving the full ancestor chain instead of the immediate
  parent alone. This fixture's nesting-depth-2 case now correctly scores
  `edge_container_intersections == 0`.
- `Sub_Flow_Split_Standard`'s label intersects both its own gateway and its
  target task (L2).

Not fixed here (routing/label placement) — this fixture's purpose is to make
defects visible, not to change the routing algorithm in the same change as a
corpus-coverage fix. The containment *checker* defect above was fixed
separately in #64, since it blocked evaluating every other containment
finding in the corpus.

## Fixture: `activity-gateway-vendor-coverage.bpmn`

**Assessment: new fixture, ported from the fixture generator's dead
`activities-gateways`/`extensions` specs (see #36); surfaces a real vendor
extension attribute-stripping defect.**

Added so `receiveTask`, `businessRuleTask`, `complexGateway`, `callActivity`,
and vendor `extensionElements` had a persisted fixture at all -- previously
these existed only in generator code that produced no file on disk. Task- and
process-level vendor attributes (`vendor:assignee`, `vendor:type`,
`vendor:historyTimeToLive`, etc.) round-trip through the layout command with
their namespace prefix intact. But a *namespaced attribute on a custom child
element inside `extensionElements`* does not: `vendor:class` on
`<vendor:taskListener>`, and `vendor:event`/`vendor:expression` on
`<vendor:executionListener>`, come back with the `vendor:` prefix silently
dropped (`class`, `event`, `expression`), while the element's own tag prefix
is preserved. This looks like a `bpmn-moddle` limitation for namespaces with
no registered moddle extension package, not something specific to this
project's routing code -- worth its own investigation before assuming it's
fixable the same way as a layout defect. Not fixed here.

## Tooling issue: fixture self-test contract

The self-test's required-element-type inventory and the persisted fixture set
have since been reconciled (`tools/bpmn_feedback.py`'s `selftest` command
passes as of this review). Keep it that way: run

```sh
nix develop --command python3 tools/bpmn_feedback.py selftest
```

after adding or removing a fixture, and add a matching entry to `regression`'s
`REGRESSION_CHECKS` whenever a new fixture under `fixtures/regression/` pins a
single-concern invariant (see `AGENTS.md`).

## Suggested handoff for a new agent

One coverage gap closed after this review now has its own finding above and
is worth picking up alongside the original priority list:
`collaboration-lanes-messages.bpmn`'s lane-label/message-flow defects.
(`nested-subprocess-exceptions.bpmn`'s reported nesting-depth-2 containment
defect was corrected above -- it was never an engine defect; see #64.)

Otherwise, start with `gateways-branches-loops.bpmn` and
`subprocess-boundary-data-lanes.bpmn`, not with the simple fixtures. Reproduce
the observations by laying out copies and rendering them with
`nix develop --command bpmn-to-image`. Inspect the generated DI for the named
elements above before changing TypeScript.

The first implementation hypothesis should be **explicit clearance-aware
channel allocation**:

1. reserve space for boundary-event symbols and labels;
2. reserve subprocess header/container clearance;
3. assign distinct channels to forward bypasses, terminal exception branches,
   and back-edges;
4. place labels against the final route geometry;
5. re-render all seven fixtures and manually compare the two target fixtures
   plus `stress-dense-routing.bpmn`.

Do not start with fixture-specific offsets. If a change improves one graph but
increases perimeter routes or label crowding in the stress fixture, reject it
in favor of a rule that accounts for route class, container clearance, and
label size together.
