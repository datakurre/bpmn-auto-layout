/**
 * Order-preserving alignment mode (#70): given a diagram that already has
 * DI, move shapes and their edges onto a fine grid and merge near-duplicate
 * positions -- without re-deciding topology, ordering, or routing. That is
 * the entire scope: no re-layering, no re-ordering, no re-routing around
 * obstacles (mode (a)'s job, in node-placement.ts / process-routing.ts).
 *
 * Contract (see docs/bpmn-layout-rules.json's layout.align.* rules):
 * - relative order of shape centers is preserved on both axes;
 * - the one thresholded decision in this mode -- when two centers are close
 *   enough to be "meant to be equal" -- is fixed, documented, and
 *   deterministic (ALIGN_CLUSTER_THRESHOLD), not derived from anything that
 *   varies with unrelated edits;
 * - running it twice equals running it once (idempotent): a diagram this
 *   mode has already aligned is already clustered and grid-snapped, so a
 *   second pass computes the same deltas (zero) and changes nothing.
 */
import type { NodeLayout } from "./layout-types";
import type { ResolvedLayoutOptions } from "./element-dimensions";
import type { RoutePoint } from "./process-routing";
import { dedupeConsecutivePoints } from "./process-routing";
import { ensureOrthogonalWaypoints } from "./label-placement";
import { importPlane } from "./di-import";

/**
 * Two centers this close on one axis are treated as "meant to be equal" and
 * assigned the exact same aligned value, rather than each independently
 * snapped to the grid and possibly landing on different grid lines. Two
 * centers already exactly equal are within this threshold for free (a
 * zero-width group is within any positive threshold), which is what keeps a
 * shape pair that already shares a row or column sharing it after
 * alignment -- the common case needs no special handling, only this one.
 */
export const ALIGN_CLUSTER_THRESHOLD = 10;

/**
 * Bucket sorted distinct values into contiguous groups whose span never
 * exceeds `threshold`, and assign every value in a group its mean, rounded
 * to `gridSize`. Deterministic: fixed threshold, sequential scan, no
 * seed and no data-dependent tie-break beyond numeric order.
 */
function clusterAxisValues(values: number[], threshold: number, gridSize: number): Map<number, number> {
  const distinct = [...new Set(values)].sort((a, b) => a - b);
  const result = new Map<number, number>();
  let groupStart = 0;
  for (let i = 1; i <= distinct.length; i += 1) {
    const closesGroup = i === distinct.length || distinct[i]! - distinct[groupStart]! > threshold;
    if (!closesGroup) continue;
    const group = distinct.slice(groupStart, i);
    const mean = group.reduce((sum, value) => sum + value, 0) / group.length;
    const target = Math.round(mean / gridSize) * gridSize;
    for (const value of group) result.set(value, target);
    groupStart = i;
  }
  return result;
}

/**
 * Per-axis alignment deltas for every node. Independent per axis, per #70's
 * gaps-vs-grid-canonical rule having no bearing here: that rule is about
 * mode (a)'s 120px column pitch competing with exact 50px flow gaps, a
 * conflict that does not exist for this mode's much finer alignment grid.
 */
export function computeAlignmentDeltas(
  nodes: NodeLayout[],
  opts: ResolvedLayoutOptions,
): { dx: Map<string, number>; dy: Map<string, number> } {
  const xTargets = clusterAxisValues(nodes.map((n) => n.centerX), ALIGN_CLUSTER_THRESHOLD, opts.gridSize);
  const yTargets = clusterAxisValues(nodes.map((n) => n.centerY), ALIGN_CLUSTER_THRESHOLD, opts.gridSize);
  const dx = new Map<string, number>();
  const dy = new Map<string, number>();
  for (const node of nodes) {
    dx.set(node.id, (xTargets.get(node.centerX) ?? node.centerX) - node.centerX);
    dy.set(node.id, (yTargets.get(node.centerY) ?? node.centerY) - node.centerY);
  }
  return { dx, dy };
}

/**
 * Build a per-axis offset function from a delta at the polyline's start
 * value to a delta at its end value, interpolating by the POINT'S OWN
 * coordinate on that axis rather than by its index in the array. This is
 * what keeps a run of collinear points collinear: any two points that
 * share the same x (a vertical segment) get the exact same x-offset,
 * because the offset is a pure function of x, so they still share the same
 * x afterward. Interpolating by index instead -- offset blended from 0% at
 * the first point to 100% at the last, regardless of each point's own
 * coordinate -- breaks exactly this: two points on the same vertical
 * segment at different positions along the polyline would receive
 * different x-offsets and stop sharing an x, turning the segment diagonal.
 * When start and end share the same value on this axis (the delta has
 * nothing to interpolate against), every point gets the average of the two
 * endpoint deltas -- exact when they agree, a reasonable single value when
 * they do not.
 */
function axisOffset(
  startValue: number,
  endValue: number,
  startDelta: number,
  endDelta: number,
): (value: number) => number {
  if (startValue === endValue) {
    const constant = (startDelta + endDelta) / 2;
    return () => constant;
  }
  return (value) => startDelta + ((endDelta - startDelta) * (value - startValue)) / (endValue - startValue);
}

/**
 * Stretch an existing waypoint polyline to follow its endpoints' new
 * positions, preserving the route's overall shape -- how many bends it has
 * and which segments are collinear -- rather than re-deriving it from
 * scratch, which is (a)'s job (computeWaypoints / repairSegmentCollisions).
 * Re-orthogonalizes afterward since a shift can leave an interior bend
 * very slightly off axis when the polyline visits the same coordinate more
 * than once (e.g. a loop-back that returns near its own path); in the
 * common case (both endpoints moved onto the same shared row/column they
 * already shared) no correction is needed and no point is added.
 */
export function stretchWaypoints(
  points: RoutePoint[],
  srcDelta: { dx: number; dy: number },
  tgtDelta: { dx: number; dy: number },
): RoutePoint[] {
  if (points.length === 0) return points;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const offsetX = axisOffset(first.x, last.x, srcDelta.dx, tgtDelta.dx);
  const offsetY = axisOffset(first.y, last.y, srcDelta.dy, tgtDelta.dy);
  const stretched = points.map((point) => ({
    x: point.x + offsetX(point.x),
    y: point.y + offsetY(point.y),
  }));
  return dedupeConsecutivePoints(ensureOrthogonalWaypoints(stretched));
}

const NO_DELTA = { dx: 0, dy: 0 };

/**
 * Container shapes whose bounds are derived from their contents (lane-layout.ts
 * for Lane, di-creation.ts for Participant and the SubProcess container size
 * itself) rather than independently positioned. Aligning one the same way as
 * an ordinary flow node moved its bounds independently of whatever it
 * contains, which both breaks containment and made two successive alignment
 * passes disagree with each other (a container's own center depends on which
 * other shapes happen to be in its clustering group, and that group can
 * shift once the first pass has already moved things) -- v1 leaves them
 * untouched rather than getting either wrong. Recomputing a container's
 * bounds from its (aligned) contents is deferred future work, not attempted
 * here.
 */
const CONTAINER_ELEMENT_TYPES = new Set(["bpmn:Lane", "bpmn:Participant", "bpmn:SubProcess"]);

/** Whether `element` is nested inside an expanded SubProcess (at any depth).
 * Its DI position is only meaningful relative to that container's own
 * position, which v1 does not move -- see CONTAINER_ELEMENT_TYPES. */
function isNestedInSubProcess(element: any): boolean {
  let current = element?.$parent;
  while (current) {
    if (current.$type === "bpmn:SubProcess") return true;
    current = current.$parent;
  }
  return false;
}

/**
 * Align one bpmndi:BPMNPlane in place: mutate its shapes' dc:Bounds and its
 * edges' waypoints to the deltas computeAlignmentDeltas derives from the
 * plane's own current geometry. `createPoint` constructs a replacement
 * dc:Point when a waypoint's point count changes (moddle needs a
 * constructor, not a plain object, to serialize correctly); existing point
 * objects are mutated in place when the count is unchanged, preserving
 * their identity.
 */
export function alignPlane(
  plane: any,
  opts: ResolvedLayoutOptions,
  createPoint: (point: RoutePoint) => any,
): void {
  const imported = importPlane(plane);
  if (!imported) return;
  const nodes = [...imported.layout.nodes.values()].filter(
    (node) => !CONTAINER_ELEMENT_TYPES.has(node.element.$type) && !isNestedInSubProcess(node.element),
  );
  const { dx, dy } = computeAlignmentDeltas(nodes, opts);

  const diByElementId = new Map<string, any>();
  for (const di of plane.planeElement ?? []) {
    if (di.bpmnElement?.id) diByElementId.set(di.bpmnElement.id, di);
  }

  for (const node of nodes) {
    const ndx = dx.get(node.id) ?? 0;
    const ndy = dy.get(node.id) ?? 0;
    if (ndx === 0 && ndy === 0) continue;
    const bounds = diByElementId.get(node.id)?.bounds;
    if (!bounds) continue;
    bounds.x = Math.round((bounds.x + ndx) * 100) / 100;
    bounds.y = Math.round((bounds.y + ndy) * 100) / 100;
  }

  for (const [flowId, points] of imported.edgeWaypoints) {
    const flowDi = diByElementId.get(flowId);
    const flowElement = flowDi?.bpmnElement;
    const sourceId = flowElement?.sourceRef?.id;
    const targetId = flowElement?.targetRef?.id;
    if (!sourceId || !targetId) continue;
    const srcDelta = sourceId ? { dx: dx.get(sourceId) ?? 0, dy: dy.get(sourceId) ?? 0 } : NO_DELTA;
    const tgtDelta = targetId ? { dx: dx.get(targetId) ?? 0, dy: dy.get(targetId) ?? 0 } : NO_DELTA;
    if (srcDelta.dx === 0 && srcDelta.dy === 0 && tgtDelta.dx === 0 && tgtDelta.dy === 0) continue;
    const stretched = stretchWaypoints(points, srcDelta, tgtDelta).map((point) => ({
      x: Math.round(point.x),
      y: Math.round(point.y),
    }));
    if (stretched.length === (flowDi.waypoint ?? []).length) {
      flowDi.waypoint.forEach((wp: any, index: number) => {
        wp.x = stretched[index]!.x;
        wp.y = stretched[index]!.y;
      });
    } else {
      flowDi.waypoint = stretched.map(createPoint);
    }
  }
}
