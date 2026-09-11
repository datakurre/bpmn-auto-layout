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

/**
 * Maps every flow node id to the bounds of the leaf lane band that owns it
 * (a node belongs to exactly one leaf lane, per BPMN's flowNodeRef).  Used
 * to constrain label placement to the node's own lane (see #15).
 */
export function leafLaneBoundsByNodeId(
  bands: LaneBand[],
): Map<string, { x: number; y: number; width: number; height: number }> {
  const result = new Map<string, { x: number; y: number; width: number; height: number }>();
  for (const band of bands) {
    if ((band.lane.childLaneSet?.lanes?.length ?? 0) > 0) continue;
    for (const ref of band.lane.flowNodeRef || []) {
      result.set(ref.id, { x: band.x, y: band.y, width: band.width, height: band.height });
    }
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

/** Thickness of a lane-divider / pool-border obstacle strip. */
const BOUNDARY_STRIP_THICKNESS = 6;

function boundaryObstacle(id: string, x: number, y: number, width: number, height: number): NodeLayout {
  return {
    id,
    element: { $type: "bpmn:ContainerBoundary" },
    col: 0,
    track: 0,
    x,
    y,
    width,
    height,
    centerX: x + width / 2,
    centerY: y + height / 2,
  };
}

/**
 * Routing obstacles for a set of lane bands: a thin strip along the top and
 * bottom edge of every band (i.e. every lane divider, including the
 * outermost edges). The lane interior is deliberately not an obstacle --
 * flow nodes live there and routes must be free to move through it (#11).
 */
export function laneDividerObstacles(bands: LaneBand[]): NodeLayout[] {
  const obstacles: NodeLayout[] = [];
  bands.forEach((band, index) => {
    obstacles.push(
      boundaryObstacle(
        `lane-divider-${index}-top`,
        band.x,
        band.y - BOUNDARY_STRIP_THICKNESS / 2,
        band.width,
        BOUNDARY_STRIP_THICKNESS,
      ),
      boundaryObstacle(
        `lane-divider-${index}-bottom`,
        band.x,
        band.y + band.height - BOUNDARY_STRIP_THICKNESS / 2,
        band.width,
        BOUNDARY_STRIP_THICKNESS,
      ),
    );
  });
  return obstacles;
}

/**
 * Routing obstacles for a participant (pool) box: thin strips along the top,
 * bottom, and right border, and a solid block over the left-edge name-label
 * gutter (`gutterWidth`). The interior is not an obstacle (#11).
 */
export function participantBoundaryObstacles(
  bounds: { x: number; y: number; width: number; height: number },
  gutterWidth: number,
): NodeLayout[] {
  const { x, y, width, height } = bounds;
  const t = BOUNDARY_STRIP_THICKNESS;
  return [
    boundaryObstacle("pool-top", x, y - t / 2, width, t),
    boundaryObstacle("pool-bottom", x, y + height - t / 2, width, t),
    boundaryObstacle("pool-right", x + width - t / 2, y, t, height),
    boundaryObstacle("pool-caption", x, y, gutterWidth, height),
  ];
}
