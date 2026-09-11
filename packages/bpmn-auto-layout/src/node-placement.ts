/**
 * Node placement — spine detection, track/column assignment, coordinate
 * computation, subprocess child layout, and component packing.
 *
 * This module has no dependency on edge routing or DI creation.
 */

import type { NodeLayout, ProcessLayoutResult } from "./layout-types";
import type { ResolvedLayoutOptions } from "./element-dimensions";
import { leafLaneOrderIndex } from "./lane-layout";
import {
  DEFAULT_FLOW_GAP,
  COMPONENT_GAP,
  LANDSCAPE_A4_RATIO,
  getElementDimensions,
} from "./element-dimensions";

/**
 * Snap node centers to the semantic column grid when close enough, then apply
 * diagram-js-compatible 10 px quantization to both axes.
 */
export function snapNodesToGrid(
  nodes: Map<string, NodeLayout>,
  colWidth: number,
  gridSize = 10,
): void {
  for (const node of nodes.values()) {
    const snappedCenterX = 75 + Math.round((node.centerX - 75) / colWidth) * colWidth;
    const dx = snappedCenterX - node.centerX;
    // Preserve fractional placement used to keep edge-to-edge spacing even;
    // only remove insignificant floating-point drift from the grid.
    if (Math.abs(dx) >= 2) continue;
    node.x += dx;
    node.centerX += dx;
  }
  for (const node of nodes.values()) {
    const centerX = Math.round(node.centerX / gridSize) * gridSize;
    const centerY = Math.round(node.centerY / gridSize) * gridSize;
    node.centerX = centerX;
    node.centerY = centerY;
    node.x = centerX - node.width / 2;
    node.y = centerY - node.height / 2;
  }
}

/**
 * Pack disconnected top-level components after their local layout is known.
 * Keeping this as a translation step means sequence-flow routing can continue
 * to use the existing track/column rules inside each component.
 */
export function packIndependentComponents(
  nodes: Map<string, NodeLayout>,
  topNodes: any[],
  topFlows: any[],
  mainNodeId: string | undefined,
): void {
  if (topNodes.length < 2 || !mainNodeId) return;

  // Union-Find to identify connected components
  const parent = new Map<string, string>();
  for (const node of topNodes) parent.set(node.id, node.id);
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (parent.get(id) !== id) {
      const next = parent.get(id)!;
      parent.set(id, root);
      id = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const ar = find(a);
    const br = find(b);
    if (ar !== br) parent.set(br, ar);
  };

  for (const flow of topFlows) {
    const source = flow.sourceRef?.id;
    const target = flow.targetRef?.id;
    if (source && target && parent.has(source) && parent.has(target)) union(source, target);
  }

  const components = new Map<string, any[]>();
  for (const node of topNodes) {
    const key = find(node.id);
    (components.get(key) ?? components.set(key, []).get(key)!).push(node);
  }
  const mainKey = find(mainNodeId);
  const secondary = [...components.entries()]
    .filter(([key]) => key !== mainKey)
    .map(([, members]) => members);
  if (secondary.length === 0) return;

  const idsFor = (members: any[]): Set<string> => {
    const ids = new Set<string>();
    const visit = (element: any): void => {
      if (element?.id) ids.add(element.id);
      for (const child of element?.flowElements || []) {
        if (child.$type !== "bpmn:SequenceFlow") visit(child);
      }
    };
    members.forEach(visit);
    return ids;
  };
  const boundsOf = (ids: Set<string>) => {
    const placed = [...nodes.values()].filter((node) => ids.has(node.id));
    return {
      minX: Math.min(...placed.map((node) => node.x)),
      minY: Math.min(...placed.map((node) => node.y)),
      maxX: Math.max(...placed.map((node) => node.x + node.width)),
      maxY: Math.max(...placed.map((node) => node.y + node.height)),
    };
  };

  const mainBounds = boundsOf(idsFor(components.get(mainKey)!));
  const secondaryData = secondary.map((members) => {
    const ids = idsFor(members);
    return { ids, bounds: boundsOf(ids) };
  });
  const totalSecondaryWidth =
    secondaryData.reduce((sum, item) => sum + item.bounds.maxX - item.bounds.minX, 0) +
    COMPONENT_GAP * Math.max(0, secondaryData.length - 1);
  const maxSecondaryWidth = Math.max(
    ...secondaryData.map((item) => item.bounds.maxX - item.bounds.minX),
  );
  const totalSecondaryHeight =
    secondaryData.reduce((sum, item) => sum + item.bounds.maxY - item.bounds.minY, 0) +
    COMPONENT_GAP * Math.max(0, secondaryData.length - 1);

  const sideWidth = mainBounds.maxX - mainBounds.minX + COMPONENT_GAP + maxSecondaryWidth;
  const sideHeight = Math.max(mainBounds.maxY - mainBounds.minY, totalSecondaryHeight);
  const belowWidth = Math.max(mainBounds.maxX - mainBounds.minX, totalSecondaryWidth);
  const belowHeight =
    mainBounds.maxY -
    mainBounds.minY +
    COMPONENT_GAP +
    Math.max(...secondaryData.map((item) => item.bounds.maxY - item.bounds.minY));
  const score = (width: number, height: number): number => {
    const ratio = width / Math.max(1, height);
    return Math.abs(Math.log(ratio / LANDSCAPE_A4_RATIO)) + (width * height) / 1_000_000_000;
  };
  // Small disconnected artifacts (data references, annotations, and similar
  // nodes) read better as a compact row below the process than as a distant
  // second column beside it.
  const below =
    totalSecondaryWidth <= (mainBounds.maxX - mainBounds.minX) * 0.75 ||
    belowWidth < sideWidth ||
    score(belowWidth, belowHeight) <= score(sideWidth, sideHeight);

  if (below) {
    let x = mainBounds.minX;
    const y = mainBounds.maxY + COMPONENT_GAP;
    for (const item of secondaryData) {
      const width = item.bounds.maxX - item.bounds.minX;
      const dx = x - item.bounds.minX;
      const dy = y - item.bounds.minY;
      for (const node of nodes.values())
        if (item.ids.has(node.id)) {
          node.x += dx;
          node.y += dy;
          node.centerX += dx;
          node.centerY += dy;
        }
      x += width + COMPONENT_GAP;
    }
  } else {
    const x = mainBounds.maxX + COMPONENT_GAP;
    let y = mainBounds.minY;
    for (const item of secondaryData) {
      const dx = x - item.bounds.minX;
      const dy = y - item.bounds.minY;
      for (const node of nodes.values())
        if (item.ids.has(node.id)) {
          node.x += dx;
          node.y += dy;
          node.centerX += dx;
          node.centerY += dy;
        }
      y += item.bounds.maxY - item.bounds.minY + COMPONENT_GAP;
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers scoped to computeProcessLayout
// ---------------------------------------------------------------------------

function detectBackEdges(
  topNodes: any[],
  outgoingFlows: Map<string, any[]>,
  nodesById: Map<string, any>,
  startNode: any,
): Set<string> {
  const visited = new Set<string>();
  const onStack = new Set<string>();
  const backEdges = new Set<string>();

  function dfs(nodeId: string): void {
    visited.add(nodeId);
    onStack.add(nodeId);
    for (const flow of outgoingFlows.get(nodeId) || []) {
      const targetId = flow.targetRef?.id;
      if (!targetId || !nodesById.has(targetId)) continue;
      if (onStack.has(targetId)) {
        backEdges.add(flow.id);
      } else if (!visited.has(targetId)) {
        dfs(targetId);
      }
    }
    onStack.delete(nodeId);
  }

  if (startNode) dfs(startNode.id);
  // Also visit any nodes that weren't reachable from the start event
  for (const node of topNodes) {
    if (!visited.has(node.id)) dfs(node.id);
  }
  return backEdges;
}

/**
 * Nodes reachable forward from `nodeId` (inclusive), following only
 * non-back-edge outgoing flows. Removing back edges leaves a DAG, so this is
 * a plain memoized DFS with no cycle guard needed.
 */
function computeForwardReachability(
  nodeId: string,
  outgoingFlows: Map<string, any[]>,
  backEdges: Set<string>,
  memo: Map<string, Set<string>>,
): Set<string> {
  const cached = memo.get(nodeId);
  if (cached) return cached;
  const visited = new Set<string>([nodeId]);
  for (const flow of outgoingFlows.get(nodeId) || []) {
    if (backEdges.has(flow.id)) continue;
    const targetId = flow.targetRef?.id;
    if (!targetId) continue;
    for (const id of computeForwardReachability(targetId, outgoingFlows, backEdges, memo)) {
      visited.add(id);
    }
  }
  memo.set(nodeId, visited);
  return visited;
}

function selectSpine(
  startNode: any,
  outgoingFlows: Map<string, any[]>,
  nodesById: Map<string, any>,
  backEdges: Set<string>,
): { spineNodeIds: string[]; spineSet: Set<string> } {
  const spineNodeIds: string[] = [];
  const spineSet = new Set<string>();
  const reachabilityMemo = new Map<string, Set<string>>();

  // Prefer the branch with the most work ahead of it -- the number of nodes
  // still reachable going forward -- over one that names its intent. A
  // branch that terminates immediately (an EndEvent target) scores lowest,
  // which is what we want without needing to know it was called "reject".
  // Ties (e.g. two branches that both merge into the same join) keep flow
  // document order via a stable sort, exactly as before.
  const flowSpineScore = (flow: any): number => {
    const targetNode = nodesById.get(flow.targetRef?.id);
    if (!targetNode) return -1;
    return computeForwardReachability(targetNode.id, outgoingFlows, backEdges, reachabilityMemo)
      .size;
  };

  let curr: string | undefined = startNode?.id;
  while (curr && !spineSet.has(curr)) {
    spineSet.add(curr);
    spineNodeIds.push(curr);
    const outs = (outgoingFlows.get(curr) || []).filter((f) => !backEdges.has(f.id));
    if (outs.length === 0) break;
    if (outs.length === 1) {
      curr = outs[0].targetRef?.id;
      continue;
    }
    const sorted = [...outs].sort((a, b) => flowSpineScore(b) - flowSpineScore(a));
    curr = (sorted[0] ?? outs[0]).targetRef?.id;
  }

  return { spineNodeIds, spineSet };
}

/**
 * Whether `flow` represents an exception/alternative branch, using only
 * signals the modeller actually asserted about the graph: leaving a boundary
 * event, ending in an error/escalation, or being a gateway's non-default
 * branch. Never inspects `flow.name` -- a locale-bound label a modeller can
 * rename without changing the process at all is not a structural signal
 * (see #12).
 */
function isStructuralExceptionBranch(flow: any, sourceNode: any, targetNode: any): boolean {
  if (sourceNode?.$type === "bpmn:BoundaryEvent") return true;
  if (targetNode?.$type?.endsWith("EndEvent")) {
    const eventDefinitions = targetNode.eventDefinitions || [];
    if (
      eventDefinitions.some((def: any) =>
        ["bpmn:ErrorEventDefinition", "bpmn:EscalationEventDefinition"].includes(def.$type),
      )
    )
      return true;
  }
  if (sourceNode?.$type?.endsWith("Gateway") && sourceNode.default) {
    return flow.id !== sourceNode.default.id;
  }
  return false;
}

function buildTrackColMapsWithDim(
  topNodes: any[],
  topFlows: any[],
  spineNodeIds: string[],
  spineSet: Set<string>,
  outgoingFlows: Map<string, any[]>,
  nodesById: Map<string, any>,
  backEdges: Set<string>,
  colWidth: number,
  dimensionOf: (node: any) => { width: number; height: number } = getElementDimensions,
  preferredTracks: Map<string, number> = new Map(),
): { nodeTrack: Map<string, number>; nodeCol: Map<string, number> } {
  const nodeTrack = new Map<string, number>();
  const nodeCol = new Map<string, number>();

  // Shift a node and all its forward descendants to a new column minimum.
  function shiftNodeAndDescendants(id: string, newCol: number): void {
    const oldCol = nodeCol.get(id) || 0;
    if (newCol <= oldCol) return;
    nodeCol.set(id, newCol);
    const dim = dimensionOf(nodesById.get(id));
    const span = Math.max(1, Math.ceil(dim.width / colWidth));
    for (const flow of outgoingFlows.get(id) || []) {
      if (backEdges.has(flow.id)) continue;
      const targetId = flow.targetRef?.id;
      if (targetId && nodeCol.has(targetId)) {
        shiftNodeAndDescendants(targetId, newCol + span);
      }
    }
  }

  // Assign spine nodes to track 0
  let col = 0;
  for (let index = 0; index < spineNodeIds.length; index += 1) {
    const id = spineNodeIds[index]!;
    nodeTrack.set(id, preferredTracks.get(id) ?? 0);
    nodeCol.set(id, col);
    const node = nodesById.get(id);
    const dim = dimensionOf(node);
    const next =
      index + 1 < spineNodeIds.length ? nodesById.get(spineNodeIds[index + 1]!) : undefined;
    if (next) {
      const nextWidth = dimensionOf(next).width;
      col +=
        dim.width / (2 * colWidth) + DEFAULT_FLOW_GAP / colWidth + nextWidth / (2 * colWidth);
    }
  }

  // BFS from spine to assign off-spine branches
  const queue = [...spineNodeIds];
  for (const boundary of topNodes.filter((node) => node.$type === "bpmn:BoundaryEvent")) {
    const host = boundary.attachedToRef?.id ? nodesById.get(boundary.attachedToRef.id) : undefined;
    const hostTrack = host ? nodeTrack.get(host.id) : undefined;
    const hostCol = host ? nodeCol.get(host.id) : undefined;
    if (hostTrack === undefined || hostCol === undefined) continue;
    nodeTrack.set(boundary.id, hostTrack);
    nodeCol.set(boundary.id, hostCol);
    for (const flow of outgoingFlows.get(boundary.id) || []) {
      const targetId = flow.targetRef?.id;
      if (!targetId || nodeTrack.has(targetId)) continue;
      nodeTrack.set(targetId, hostTrack - 1);
      nodeCol.set(targetId, hostCol + 1);
      queue.push(targetId);
    }
  }
  while (queue.length > 0) {
    const parentId = queue.shift()!;
    const parentCol = nodeCol.get(parentId)!;
    const parentTrack = nodeTrack.get(parentId)!;
    const parentDim = dimensionOf(nodesById.get(parentId));

    for (const flow of outgoingFlows.get(parentId) || []) {
      if (backEdges.has(flow.id)) continue;
      const targetId = flow.targetRef?.id;
      if (!targetId || !nodesById.has(targetId)) continue;
      const targetDim = dimensionOf(nodesById.get(targetId));
      const minTargetCol =
        parentCol +
        (parentDim.width + targetDim.width) / (2 * colWidth) +
        DEFAULT_FLOW_GAP / colWidth;

      if (!nodeTrack.has(targetId)) {
        let targetTrack = preferredTracks.get(targetId) ?? parentTrack;
        const targetNode = nodesById.get(targetId);
        const isExceptionBranch = isStructuralExceptionBranch(
          flow,
          nodesById.get(parentId),
          targetNode,
        );
        const isTerminalExceptionBranch = isExceptionBranch && targetNode?.$type === "bpmn:EndEvent";
        const isUpwardExceptionBranch = isExceptionBranch && !isTerminalExceptionBranch;
        if (spineSet.has(parentId) && !spineSet.has(targetId)) {
          const isSpannedByBackEdge = Array.from(backEdges).some((bId) => {
            const bFlow = topFlows.find((f) => f.id === bId);
            if (!bFlow) return false;
            const bSrcCol = nodeCol.get(bFlow.sourceRef?.id);
            const bTgtCol = nodeCol.get(bFlow.targetRef?.id);
            if (bSrcCol !== undefined && bTgtCol !== undefined) {
              return bTgtCol <= parentCol && parentCol <= bSrcCol;
            }
            return false;
          });
          targetTrack = isUpwardExceptionBranch
            ? parentTrack - 1
            : isSpannedByBackEdge
              ? -1
              : parentTrack + 1;
        }

        nodeTrack.set(targetId, targetTrack);
        const targetCol =
          targetTrack > parentTrack && isUpwardExceptionBranch
            ? Math.max(0, parentCol - 1)
            : Math.max(minTargetCol, nodeCol.get(targetId) ?? 0);
        nodeCol.set(targetId, targetCol);
        queue.push(targetId);
      } else {
        if (nodeCol.get(targetId)! < minTargetCol) {
          shiftNodeAndDescendants(targetId, minTargetCol);
        }
      }
    }
  }

  // Orphan nodes (not reachable from start event)
  let maxCol = Math.max(0, ...Array.from(nodeCol.values()));
  for (const node of topNodes) {
    if (!nodeCol.has(node.id)) {
      maxCol += 1;
      nodeCol.set(node.id, maxCol);
      nodeTrack.set(node.id, 0);
    }
  }

  // Prevent same-track overlap using actual half-widths in column units
  const tracksUsed = new Set(nodeTrack.values());
  for (const t of tracksUsed) {
    const nodesOnTrack = topNodes
      .filter((n) => nodeTrack.get(n.id) === t)
      .sort((a, b) => nodeCol.get(a.id)! - nodeCol.get(b.id)!);
    const colGap = DEFAULT_FLOW_GAP / colWidth;
    let lastRightEdge = -Infinity;
    for (const n of nodesOnTrack) {
      const dim = dimensionOf(n);
      const halfSpan = dim.width / colWidth / 2;
      let currentCol = nodeCol.get(n.id)!;
      if (currentCol - halfSpan < lastRightEdge + colGap) {
        const neededCol = lastRightEdge + colGap + halfSpan;
        if (neededCol > currentCol) {
          shiftNodeAndDescendants(n.id, neededCol);
          currentCol = neededCol;
        }
      }
      lastRightEdge = currentCol + halfSpan;
    }
  }

  // Keep terminals close to their predecessor (avoid stranding an end node in a
  // distant corridor needed by another branch)
  for (const endNode of topNodes.filter((n) => n.$type.endsWith("EndEvent"))) {
    const incoming = topFlows.find((flow) => flow.targetRef?.id === endNode.id);
    const source = incoming ? nodesById.get(incoming.sourceRef?.id) : undefined;
    if (!source) continue;
    const track = nodeTrack.get(endNode.id);
    if (track === undefined || track <= 0 || track !== nodeTrack.get(source.id)) continue;
    const sourceCol = nodeCol.get(source.id);
    if (sourceCol === undefined) continue;
    const sourceSpan = dimensionOf(source).width / colWidth;
    let candidate = sourceCol + sourceSpan + DEFAULT_FLOW_GAP / colWidth;
    const endSpan = dimensionOf(endNode).width / colWidth;
    while (
      topNodes.some((node) => {
        if (node.id === endNode.id || nodeTrack.get(node.id) !== track) return false;
        const nodeColValue = nodeCol.get(node.id);
        if (nodeColValue === undefined) return false;
        const nodeSpan = dimensionOf(node).width / colWidth;
        return Math.abs(nodeColValue - candidate) < (nodeSpan + endSpan) / 2 + 0.4;
      })
    ) {
      candidate += 1;
    }
    nodeCol.set(endNode.id, candidate);
  }

  // Horizontally align terminal end events across different tracks when
  // unobstructed (within 2 columns)
  const endEvents = topNodes.filter((n) => n.$type.endsWith("EndEvent"));
  if (endEvents.length > 1) {
    const maxEndCol = Math.max(...endEvents.map((n) => nodeCol.get(n.id) ?? 0));
    for (const endNode of endEvents) {
      const currentCol = nodeCol.get(endNode.id) ?? 0;
      if (currentCol < maxEndCol && maxEndCol - currentCol <= 2) {
        const track = nodeTrack.get(endNode.id) ?? 0;
        const hasObstacle = topNodes.some(
          (n) =>
            n.id !== endNode.id &&
            nodeTrack.get(n.id) === track &&
            (nodeCol.get(n.id) ?? 0) >= currentCol &&
            (nodeCol.get(n.id) ?? 0) <= maxEndCol,
        );
        if (!hasObstacle) nodeCol.set(endNode.id, maxEndCol);
      }
    }
  }

  return { nodeTrack, nodeCol };
}

/**
 * Every track sits `trackGap` px from the next, in both directions from the
 * spine (track 0). This is the only rhythm in the diagram: there is no
 * separate spacing for the first branch track vs. later ones, so adding a
 * node that happens to land on a new track never re-spaces the rest of the
 * diagram (see #33).
 */
function computeTrackY(t: number, opts: ResolvedLayoutOptions, extraClearance: number): number {
  return opts.spineY + t * opts.trackGap + extraClearance;
}

/** Padding inside a subprocess/embedded container (left/right, top/bottom). */
const SUBPROCESS_PAD_H = 40;
const SUBPROCESS_PAD_V = 30;

/**
 * Recursively compute the layout of a subprocess's children, derive the
 * container size from the resulting bounding box, and install all child
 * NodeLayout entries (with isSubProcessChild=true) into the parent's
 * layoutNodes map at their absolute canvas positions.
 *
 * Returns the computed { width, height } of the subprocess container so that
 * the caller can place the outer node with the correct size.
 */
function layoutSubProcessChildrenRecursive(
  node: any,
  parentX: number,
  parentY: number,
  track: number,
  layoutNodes: Map<string, NodeLayout>,
  opts: ResolvedLayoutOptions,
): { width: number; height: number } {
  const childNodes = (node.flowElements || []).filter(
    (el: any) => el.$type !== "bpmn:SequenceFlow",
  );
  if (childNodes.length === 0) {
    return { width: 360, height: 200 };
  }

  // Run the full layout algorithm on the subprocess's children in local coords.
  const subResult = computeProcessLayout(node, opts);

  // Determine bounding box of all child nodes in local layout coordinates.
  const placed = Array.from(subResult.nodes.values());
  if (placed.length === 0) {
    return { width: 360, height: 200 };
  }
  const minX = Math.min(...placed.map((n) => n.x));
  const minY = Math.min(...placed.map((n) => n.y));
  const maxX = Math.max(...placed.map((n) => n.x + n.width));
  const maxY = Math.max(...placed.map((n) => n.y + n.height));

  // Derive the subprocess container size from the local bounding box.
  const contentW = maxX - minX;
  const contentH = maxY - minY;
  const containerW = Math.max(360, contentW + SUBPROCESS_PAD_H * 2);
  const containerH = Math.max(200, contentH + SUBPROCESS_PAD_V * 2);

  // Offset to translate from local layout origin to the correct position
  // inside the subprocess container (parent top-left + padding).
  const offsetX =
    Math.round((parentX + SUBPROCESS_PAD_H - minX) / opts.gridSize) * opts.gridSize;
  const offsetY =
    Math.round((parentY + SUBPROCESS_PAD_V - minY) / opts.gridSize) * opts.gridSize;

  // Install children into the parent layoutNodes map at absolute positions.
  for (const childNode of subResult.nodes.values()) {
    layoutNodes.set(childNode.id, {
      ...childNode,
      x: childNode.x + offsetX,
      y: childNode.y + offsetY,
      centerX: childNode.centerX + offsetX,
      centerY: childNode.centerY + offsetY,
      track,
      isSubProcessChild: true,
    });
  }

  return { width: containerW, height: containerH };
}

/**
 * Re-establish the exact DEFAULT_FLOW_GAP edge-to-edge gap for simple
 * same-row chains (single incoming, no node in between) after grid
 * snapping. `snapNodesToGrid` rounds each node's center to the 10 px grid
 * independently, which can perturb the gap the column math already computed
 * by up to 10 px in either direction -- this pass removes that drift instead
 * of leaving it to chance (see #8). It must run *after* snapping: fixing the
 * gap first (as this used to) only for it to be re-perturbed by the later
 * independent rounding defeats the purpose.
 *
 * Flows are processed in ascending source-x order so a correction to one
 * node is what the next one down the same chain measures its own gap
 * against, i.e. a genuine left-to-right pass rather than a per-pair patch.
 */
function enforceFlowGaps(
  layoutNodes: Map<string, NodeLayout>,
  topNodes: any[],
  topFlows: any[],
): void {
  const incomingCount = new Map<string, number>();
  for (const flow of topFlows) {
    const targetId = flow.targetRef?.id;
    if (targetId) incomingCount.set(targetId, (incomingCount.get(targetId) ?? 0) + 1);
  }

  const orderedFlows = [...topFlows].sort(
    (a, b) => (layoutNodes.get(a.sourceRef?.id)?.x ?? 0) - (layoutNodes.get(b.sourceRef?.id)?.x ?? 0),
  );

  for (const flow of orderedFlows) {
    const source = layoutNodes.get(flow.sourceRef?.id);
    const target = layoutNodes.get(flow.targetRef?.id);
    if (
      !source ||
      !target ||
      incomingCount.get(target.id) !== 1 ||
      Math.abs(source.centerY - target.centerY) >= 0.5 ||
      target.x < source.x + source.width
    )
      continue;
    const hasIntermediate = topNodes.some((node: any) => {
      const candidate = layoutNodes.get(node.id);
      return (
        candidate &&
        candidate.id !== source.id &&
        candidate.id !== target.id &&
        Math.abs(candidate.centerY - source.centerY) < 0.5 &&
        candidate.x >= source.x + source.width &&
        candidate.x + candidate.width <= target.x
      );
    });
    if (hasIntermediate) continue;

    const desiredX = source.x + source.width + DEFAULT_FLOW_GAP;
    const dx = desiredX - target.x;
    if (Math.abs(dx) < 0.5) continue;
    const movedIds = new Set<string>();
    const collect = (element: any): void => {
      if (element?.id) movedIds.add(element.id);
      for (const child of element?.flowElements || []) {
        if (child.$type !== "bpmn:SequenceFlow") collect(child);
      }
    };
    collect(target.element);
    for (const node of layoutNodes.values()) {
      if (!movedIds.has(node.id)) continue;
      node.x += dx;
      node.centerX += dx;
    }
  }
}

function attachBoundaryEvents(
  layoutNodes: Map<string, NodeLayout>,
  topNodes: any[],
  topFlows: any[],
): void {
  const boundaryEvents = topNodes.filter((node) => node.$type === "bpmn:BoundaryEvent");
  const byHost = new Map<string, any[]>();
  for (const boundary of boundaryEvents) {
    const hostId = boundary.attachedToRef?.id;
    if (!hostId) continue;
    (byHost.get(hostId) ?? byHost.set(hostId, []).get(hostId)!).push(boundary);
  }

  for (const boundaries of byHost.values()) {
    boundaries.sort((left, right) => left.id.localeCompare(right.id));

    // First pass: decide each boundary event's side (top/bottom) using the
    // existing target-position/alternation heuristic.
    const placements: Array<{ node: NodeLayout; host: NodeLayout; bottom: boolean }> = [];
    boundaries.forEach((boundary, index) => {
      const host = layoutNodes.get(boundary.attachedToRef?.id);
      const node = layoutNodes.get(boundary.id);
      if (!host || !node) return;

      const outgoing = topFlows.find((flow) => flow.sourceRef?.id === boundary.id);
      const target = outgoing ? layoutNodes.get(outgoing.targetRef?.id) : undefined;
      const targetBelow = target ? target.centerY >= host.centerY : false;
      const bottom = targetBelow !== (index % 2 === 1);

      node.track = host.track;
      node.col = host.col;
      placements.push({ node, host, bottom });
    });

    // Second pass: spread every side's boundary events evenly across the
    // host's width instead of stacking them all on host.centerX — two or
    // more events sharing a side would otherwise land on the same point.
    const bySide = new Map<string, typeof placements>();
    for (const placement of placements) {
      const key = `${placement.host.id}:${placement.bottom}`;
      (bySide.get(key) ?? bySide.set(key, []).get(key)!).push(placement);
    }
    for (const group of bySide.values()) {
      const { host, bottom } = group[0]!;
      const centerY = bottom ? host.y + host.height : host.y;
      group.forEach(({ node }, i) => {
        const centerX =
          group.length === 1 ? host.centerX : host.x + (host.width * (i + 1)) / (group.length + 1);
        node.centerX = centerX;
        node.centerY = centerY;
        node.x = centerX - node.width / 2;
        node.y = centerY - node.height / 2;
      });
    }
  }
}

function placeBoundaryBranchesAbove(
  layoutNodes: Map<string, NodeLayout>,
  topNodes: any[],
  topFlows: any[],
  trackGap: number,
): void {
  const outgoingFlows = new Map<string, any[]>();
  const incomingFlows = new Map<string, any[]>();
  for (const flow of topFlows) {
    const sourceId = flow.sourceRef?.id;
    const targetId = flow.targetRef?.id;
    if (sourceId && targetId) {
      (outgoingFlows.get(sourceId) ?? outgoingFlows.set(sourceId, []).get(sourceId)!).push(flow);
      (incomingFlows.get(targetId) ?? incomingFlows.set(targetId, []).get(targetId)!).push(flow);
    }
  }

  for (const boundary of topNodes.filter((node) => node.$type === "bpmn:BoundaryEvent")) {
    const host = layoutNodes.get(boundary.attachedToRef?.id);
    const outgoing = outgoingFlows.get(boundary.id)?.[0];
    const target = outgoing ? layoutNodes.get(outgoing.targetRef?.id) : undefined;
    if (!host || !target || !outgoing) continue;
    const targetIncoming = incomingFlows.get(target.id) || [];
    if (targetIncoming.some((flow) => flow.sourceRef?.id !== boundary.id)) continue;
    const primaryFlow = topFlows.find((flow) => flow.sourceRef?.id === host.id);
    const primaryTarget = primaryFlow ? layoutNodes.get(primaryFlow.targetRef?.id) : undefined;

    const deltaY = host.centerY - trackGap - target.centerY;
    const deltaX =
      primaryTarget && target.centerX < primaryTarget.centerX
        ? primaryTarget.centerX - target.centerX
        : 0;
    target.x += deltaX;
    target.centerX += deltaX;
    target.y += deltaY;
    target.centerY += deltaY;
    target.track = host.track - 1;
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function computeProcessLayout(
  process: any,
  opts: ResolvedLayoutOptions,
): ProcessLayoutResult {
  const allFlowElements: any[] = process.flowElements || [];
  const topNodes = allFlowElements.filter((el) => el.$type !== "bpmn:SequenceFlow");
  const topFlows = allFlowElements.filter((el) => el.$type === "bpmn:SequenceFlow");

  const nodesById = new Map<string, any>(topNodes.map((n) => [n.id, n]));
  const incomingFlows = new Map<string, any[]>();
  const outgoingFlows = new Map<string, any[]>();
  for (const node of topNodes) {
    incomingFlows.set(node.id, []);
    outgoingFlows.set(node.id, []);
  }
  for (const flow of topFlows) {
    const src = flow.sourceRef?.id;
    const tgt = flow.targetRef?.id;
    if (src && nodesById.has(src)) outgoingFlows.get(src)!.push(flow);
    if (tgt && nodesById.has(tgt)) incomingFlows.get(tgt)!.push(flow);
  }

  // 0. Pre-compute subprocess child layouts so their sizes are available for
  //    column/track assignment and track-clearance calculation.
  //    These will be re-applied (at absolute coords) after the outer layout.
  const subprocessSizes = new Map<string, { width: number; height: number }>();
  for (const node of topNodes) {
    if (node.$type === "bpmn:SubProcess") {
      const childNodes = (node.flowElements || []).filter(
        (el: any) => el.$type !== "bpmn:SequenceFlow",
      );
      if (childNodes.length === 0) {
        subprocessSizes.set(node.id, { width: 360, height: 200 });
        continue;
      }
      const subResult = computeProcessLayout(node, opts);
      const placed = Array.from(subResult.nodes.values());
      if (placed.length === 0) {
        subprocessSizes.set(node.id, { width: 360, height: 200 });
        continue;
      }
      const minX = Math.min(...placed.map((n) => n.x));
      const minY = Math.min(...placed.map((n) => n.y));
      const maxX = Math.max(...placed.map((n) => n.x + n.width));
      const maxY = Math.max(...placed.map((n) => n.y + n.height));
      const containerW = Math.max(360, (maxX - minX) + SUBPROCESS_PAD_H * 2);
      const containerH = Math.max(200, (maxY - minY) + SUBPROCESS_PAD_V * 2);
      subprocessSizes.set(node.id, { width: containerW, height: containerH });
    }
  }

  /** Get the effective dimensions for a node, using pre-computed subprocess sizes. */
  const effectiveDim = (node: any) => {
    if (node.$type === "bpmn:SubProcess" && subprocessSizes.has(node.id)) {
      return subprocessSizes.get(node.id)!;
    }
    return getElementDimensions(node);
  };

  // 1. Detect back-edges (cycles / loop-backs) via DFS
  const startEvent = topNodes.find((n) => n.$type === "bpmn:StartEvent") || topNodes[0];
  const backEdges = detectBackEdges(topNodes, outgoingFlows, nodesById, startEvent);

  // 2. Identify primary spine (happy path on track 0)
  const { spineNodeIds, spineSet } = selectSpine(startEvent, outgoingFlows, nodesById, backEdges);

  // 3. Track and column assignment — use effectiveDim so subprocess sizes drive spacing
  const { nodeTrack, nodeCol } = buildTrackColMapsWithDim(
    topNodes,
    topFlows,
    spineNodeIds,
    spineSet,
    outgoingFlows,
    nodesById,
    backEdges,
    opts.colWidth,
    effectiveDim,
    leafLaneOrderIndex(process.laneSets || []),
  );

  // 4. Compute pixel coordinates
  const layoutNodes = new Map<string, NodeLayout>();

  const minTrack = Math.min(0, ...Array.from(nodeTrack.values()));
  const spineTrack = minTrack === -1 ? -1 : 0;

  // Per-track extra clearance for taller-than-default elements
  const maxHeightOnTrack = (trackVal: number): number => {
    let max = 80;
    for (const n of topNodes) {
      if (nodeTrack.get(n.id) === trackVal) max = Math.max(max, effectiveDim(n).height);
    }
    return max;
  };
  const distinctTracks = Array.from(new Set(nodeTrack.values())).sort((a, b) => a - b);
  const extraClearanceForTrack = new Map<number, number>([[spineTrack, 0]]);
  let cumExtra = 0;
  let prevTrack = spineTrack;
  for (const trackVal of distinctTracks.filter((tv) => tv > spineTrack)) {
    cumExtra +=
      Math.max(0, maxHeightOnTrack(prevTrack) - 80) / 2 +
      Math.max(0, maxHeightOnTrack(trackVal) - 80) / 2;
    extraClearanceForTrack.set(trackVal, cumExtra);
    prevTrack = trackVal;
  }

  for (const node of topNodes) {
    const c = nodeCol.get(node.id)!;
    const t = nodeTrack.get(node.id)!;
    const dim = effectiveDim(node);
    const centerX = 75 + c * opts.colWidth;
    const centerY = computeTrackY(t, opts, extraClearanceForTrack.get(t) ?? 0);
    const x = centerX - dim.width / 2;
    const y = centerY - dim.height / 2;

    layoutNodes.set(node.id, {
      id: node.id,
      element: node,
      col: c,
      track: t,
      x,
      y,
      width: dim.width,
      height: dim.height,
      centerX,
      centerY,
    });
  }

  packIndependentComponents(layoutNodes, topNodes, topFlows, startEvent?.id);
  snapNodesToGrid(layoutNodes, opts.colWidth, opts.gridSize);
  enforceFlowGaps(layoutNodes, topNodes, topFlows);
  placeBoundaryBranchesAbove(layoutNodes, topNodes, topFlows, opts.trackGap);
  attachBoundaryEvents(layoutNodes, topNodes, topFlows);

  // 5. Now that the outer layout is finalized, install subprocess children
  //    at their absolute positions inside the container.
  for (const node of topNodes) {
    if (node.$type !== "bpmn:SubProcess") continue;
    const parentLayout = layoutNodes.get(node.id);
    if (!parentLayout) continue;
    const track = nodeTrack.get(node.id) ?? 0;
    layoutSubProcessChildrenRecursive(
      node,
      parentLayout.x,
      parentLayout.y,
      track,
      layoutNodes,
      opts,
    );
  }

  // Collect all flows including child subprocess flows (recursively)
  const allFlows: any[] = [...topFlows];
  const collectSubFlows = (elements: any[]): void => {
    for (const el of elements) {
      if (el.$type === "bpmn:SubProcess") {
        for (const child of el.flowElements || []) {
          if (child.$type === "bpmn:SequenceFlow") allFlows.push(child);
          else if (child.$type === "bpmn:SubProcess") collectSubFlows([child]);
        }
      }
    }
  };
  collectSubFlows(topNodes);

  return { nodes: layoutNodes, allFlows };
}
