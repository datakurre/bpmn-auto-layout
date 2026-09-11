/**
 * Edge and node label placement for BPMN DI generation.
 *
 * Provides:
 *  - `computeEdgeLabelBounds`  — places a named sequence-flow label on the
 *    best available segment of the edge's waypoint polyline.
 *  - `solveLabelPlacement`     — places a named event/gateway label by
 *    evaluating a ranked list of candidate positions and choosing the first
 *    that does not collide with lanes, elements, or already-placed labels.
 *  - `fanOutAttachPoints`      — spreads multiple attach points on the same
 *    node side so they don't draw as a single overlapping line.
 *  - `ensureOrthogonalWaypoints` — removes non-axis-aligned intermediate
 *    waypoints by inserting corrective bend points.
 */

import type { NodeLayout, ProcessLayoutResult } from "./layout-types";
import {
  LABEL_SLIDE_SLACK,
  NODE_LABEL_GAP,
  SNUG_LABEL_GAP,
  GATEWAY_LABEL_GAP,
  EDGE_LABEL_GAP,
} from "./element-dimensions";
import { warn, type LayoutWarning } from "./layout-warnings";

export interface LabelBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function segmentIntersectsBox(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
  margin = 4,
): boolean {
  const minX = bx - margin;
  const maxX = bx + bw + margin;
  const minY = by - margin;
  const maxY = by + bh + margin;
  if (x1 >= minX && x1 <= maxX && y1 >= minY && y1 <= maxY) return true;
  if (x2 >= minX && x2 <= maxX && y2 >= minY && y2 <= maxY) return true;
  const dx = x2 - x1;
  const dy = y2 - y1;
  let tEnter = 0;
  let tExit = 1;
  if (dx === 0) {
    if (x1 < minX || x1 > maxX) return false;
  } else {
    const t1 = (minX - x1) / dx;
    const t2 = (maxX - x1) / dx;
    tEnter = Math.max(tEnter, Math.min(t1, t2));
    tExit = Math.min(tExit, Math.max(t1, t2));
    if (tEnter > tExit) return false;
  }
  if (dy === 0) {
    if (y1 < minY || y1 > maxY) return false;
  } else {
    const t1 = (minY - y1) / dy;
    const t2 = (maxY - y1) / dy;
    tEnter = Math.max(tEnter, Math.min(t1, t2));
    tExit = Math.min(tExit, Math.max(t1, t2));
    if (tEnter > tExit) return false;
  }
  return tEnter <= tExit;
}

/** Checks against routed edge segments (previously misnamed
 * labelCollidesWithLanes). Lane/pool/subprocess containment is a separate
 * constraint -- see containedIn. */
function labelCollidesWithEdges(
  bounds: LabelBounds,
  edgeWaypoints: Map<string, Array<{ x: number; y: number }>>,
  margin = 4,
): boolean {
  for (const pts of edgeWaypoints.values()) {
    for (let i = 0; i < pts.length - 1; i += 1) {
      const p1 = pts[i];
      const p2 = pts[i + 1];
      if (
        p1 &&
        p2 &&
        segmentIntersectsBox(p1.x, p1.y, p2.x, p2.y, bounds.x, bounds.y, bounds.width, bounds.height, margin)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Whether `container` (an expanded subprocess) should be skipped as a
 * collision obstacle for a label belonging to `ownerId`: only when the
 * label's own owner lives inside that container. A label placed for a node
 * elsewhere in the diagram must still avoid landing on top of the
 * container's box (see #14); containment for a label whose owner *is*
 * inside it is a separate constraint (see #15), not a collision exemption.
 */
function isOwnContainer(container: NodeLayout, ownerId: string, nodes: Map<string, NodeLayout>): boolean {
  return container.element?.$type === "bpmn:SubProcess" && nodes.get(ownerId)?.containerId === container.id;
}

function labelCollidesWithElements(
  bounds: LabelBounds,
  targetId: string,
  nodes: Map<string, NodeLayout>,
): boolean {
  for (const node of nodes.values()) {
    if (node.id === targetId) continue;
    if (isOwnContainer(node, targetId, nodes)) continue;
    if (
      bounds.x < node.x + node.width &&
      node.x < bounds.x + bounds.width &&
      bounds.y < node.y + node.height &&
      node.y < bounds.y + bounds.height
    ) {
      return true;
    }
  }
  return false;
}

function labelCollidesWithOtherLabels(bounds: LabelBounds, placedLabels: LabelBounds[]): boolean {
  for (const other of placedLabels) {
    if (
      bounds.x < other.x + other.width &&
      other.x < bounds.x + bounds.width &&
      bounds.y < other.y + other.height &&
      other.y < bounds.y + bounds.height
    ) {
      return true;
    }
  }
  return false;
}

function boxOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Whether `bounds` fits entirely inside `container` -- the owning pool,
 * lane, or subprocess a label's target node (or, for an edge label, its
 * flow's source node) belongs to. No container (a standalone process with
 * no lanes) means no constraint (see #15).
 */
function containedIn(bounds: LabelBounds, container?: LabelBounds): boolean {
  if (!container) return true;
  return (
    bounds.x >= container.x &&
    bounds.y >= container.y &&
    bounds.x + bounds.width <= container.x + container.width &&
    bounds.y + bounds.height <= container.y + container.height
  );
}

// ---------------------------------------------------------------------------
// Text sizing helpers
// ---------------------------------------------------------------------------

function estimateTextLines(text: string, width: number): number {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 1;
  let lines = 1;
  let currentLineWidth = 0;
  const avgCharWidth = 6.8;
  const spaceWidth = 4;
  for (const word of words) {
    const wordWidth = word.length * avgCharWidth;
    if (currentLineWidth === 0) {
      currentLineWidth = wordWidth;
    } else if (currentLineWidth + spaceWidth + wordWidth <= width) {
      currentLineWidth += spaceWidth + wordWidth;
    } else {
      lines += 1;
      currentLineWidth = wordWidth;
    }
  }
  return lines;
}

function formatTextForLines(text: string, width: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= 1) return text;
  let currentLineWidth = 0;
  const avgCharWidth = 6.8;
  const spaceWidth = 4;
  const lines: string[][] = [[]];
  for (const word of words) {
    const wordWidth = word.length * avgCharWidth;
    const last = lines[lines.length - 1]!;
    if (last.length === 0) {
      last.push(word);
      currentLineWidth = wordWidth;
    } else if (currentLineWidth + spaceWidth + wordWidth <= width) {
      last.push(word);
      currentLineWidth += spaceWidth + wordWidth;
    } else {
      lines.push([word]);
      currentLineWidth = wordWidth;
    }
  }
  return lines.map((l) => l.join(" ")).join("\n");
}

function getCandidateWidthsForNode(name: string, isGateway: boolean): number[] {
  const clean = name.replace(/\s+/g, " ").trim();
  const words = clean.split(" ");
  if (!isGateway) {
    const initialLines = estimateTextLines(clean, 90);
    return initialLines >= 2 ? [90, 105, 120, 80] : [90, 80, 70];
  }
  if (words.length <= 1 || clean.length <= 9) {
    const tightW = Math.max(30, Math.round(clean.length * 6.8) + 8);
    return [tightW, 60, 80];
  }
  const twoLineWidths: number[] = [];
  for (let w = 40; w <= 140; w += 2) {
    if (estimateTextLines(clean, w) === 2) twoLineWidths.push(w);
  }
  if (twoLineWidths.length > 0) {
    const min2 = twoLineWidths[0]!;
    const med2 = twoLineWidths[Math.floor(twoLineWidths.length / 2)]!;
    const max2 = twoLineWidths[twoLineWidths.length - 1]!;
    return Array.from(new Set([min2, med2, max2, 70, 80]));
  }
  for (let w = 150; w <= 240; w += 10) {
    if (estimateTextLines(clean, w) <= 2) return [w, w + 10];
  }
  return [90, 105, 120];
}

// ---------------------------------------------------------------------------
// Label-collision-aware pick
// ---------------------------------------------------------------------------

/**
 * Returns the first candidate that clears every element and every label
 * already placed; failing that, whichever overlaps least, so a crowded diagram
 * degrades to "slightly close" rather than "printed on top of a task".
 */
function pickLabel(
  candidates: LabelBounds[],
  fallback: LabelBounds,
  flow: any,
  placedLabels: LabelBounds[],
  nodes: Map<string, NodeLayout>,
  edgeWaypoints: Map<string, Array<{ x: number; y: number }>> = new Map(),
  warnings?: LayoutWarning[],
): LabelBounds {
  const crossedByEdge = (bounds: LabelBounds): number => {
    let crossings = 0;
    for (const [flowId, pts] of edgeWaypoints) {
      if (flowId === flow?.id) continue;
      for (let i = 0; i < pts.length - 1; i += 1) {
        const a = pts[i]!;
        const b = pts[i + 1]!;
        if (Math.abs(a.y - b.y) < 0.5) {
          if (a.y <= bounds.y || a.y >= bounds.y + bounds.height) continue;
          if (
            Math.max(Math.min(a.x, b.x), bounds.x) <
            Math.min(Math.max(a.x, b.x), bounds.x + bounds.width)
          )
            crossings += 1;
        } else if (Math.abs(a.x - b.x) < 0.5) {
          if (a.x <= bounds.x || a.x >= bounds.x + bounds.width) continue;
          if (
            Math.max(Math.min(a.y, b.y), bounds.y) <
            Math.min(Math.max(a.y, b.y), bounds.y + bounds.height)
          )
            crossings += 1;
        }
      }
    }
    return crossings;
  };

  const shapeOverlapArea = (bounds: LabelBounds): number => {
    let area = 0;
    for (const node of nodes.values()) {
      const isOwnEndpoint = node.id === flow?.sourceRef?.id || node.id === flow?.targetRef?.id;
      if (isOwnEndpoint) continue;
      if (isOwnContainer(node, flow?.sourceRef?.id, nodes)) continue;
      area += boxOverlap(bounds, node);
    }
    for (const other of placedLabels) area += boxOverlap(bounds, other);
    return area;
  };

  const valid = candidates.filter((cand) => cand.x >= 0 && cand.y >= 0);

  // A candidate that crosses another edge is never preferred over one that
  // doesn't, no matter how much shape/label overlap the crossing-free one
  // has -- crossings are a hard constraint here, not a term folded into a
  // single weighted score (see #16). Only when every candidate crosses
  // something does the search fall back to minimizing the old combined
  // score, so the result is still the least-bad option rather than an
  // arbitrary one.
  const crossingFree = valid.filter((cand) => crossedByEdge(cand) === 0);
  if (crossingFree.length > 0) {
    let best = crossingFree[0]!;
    let bestArea = shapeOverlapArea(best);
    for (const cand of crossingFree) {
      const area = shapeOverlapArea(cand);
      if (area === 0) return cand;
      if (area < bestArea) {
        best = cand;
        bestArea = area;
      }
    }
    warn(
      warnings,
      "LABEL_OVERLAPS_ELEMENT",
      flow?.id,
      `edge label for ${flow?.id} overlaps a shape or another label; every candidate free of edge crossings still overlapped something`,
    );
    return best;
  }

  let best = fallback;
  let bestScore = shapeOverlapArea(fallback) + crossedByEdge(fallback) * 120;
  for (const cand of valid) {
    const score = shapeOverlapArea(cand) + crossedByEdge(cand) * 120;
    if (score < bestScore) {
      best = cand;
      bestScore = score;
    }
  }
  warn(
    warnings,
    "LABEL_OVERLAPS_ELEMENT",
    flow?.id,
    `edge label for ${flow?.id} crosses another routed edge; no candidate avoided every edge crossing`,
  );
  return best;
}

// ---------------------------------------------------------------------------
// Public: edge label placement
// ---------------------------------------------------------------------------

export function computeEdgeLabelBounds(
  flow: any,
  waypoints: Array<{ x: number; y: number }>,
  edgeWaypoints: Map<string, Array<{ x: number; y: number }>>,
  placedLabels: LabelBounds[] = [],
  nodes: Map<string, NodeLayout> = new Map(),
  containerBounds?: LabelBounds,
  warnings?: LayoutWarning[],
): LabelBounds | null {
  if (!flow.name || typeof flow.name !== "string" || flow.name.trim().length === 0) return null;
  const text = flow.name.trim();

  interface Seg {
    p1: { x: number; y: number };
    p2: { x: number; y: number };
    len: number;
  }
  const horizSegs: Seg[] = [];
  let vertSeg: Seg | null = null;
  for (let i = 0; i < waypoints.length - 1; i++) {
    const p1 = waypoints[i];
    const p2 = waypoints[i + 1];
    if (!p1 || !p2) continue;
    const isHoriz = p1.y === p2.y;
    const isVert = p1.x === p2.x;
    const len = isHoriz ? Math.abs(p2.x - p1.x) : isVert ? Math.abs(p2.y - p1.y) : 0;
    if (isHoriz && len >= 30) horizSegs.push({ p1, p2, len });
    else if (isVert && len >= 20 && !vertSeg) vertSeg = { p1, p2, len };
  }
  if (horizSegs.length === 0 && !vertSeg) return null;
  // Longest first, so the fallback box (when no candidate anywhere is
  // collision-free) still prefers the most generous segment.
  horizSegs.sort((a, b) => b.len - a.len);

  const width = Math.min(90, Math.max(30, Math.round(text.length * 6.5) + 10));
  const height = 14;
  const edgeLabelGap = EDGE_LABEL_GAP;

  if (horizSegs.length > 0) {
    // Every eligible horizontal segment contributes its own candidates, so
    // a crowded segment can be skipped in favor of a clearer one elsewhere
    // on the same route instead of only ever considering the longest one
    // (see #16).
    const allCandidates: LabelBounds[] = [];
    let fallback = { x: 0, y: 0, width, height };
    horizSegs.forEach((seg, index) => {
      const minX = Math.min(seg.p1.x, seg.p2.x);
      const maxX = Math.max(seg.p1.x, seg.p2.x);
      const midX = (minX + maxX) / 2;

      const hasFlowAbove =
        seg.p1.y <= 0 ||
        Array.from(edgeWaypoints.values()).some((pts) => {
          for (let j = 0; j < pts.length - 1; j++) {
            const q1 = pts[j];
            const q2 = pts[j + 1];
            if (!q1 || !q2) continue;
            if (q1.y === q2.y && q1.y < seg.p1.y && seg.p1.y - q1.y <= 40) {
              const qMinX = Math.min(q1.x, q2.x);
              const qMaxX = Math.max(q1.x, q2.x);
              if (Math.max(minX, qMinX) < Math.min(maxX, qMaxX)) return true;
            }
          }
          return false;
        });

      const primaryY = hasFlowAbove
        ? Math.round(seg.p1.y + 4)
        : Math.round(seg.p1.y - height - edgeLabelGap);
      const altY = hasFlowAbove
        ? Math.round(seg.p1.y - height - edgeLabelGap)
        : Math.round(seg.p1.y + 4);
      const centeredX = midX - width / 2;
      if (index === 0) fallback = { x: centeredX, y: primaryY, width, height };

      const straddled = Array.from(nodes.values()).filter(
        (n) =>
          !isOwnContainer(n, flow?.sourceRef?.id, nodes) &&
          n.x <= maxX + width / 2 &&
          minX - width / 2 <= n.x + n.width &&
          n.y < seg.p1.y + height &&
          seg.p1.y - height < n.y + n.height,
      );
      const clearAbove = straddled.length
        ? Math.min(...straddled.map((n) => n.y)) - height - 4
        : primaryY;
      const clearBelow = straddled.length
        ? Math.max(...straddled.map((n) => n.y + n.height)) + 4
        : altY;

      for (const y of [primaryY, altY, clearAbove, clearBelow]) {
        for (const dx of [0, 20, -20, 40, -40, 60, -60, 80, -80]) {
          const x = centeredX + dx;
          if (x + width / 2 < minX - LABEL_SLIDE_SLACK || x + width / 2 > maxX + LABEL_SLIDE_SLACK) continue;
          allCandidates.push({ x, y, width, height });
        }
      }
    });
    const containedCandidates = allCandidates.filter((c) => containedIn(c, containerBounds));
    if (containerBounds && containedCandidates.length === 0) {
      warn(warnings, "LABEL_ESCAPES_CONTAINER", flow?.id, `edge label for ${flow?.id} could not be placed inside its owning container`);
    }
    return pickLabel(
      containedCandidates.length > 0 ? containedCandidates : allCandidates,
      fallback,
      flow,
      placedLabels,
      nodes,
      edgeWaypoints,
      warnings,
    );
  }

  const seg = vertSeg!;
  const minY = Math.min(seg.p1.y, seg.p2.y);
  const maxY = Math.max(seg.p1.y, seg.p2.y);
  const midY = (minY + maxY) / 2;
  const y = Math.round(midY - height / 2);
  const rightX = Math.round(seg.p1.x + 4);
  const leftX = Math.round(seg.p1.x - width - 4);
  const candidates: LabelBounds[] = [];
  for (const dy of [0, -18, 18, -36, 36]) {
    candidates.push({ x: rightX, y: y + dy, width, height });
    candidates.push({ x: leftX, y: y + dy, width, height });
  }
  const containedCandidates = candidates.filter((c) => containedIn(c, containerBounds));
  if (containerBounds && containedCandidates.length === 0) {
    warn(warnings, "LABEL_ESCAPES_CONTAINER", flow?.id, `edge label for ${flow?.id} could not be placed inside its owning container`);
  }
  return pickLabel(
    containedCandidates.length > 0 ? containedCandidates : candidates,
    { x: rightX, y, width, height },
    flow,
    placedLabels,
    nodes,
    edgeWaypoints,
    warnings,
  );
}

// ---------------------------------------------------------------------------
// Public: node label placement
// ---------------------------------------------------------------------------

/**
 * A default label box for `node`, derived only from its own geometry and
 * text -- no flow-direction or collision information required. Used both
 * as solveLabelPlacement's last-resort default and, before routing runs, as
 * a provisional obstacle so routes can avoid the space a label will very
 * likely occupy (see #30). The real, collision-aware box solveLabelPlacement
 * computes once routes exist may differ; this is a heuristic reservation,
 * not a guarantee.
 */
export function estimateDefaultLabelBounds(node: NodeLayout, preferredTop = false): LabelBounds {
  const name = node.element.name || "";
  const isGateway = node.element.$type.endsWith("Gateway");
  const defaultW = 90;
  const defaultLines = estimateTextLines(name, defaultW);
  const defaultH = defaultLines === 1 ? (isGateway ? 14 : 20) : defaultLines === 2 ? 27 : defaultLines * 14;
  const y = preferredTop
    ? Math.round(node.y - defaultH - NODE_LABEL_GAP)
    : Math.round(node.y + node.height + NODE_LABEL_GAP);
  return { x: Math.round(node.centerX - defaultW / 2), y, width: defaultW, height: defaultH };
}

export function solveLabelPlacement(
  node: NodeLayout,
  edgeWaypoints: Map<string, Array<{ x: number; y: number }>>,
  nodes: Map<string, NodeLayout>,
  placedLabels: LabelBounds[],
  containerBounds?: LabelBounds,
  warnings?: LayoutWarning[],
): LabelBounds {
  const name = node.element.name || "";
  const isGateway = node.element.$type.endsWith("Gateway");
  const boundaryHost = node.element.attachedToRef?.id
    ? nodes.get(node.element.attachedToRef.id)
    : undefined;
  const isBoundary = node.element.$type === "bpmn:BoundaryEvent" && Boolean(boundaryHost);

  let hasTopFlow = false;
  let hasBottomFlow = false;
  let hasLeftFlow = false;
  let hasRightFlow = false;
  for (const [flowId, pts] of edgeWaypoints.entries()) {
    if (!pts || pts.length === 0) continue;
    const flow = (node.element.incoming || [])
      .concat(node.element.outgoing || [])
      .find((f: any) => f.id === flowId);
    if (!flow) continue;
    const startPt = pts[0];
    const endPt = pts[pts.length - 1];
    if (flow.sourceRef?.id === node.id && startPt) {
      if (startPt.y < node.centerY - 5) hasTopFlow = true;
      else if (startPt.y > node.centerY + 5) hasBottomFlow = true;
      else if (startPt.x < node.centerX - 5) hasLeftFlow = true;
      else if (startPt.x > node.centerX + 5) hasRightFlow = true;
    }
    if (flow.targetRef?.id === node.id && endPt) {
      if (endPt.y < node.centerY - 5) hasTopFlow = true;
      else if (endPt.y > node.centerY + 5) hasBottomFlow = true;
      else if (endPt.x < node.centerX - 5) hasLeftFlow = true;
      else if (endPt.x > node.centerX + 5) hasRightFlow = true;
    }
  }

  let preferredTop = false;
  if (isGateway && hasBottomFlow && !hasTopFlow) preferredTop = true;

  const isFourDir = isGateway && hasTopFlow && hasBottomFlow && hasLeftFlow && hasRightFlow;
  const isLeftFree = isGateway && hasTopFlow && hasBottomFlow && !hasLeftFlow;
  const isRightFree = isGateway && hasTopFlow && hasBottomFlow && !hasRightFlow;

  const candidateWidths = getCandidateWidthsForNode(name, isGateway);
  const candidates: Array<LabelBounds & { lines: number }> = [];

  for (const W of candidateWidths) {
    const formatted = formatTextForLines(name, W);
    const lineArray = formatted.split("\n");
    const lines = lineArray.length;
    const maxLineChars = Math.max(...lineArray.map((l) => l.length));
    const tightW = isGateway ? Math.max(30, Math.min(W, Math.round(maxLineChars * 6.8) + 8)) : W;
    const H = lines === 1 ? (isGateway ? 14 : 20) : lines === 2 ? 27 : lines * 14;
    const gap = NODE_LABEL_GAP;
    const snugOffset = isGateway ? 0 : 2;
    const snugGap = SNUG_LABEL_GAP;
    const gatewayGap = GATEWAY_LABEL_GAP;

    const primaryY = preferredTop
      ? Math.round(node.y - H - gap)
      : Math.round(node.y + node.height + gap);
    const gatewayPrimaryY = preferredTop
      ? Math.round(node.y - (lines > 1 ? H : 14) - gatewayGap)
      : Math.round(node.y + node.height + gatewayGap);
    const gatewayAltY = preferredTop
      ? Math.round(node.y + node.height + gatewayGap)
      : Math.round(node.y - 14 - gatewayGap);

    if (!isGateway) {
      if (isBoundary && boundaryHost) {
        const outwardTop = node.centerY < boundaryHost.centerY;
        const outwardY = outwardTop
          ? Math.round(node.y - H - 6)
          : Math.round(node.y + node.height + 6);
        for (const dx of [0, -20, 20, -40, 40]) {
          candidates.push({
            x: Math.round(node.centerX - tightW / 2 + dx),
            y: outwardY,
            width: tightW,
            height: H,
            lines,
          });
        }
      }
      candidates.push({
        x: Math.round(node.centerX - tightW / 2),
        y: primaryY,
        width: tightW,
        height: H,
        lines,
      });
      continue;
    }

    if (isFourDir) {
      candidates.push(
        { x: Math.round(node.centerX - tightW - snugGap), y: Math.round(node.y - H + snugOffset), width: tightW, height: H, lines },
        { x: Math.round(node.centerX + snugGap), y: Math.round(node.y - H + snugOffset), width: tightW, height: H, lines },
        { x: Math.round(node.centerX - tightW - snugGap), y: Math.round(node.y + node.height - snugOffset), width: tightW, height: H, lines },
        { x: Math.round(node.centerX + snugGap), y: Math.round(node.y + node.height - snugOffset), width: tightW, height: H, lines },
      );
    } else if (isLeftFree) {
      candidates.push(
        { x: Math.round(node.x - tightW - snugGap), y: Math.round(node.centerY - H / 2), width: tightW, height: H, lines },
        { x: Math.round(node.centerX - tightW - 2), y: Math.round(node.y - H + snugOffset), width: tightW, height: H, lines },
      );
    } else if (isRightFree) {
      candidates.push(
        { x: Math.round(node.x + node.width + snugGap), y: Math.round(node.centerY - H / 2), width: tightW, height: H, lines },
        { x: Math.round(node.centerX + 2), y: Math.round(node.y - H + snugOffset), width: tightW, height: H, lines },
      );
    } else {
      candidates.push(
        { x: Math.round(node.centerX - tightW / 2), y: gatewayPrimaryY, width: tightW, height: H, lines },
      );
      for (const dx of [20, -20, 40, -40, 60, -60]) {
        candidates.push({ x: Math.round(node.centerX - tightW / 2 + dx), y: gatewayPrimaryY, width: tightW, height: H, lines });
      }
      candidates.push({ x: Math.round(node.centerX - tightW / 2), y: gatewayAltY, width: tightW, height: H, lines });
      for (const dx of [20, -20, 40, -40]) {
        candidates.push({ x: Math.round(node.centerX - tightW / 2 + dx), y: gatewayAltY, width: tightW, height: H, lines });
      }
      candidates.push(
        { x: Math.round(node.centerX - tightW - snugGap), y: Math.round(node.y - H + snugOffset), width: tightW, height: H, lines },
        { x: Math.round(node.centerX + snugGap), y: Math.round(node.y - H + snugOffset), width: tightW, height: H, lines },
        { x: Math.round(node.centerX - tightW - snugGap), y: Math.round(node.y + node.height - snugOffset), width: tightW, height: H, lines },
        { x: Math.round(node.centerX + snugGap), y: Math.round(node.y + node.height - snugOffset), width: tightW, height: H, lines },
        { x: Math.round(node.x - tightW - snugGap), y: Math.round(node.centerY - H / 2), width: tightW, height: H, lines },
        { x: Math.round(node.x + node.width + snugGap), y: Math.round(node.centerY - H / 2), width: tightW, height: H, lines },
      );
    }
  }

  // Choose first candidate with no collisions, fully inside the node's own
  // pool/lane/subprocess. Containment outranks edge-crossing avoidance
  // (§8: container containment before no-overlap), so it is enforced in
  // both this pass and the edge-collision-relaxed fallback below.
  let chosen: (LabelBounds & { lines: number }) | null = null;
  for (const cand of candidates) {
    if (cand.x < 10 || cand.y < 0) continue;
    if (!containedIn(cand, containerBounds)) continue;
    if (labelCollidesWithEdges(cand, edgeWaypoints)) continue;
    if (labelCollidesWithElements(cand, node.id, nodes)) continue;
    if (labelCollidesWithOtherLabels(cand, placedLabels)) continue;
    chosen = cand;
    break;
  }
  // Fallback: ignore edge collision, keep containment
  if (!chosen) {
    for (const cand of candidates) {
      if (cand.x < 10 || cand.y < 0) continue;
      if (!containedIn(cand, containerBounds)) continue;
      if (labelCollidesWithElements(cand, node.id, nodes)) continue;
      if (labelCollidesWithOtherLabels(cand, placedLabels)) continue;
      chosen = cand;
      break;
    }
    if (chosen) {
      warn(warnings, "LABEL_OVERLAPS_ELEMENT", node.id, `label for ${node.id} crosses a routed edge; no candidate cleared both containment and edge avoidance`);
    }
  }
  // Fallback: no candidate fits inside the container at all (e.g. a lane
  // too narrow for the text) -- accept the least-bad element/label-free
  // candidate instead of forcing the unconstrained default box below.
  if (!chosen) {
    for (const cand of candidates) {
      if (cand.x < 10 || cand.y < 0) continue;
      if (labelCollidesWithElements(cand, node.id, nodes)) continue;
      if (labelCollidesWithOtherLabels(cand, placedLabels)) continue;
      chosen = cand;
      break;
    }
    if (chosen) {
      warn(warnings, "LABEL_ESCAPES_CONTAINER", node.id, `label for ${node.id} could not be placed inside its owning container; no contained candidate was free of element/label collisions`);
    }
  }
  if (!chosen) {
    const fallbackBounds = estimateDefaultLabelBounds(node, preferredTop);
    chosen = { ...fallbackBounds, lines: estimateTextLines(name, fallbackBounds.width) };
    warn(warnings, "LABEL_OVERLAPS_ELEMENT", node.id, `label for ${node.id} fell back to its unchecked default position; no candidate was free of element/label collisions`);
  }

  return { x: chosen.x, y: chosen.y, width: chosen.width, height: chosen.height };
}

// ---------------------------------------------------------------------------
// Public: fan out attach points
// ---------------------------------------------------------------------------

/**
 * Spread the attach points of each crowded node side across that side, and
 * move the neighbouring waypoint with them so the polyline stays orthogonal.
 */
export function fanOutAttachPoints(
  edgeWaypoints: Map<string, Array<{ x: number; y: number }>>,
  layout: ProcessLayoutResult,
): void {
  interface Attach {
    flowId: string;
    index: number;
  }
  const bySide = new Map<string, Attach[]>();

  for (const flow of layout.allFlows) {
    const pts = edgeWaypoints.get(flow.id);
    if (!pts || pts.length < 2) continue;
    for (const [index, nodeId] of [
      [0, flow.sourceRef?.id],
      [pts.length - 1, flow.targetRef?.id],
    ] as Array<[number, string]>) {
      const node = layout.nodes.get(nodeId);
      const p = pts[index];
      if (!node || !p) continue;
      let side: string | null = null;
      if (Math.abs(p.y - node.y) < 0.5) side = "top";
      else if (Math.abs(p.y - (node.y + node.height)) < 0.5) side = "bottom";
      else if (Math.abs(p.x - node.x) < 0.5) side = "left";
      else if (Math.abs(p.x - (node.x + node.width)) < 0.5) side = "right";
      if (!side) continue;
      const key = `${nodeId}:${side}`;
      (bySide.get(key) ?? bySide.set(key, []).get(key)!).push({ flowId: flow.id, index });
    }
  }

  for (const [key, attaches] of bySide) {
    if (attaches.length < 2) continue;
    const [nodeId, side] = key.split(":") as [string, string];
    const node = layout.nodes.get(nodeId);
    if (!node) continue;
    const horizontalSide = side === "top" || side === "bottom";
    const extent = horizontalSide ? node.width : node.height;
    const step = extent / 2 / (attaches.length + 1);
    const start = (horizontalSide ? node.x : node.y) + extent / 4 + step;
    attaches.sort((a, b) => a.flowId.localeCompare(b.flowId));
    attaches.forEach((attach, i) => {
      const pts = edgeWaypoints.get(attach.flowId)!;
      const coord = start + i * step;
      const neighbour = attach.index === 0 ? pts[1] : pts[pts.length - 2];
      const point = pts[attach.index]!;
      if (horizontalSide) {
        if (neighbour && Math.abs(neighbour.x - point.x) < 0.5) neighbour.x = coord;
        point.x = coord;
      } else {
        if (neighbour && Math.abs(neighbour.y - point.y) < 0.5) neighbour.y = coord;
        point.y = coord;
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Public: orthogonal waypoint normalizer
// ---------------------------------------------------------------------------

export function ensureOrthogonalWaypoints(
  points: Array<{ x: number; y: number }>,
): Array<{ x: number; y: number }> {
  const result: Array<{ x: number; y: number }> = [];
  for (const point of points) {
    const previous = result[result.length - 1];
    if (previous && previous.x !== point.x && previous.y !== point.y) {
      result.push({ x: point.x, y: previous.y });
    }
    if (!previous || previous.x !== point.x || previous.y !== point.y) result.push(point);
  }
  return result;
}
