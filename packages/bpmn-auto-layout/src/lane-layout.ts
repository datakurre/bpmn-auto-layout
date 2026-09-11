/**
 * Lane DI band partitioning.
 *
 * Computes non-overlapping, full-width lane bands (including nested lanes
 * from childLaneSet, and lanes with no member nodes) from a laneSet and the
 * already-placed flow nodes. Shared by the standalone-process and
 * collaboration DI generators so lane bounds and labels are computed the
 * same way in both places.
 */
import type { NodeLayout } from "./layout-types";

export interface LaneBand {
  lane: any;
  depth: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

const LANE_PAD = 30;
const MIN_LANE_HEIGHT = 60;
const DEFAULT_LANE_HEIGHT = 120;

function laneMemberIds(lane: any): string[] {
  const own = (lane.flowNodeRef || []).map((ref: any) => ref.id);
  const nested: string[] = (lane.childLaneSet?.lanes || []).flatMap(laneMemberIds);
  return own.concat(nested);
}

function laneExtent(
  lane: any,
  nodesById: Map<string, NodeLayout>,
): { minY: number; maxY: number } | null {
  const members = laneMemberIds(lane)
    .map((id) => nodesById.get(id))
    .filter((node): node is NodeLayout => Boolean(node && !node.isSubProcessChild));
  if (members.length === 0) return null;
  return {
    minY: Math.min(...members.map((node) => node.y)),
    maxY: Math.max(...members.map((node) => node.y + node.height)),
  };
}

/**
 * Minimum band height a lane needs: for a lane with childLaneSet, the sum
 * of its children's own required heights (recursively), so a parent band
 * is never sized smaller than what its nested lanes need. For a leaf lane,
 * its member extent (or a reserved default when it has no members).
 */
function requiredHeight(lane: any, nodesById: Map<string, NodeLayout>): number {
  const children = lane.childLaneSet?.lanes;
  if (children && children.length > 0) {
    return children.reduce((sum: number, child: any) => sum + requiredHeight(child, nodesById), 0);
  }
  const extent = laneExtent(lane, nodesById);
  if (!extent) return DEFAULT_LANE_HEIGHT;
  return Math.max(MIN_LANE_HEIGHT, extent.maxY - extent.minY + 2 * LANE_PAD);
}

interface PartitionContext {
  nodesById: Map<string, NodeLayout>;
  xSpan: { x: number; width: number };
  depth: number;
  out: LaneBand[];
}

/**
 * Partition `lanes` (siblings from one laneSet or childLaneSet) into
 * contiguous, non-overlapping bands spanning [y0, y1] vertically and the
 * full `xSpan` horizontally, then recurse into any childLaneSet. A lane
 * with no member nodes still gets a reserved default-height band instead
 * of being dropped.
 */
function partitionLanes(lanes: any[], y0: number, y1: number, ctx: PartitionContext): void {
  if (lanes.length === 0) return;
  const { nodesById, xSpan, depth, out } = ctx;
  const extents = lanes.map((lane) => laneExtent(lane, nodesById));

  let cursor = y0;
  const bands: Array<{ top: number; height: number }> = [];
  lanes.forEach((lane, index) => {
    const extent = extents[index];
    const isLast = index === lanes.length - 1;
    const top = extent ? Math.max(cursor, extent.minY - LANE_PAD) : cursor;
    let bottom = top + requiredHeight(lane, nodesById);
    if (isLast) bottom = Math.max(bottom, y1);
    bands.push({ top, height: bottom - top });
    cursor = bottom;
  });

  lanes.forEach((lane, index) => {
    const band = bands[index]!;
    out.push({ lane, depth, x: xSpan.x, y: band.top, width: xSpan.width, height: band.height });
    const children = lane.childLaneSet?.lanes;
    if (children && children.length > 0) {
      partitionLanes(children, band.top, band.top + band.height, { ...ctx, depth: depth + 1 });
    }
  });
}

/**
 * Compute DI bands for every lane declared in `laneSets` (top-level plus
 * nested childLaneSet lanes), partitioning `xSpan`/`ySpan`. Returns an empty
 * array when there are no lanes.
 */
export function computeLaneBands(
  laneSets: any[],
  nodesById: Map<string, NodeLayout>,
  xSpan: { x: number; width: number },
  ySpan: { y: number; height: number },
): LaneBand[] {
  const out: LaneBand[] = [];
  for (const laneSet of laneSets || []) {
    partitionLanes(laneSet.lanes || [], ySpan.y, ySpan.y + ySpan.height, { nodesById, xSpan, depth: 0, out });
  }
  return out;
}

/**
 * Maps every flow node id to the sequential document-order index of the
 * (leaf) lane it belongs to: lane 0 is the first lane declared, lane 1 the
 * next, and so on, continuing across multiple laneSets and recursing into
 * childLaneSet so nested lanes each get their own index too. Used as a
 * track-assignment hint so nodes in different lanes are not conflated.
 */
export function leafLaneOrderIndex(laneSets: any[]): Map<string, number> {
  const result = new Map<string, number>();
  let index = 0;
  const visit = (lane: any): void => {
    const children = lane.childLaneSet?.lanes;
    if (children && children.length > 0) {
      for (const child of children) visit(child);
      return;
    }
    for (const ref of lane.flowNodeRef || []) {
      result.set(ref.id, index);
    }
    index += 1;
  };
  for (const laneSet of laneSets || []) {
    for (const lane of laneSet.lanes || []) visit(lane);
  }
  return result;
}

/** The bottom-most Y reached by any band, or ySpan's bottom if there are none. */
export function laneBandsBottom(bands: LaneBand[], fallback: number): number {
  return bands.length === 0 ? fallback : Math.max(...bands.map((band) => band.y + band.height));
}

/** Bounds for a lane's name label: a narrow strip along its left edge, the
 * same convention bpmn-js/Camunda Modeler use for a rotated lane title. */
export function laneLabelBounds(band: LaneBand): { x: number; y: number; width: number; height: number } {
  return { x: band.x + 3, y: band.y + band.height / 2 - 10, width: 20, height: Math.max(20, band.height - 20) };
}
