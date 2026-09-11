/**
 * BPMN DI (Diagram Interchange) generation.
 *
 * Translates the layout result produced by node-placement.ts and the edge
 * waypoints from edge-routing.ts / collision-repair.ts into bpmndi:BPMNShape
 * and bpmndi:BPMNEdge elements attached to the root moddle document.
 */

import type { NodeLayout, ProcessLayoutResult } from "./layout-types";
import { resolveRoutingPolicy } from "./layout-policy";
import type { ResolvedLayoutOptions } from "./element-dimensions";
import {
  computeLaneBands,
  laneBandsBottom,
  laneLabelBounds,
  laneDividerObstacles,
  participantBoundaryObstacles,
  leafLaneBoundsByNodeId,
} from "./lane-layout";
import { repairSegmentCollisions, countRouteHits, validateConnectionPoints } from "./collision-repair";
import { routeProcessFlows, snapRouteWaypoints, dedupeConsecutivePoints } from "./process-routing";
import type { LayoutWarning } from "./layout-warnings";
import {
  ensureOrthogonalWaypoints,
  solveLabelPlacement,
  computeEdgeLabelBounds,
  type LabelBounds,
} from "./label-placement";

/**
 * Minimum distance the finished plane's content is guaranteed to keep from
 * the canvas origin. Diagram-js/bpmn-js render fine with negative
 * coordinates, but several internal passes (label placement's `x < 0` /
 * `y < 0` filters) treat the origin as a hard boundary, so keeping the
 * output non-negative avoids surprising a downstream consumer that makes
 * the same assumption.
 */
const CANVAS_MARGIN = 10;

/**
 * Translate every shape, label, and edge waypoint in `planeElements` so the
 * minimum x/y across the whole plane is at least CANVAS_MARGIN. A pure
 * translation — it cannot disturb any relative geometry (routing, label
 * placement, lane bands, …) already established for this plane, so it is
 * always safe to apply last, right before the plane is serialized.
 */
function normalizePlaneOrigin(planeElements: any[]): void {
  let minX = Infinity;
  let minY = Infinity;
  const bounds: any[] = [];
  const waypointArrays: any[][] = [];
  for (const element of planeElements) {
    if (element.bounds) bounds.push(element.bounds);
    if (element.label?.bounds) bounds.push(element.label.bounds);
    if (element.waypoint) waypointArrays.push(element.waypoint);
  }
  for (const box of bounds) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
  }
  for (const points of waypointArrays) {
    for (const point of points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return;

  const shiftX = minX < CANVAS_MARGIN ? CANVAS_MARGIN - minX : 0;
  const shiftY = minY < CANVAS_MARGIN ? CANVAS_MARGIN - minY : 0;
  if (shiftX === 0 && shiftY === 0) return;

  for (const box of bounds) {
    box.x += shiftX;
    box.y += shiftY;
  }
  for (const points of waypointArrays) {
    for (const point of points) {
      point.x += shiftX;
      point.y += shiftY;
    }
  }
}

/**
 * Returns the set of process IDs that are referenced by any participant in
 * the collaboration, so that createProcessDi can skip those processes.
 */
export function getCollaborationProcessIds(root: any): Set<string> {
  const ids = new Set<string>();
  const collaboration = (root.rootElements || []).find(
    (element: any) => element.$type === "bpmn:Collaboration",
  );
  if (!collaboration) return ids;
  for (const participant of collaboration.participants || []) {
    if (participant.processRef?.id) ids.add(participant.processRef.id);
  }
  return ids;
}

export function createCollaborationDi(
  moddle: any,
  root: any,
  layouts: Map<string, ProcessLayoutResult>,
  opts: ResolvedLayoutOptions,
  warnings?: LayoutWarning[],
): void {
  const collaboration = (root.rootElements || []).find(
    (element: any) => element.$type === "bpmn:Collaboration",
  );
  if (!collaboration || !collaboration.participants?.length) return;

  const planeElements: any[] = [];

  // Per-participant absolute offsets: process-local (x,y) → collaboration-plane (x,y)
  const participantOffsets = new Map<string, { dx: number; dy: number }>();

  // Accumulated across every participant, in plane-absolute coordinates, so
  // message-flow routing can share the same collision-repair pipeline as
  // sequence flows: every flow node (for obstacle avoidance), every pool's
  // container boundary strips, and every already-placed sequence-flow route
  // (so a message flow does not cut across one) (#13).
  const collaborationNodes = new Map<string, NodeLayout>();
  const allContainerObstacles: NodeLayout[] = [];
  const sequenceFlowWaypoints = new Map<string, Array<{ x: number; y: number }>>();
  // Every label already placed for every participant's own nodes/edges, so
  // a message-flow label can avoid them too, not just other message-flow
  // labels (#18).
  const collaborationLabels: LabelBounds[] = [];

  // ── 1. Participant (pool) shapes ─────────────────────────────────────────
  let nextParticipantY = 50;
  for (const participant of collaboration.participants) {
    const process = participant.processRef;
    const layout = process ? layouts.get(process.id) : undefined;
    if (!layout) continue;

    // All top-level nodes (non-subprocess-child) define the content bounding box
    const topNodes: NodeLayout[] = Array.from(layout.nodes.values()).filter(
      (n: NodeLayout) => !n.isSubProcessChild,
    );
    if (topNodes.length === 0) continue;

    const minX = Math.min(...topNodes.map((n) => n.x));
    const minY = Math.min(...topNodes.map((n) => n.y));
    const maxX = Math.max(...topNodes.map((n) => n.x + n.width));
    const maxY = Math.max(...topNodes.map((n) => n.y + n.height));

    // Margins around the content inside the participant box
    const PAD_LEFT = 60;
    const PAD_RIGHT = 30;
    const PAD_TOP = 30;
    const PAD_BOTTOM = 30;

    const participantX = 30;
    const participantY = nextParticipantY;
    const participantW = maxX - minX + PAD_LEFT + PAD_RIGHT;
    let participantH = maxY - minY + PAD_TOP + PAD_BOTTOM;

    // Translation from process-local to collaboration-plane coords
    const dx = Math.round((participantX + PAD_LEFT - minX) / opts.gridSize) * opts.gridSize;
    const dy = Math.round((participantY + PAD_TOP - minY) / opts.gridSize) * opts.gridSize;
    participantOffsets.set(process.id, { dx, dy });

    // Lane DI: partition every lane (including nested childLaneSet lanes
    // and lanes with no member nodes) to fill the participant box to the
    // right of its own label gutter. Computed in plane-absolute coordinates
    // so bands align with the (already dx/dy-shifted) node shapes.
    const LANE_GUTTER = 30;
    const shiftedForLanes = new Map<string, NodeLayout>();
    for (const [id, node] of layout.nodes) {
      shiftedForLanes.set(id, { ...node, x: node.x + dx, y: node.y + dy });
    }
    const laneXSpan = { x: participantX + LANE_GUTTER, width: participantW - LANE_GUTTER };
    const laneYSpan = { y: participantY, height: participantH };
    const laneBands = computeLaneBands(process.laneSets || [], shiftedForLanes, laneXSpan, laneYSpan);
    // Grow the pool to fit its lanes if the lanes (e.g. empty ones needing
    // a reserved default band) need more height than the raw node content.
    participantH = laneBandsBottom(laneBands, participantY + participantH) - participantY;

    const participantBounds = {
      x: participantX,
      y: participantY,
      width: participantW,
      height: participantH,
    };
    // A message flow may attach directly to a pool rather than one of its
    // flow nodes; give it a NodeLayout-shaped entry too so it is usable as a
    // route endpoint the same way a flow node is.
    collaborationNodes.set(participant.id, {
      id: participant.id,
      element: participant,
      col: 0,
      track: 0,
      ...participantBounds,
      centerX: participantBounds.x + participantBounds.width / 2,
      centerY: participantBounds.y + participantBounds.height / 2,
    });

    planeElements.push(
      moddle.create("bpmndi:BPMNShape", {
        id: `${participant.id}_di`,
        bpmnElement: participant,
        isHorizontal: true,
        bounds: moddle.create("dc:Bounds", participantBounds),
        label: participant.name
          ? moddle.create("bpmndi:BPMNLabel", {
              bounds: moddle.create("dc:Bounds", {
                x: participantX + 5,
                y: participantY + participantH / 2 - 10,
                width: 20,
                height: participantH - 20,
              }),
            })
          : undefined,
      }),
    );

    nextParticipantY += participantH + 40;

    // ── 2. Lane shapes for this participant ───────────────────────────────
    for (const band of laneBands) {
      const bounds = { x: band.x, y: band.y, width: band.width, height: band.height };
      const laneAttrs: any = {
        id: `${band.lane.id}_di`,
        bpmnElement: band.lane,
        isHorizontal: true,
        bounds: moddle.create("dc:Bounds", bounds),
      };
      if (band.lane.name) {
        laneAttrs.label = moddle.create("bpmndi:BPMNLabel", {
          bounds: moddle.create("dc:Bounds", laneLabelBounds(band)),
        });
      }
      planeElements.push(moddle.create("bpmndi:BPMNShape", laneAttrs));
    }

    // ── 3. Node (flow element) shapes for this participant ────────────────
    //    Use the full createProcessDi shape logic but emit into planeElements
    //    with translated coordinates.
    const containerObstacles = [
      ...participantBoundaryObstacles(participantBounds, LANE_GUTTER),
      ...laneDividerObstacles(laneBands),
    ];
    const built = buildProcessShapesAndEdges(
      moddle, process, layout, opts, dx, dy, containerObstacles,
      leafLaneBoundsByNodeId(laneBands), participantBounds, warnings,
    );
    for (const el of built.elements) planeElements.push(el);
    allContainerObstacles.push(...containerObstacles);
    for (const [id, node] of built.nodes) collaborationNodes.set(id, node);
    for (const [id, points] of built.edgeWaypoints) sequenceFlowWaypoints.set(id, points);
    collaborationLabels.push(...built.placedLabels);
  }

  // ── 4. Message flow edges ─────────────────────────────────────────────
  // Message flows now share the same collision-repair pipeline sequence
  // flows use: a candidate route, repaired against the full obstacle set
  // (every flow node, every pool's container boundary strips, and every
  // already-placed sequence- and message-flow route), instead of an
  // unchecked fixed mid-line (#13).
  const routingPolicy = resolveRoutingPolicy(opts.routing);
  const collaborationLayout: ProcessLayoutResult = {
    nodes: collaborationNodes,
    allFlows: [],
    containerObstacles: allContainerObstacles,
  };
  const messageFlowWaypoints = new Map<string, Array<{ x: number; y: number }>>();
  const messageFlowLabels: LabelBounds[] = [];
  for (const flow of collaboration.messageFlows || []) {
    const source = collaborationNodes.get(flow.sourceRef?.id);
    const target = collaborationNodes.get(flow.targetRef?.id);
    if (!source || !target) continue;
    const srcCx = source.centerX;
    const srcCy = source.centerY;
    const tgtCx = target.centerX;
    const tgtCy = target.centerY;
    const vertical = Math.abs(tgtCy - srcCy) >= Math.abs(tgtCx - srcCx);
    const sourcePoint = vertical
      ? { x: srcCx, y: tgtCy >= srcCy ? source.y + source.height : source.y }
      : { x: tgtCx >= srcCx ? source.x + source.width : source.x, y: srcCy };
    const targetPoint = vertical
      ? { x: tgtCx, y: tgtCy >= srcCy ? target.y : target.y + target.height }
      : { x: tgtCx >= srcCx ? target.x : target.x + target.width, y: tgtCy };
    const midY = (sourcePoint.y + targetPoint.y) / 2;
    const midX = (sourcePoint.x + targetPoint.x) / 2;
    const candidate = vertical
      ? [sourcePoint, { x: sourcePoint.x, y: midY }, { x: targetPoint.x, y: midY }, targetPoint]
      : [sourcePoint, { x: midX, y: sourcePoint.y }, { x: midX, y: targetPoint.y }, targetPoint];

    const blockedPaths = new Map([...sequenceFlowWaypoints, ...messageFlowWaypoints]);
    const repaired = repairSegmentCollisions(candidate, collaborationLayout, flow, blockedPaths, routingPolicy);
    const finalRoute = validateConnectionPoints(repaired, source, target) ? repaired : candidate;
    const points = snapRouteWaypoints(finalRoute, opts.gridSize);
    messageFlowWaypoints.set(flow.id, points);

    const edgeAttrs: any = {
      id: `${flow.id}_di`,
      bpmnElement: flow,
      // Drop consecutive duplicate points here, at the one place every
      // route's waypoints become dc:Point elements, so no upstream pass --
      // a fixed-offset fallback, a repair step -- can ship a zero-length
      // segment into the DI regardless of how it was produced (#46).
      waypoint: dedupeConsecutivePoints(points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }))).map((p) =>
        moddle.create("dc:Point", p),
      ),
    };
    if (flow.name) {
      // Route through the same candidate-enumeration/collision-rejection
      // pipeline sequence-flow labels use, instead of an unchecked fixed
      // box that never entered placedLabels and so was invisible to every
      // other label's own collision check (#18). A message flow spans two
      // pools by definition, so it has no single owning container to
      // constrain the label to.
      const blockedEdgesForLabel = new Map([...sequenceFlowWaypoints, ...messageFlowWaypoints]);
      const labelBounds = computeEdgeLabelBounds(
        flow,
        points,
        blockedEdgesForLabel,
        [...collaborationLabels, ...messageFlowLabels],
        collaborationNodes,
        undefined,
        warnings,
      );
      if (labelBounds) {
        messageFlowLabels.push(labelBounds);
        edgeAttrs.label = moddle.create("bpmndi:BPMNLabel", {
          bounds: moddle.create("dc:Bounds", labelBounds),
        });
      }
    }
    planeElements.push(moddle.create("bpmndi:BPMNEdge", edgeAttrs));
  }

  normalizePlaneOrigin(planeElements);

  root.diagrams.push(
    moddle.create("bpmndi:BPMNDiagram", {
      id: `BPMNDiagram_${collaboration.id}`,
      plane: moddle.create("bpmndi:BPMNPlane", {
        id: `BPMNPlane_${collaboration.id}`,
        bpmnElement: collaboration,
        planeElement: planeElements,
      }),
    }),
  );
}

// ---------------------------------------------------------------------------
// Process DI
// ---------------------------------------------------------------------------

/**
 * Compute edge waypoints and return all BPMNShape and BPMNEdge elements for
 * the nodes and flows of a single process.  When `dx`/`dy` are non-zero the
 * coordinates are shifted into the collaboration-plane coordinate system.
 *
 * Lane shapes are NOT generated here — they are emitted by the caller
 * (createProcessDi for standalone processes, createCollaborationDi for pools).
 */
interface ProcessShapesAndEdges {
  elements: any[];
  /** Shifted (plane-absolute) node geometry, keyed by element id. */
  nodes: Map<string, NodeLayout>;
  /** Final sequence-flow waypoints, keyed by flow id, in plane-absolute coordinates. */
  edgeWaypoints: Map<string, Array<{ x: number; y: number }>>;
  /** Every label bounds emitted for this process's nodes and edges. */
  placedLabels: LabelBounds[];
}

function buildProcessShapesAndEdges(
  moddle: any,
  process: any,
  layout: ProcessLayoutResult,
  opts: ResolvedLayoutOptions,
  dx = 0,
  dy = 0,
  containerObstacles: NodeLayout[] = [],
  laneBoundsByNodeId: Map<string, LabelBounds> = new Map(),
  participantBounds?: LabelBounds,
  warnings?: LayoutWarning[],
): ProcessShapesAndEdges {
  const elements: any[] = [];
  const routingPolicy = resolveRoutingPolicy(opts.routing);
  const namedLabel = (x: number, y: number, width = 90, height = 20) =>
    moddle.create("bpmndi:BPMNLabel", {
      bounds: moddle.create("dc:Bounds", { x, y, width, height }),
    });

  /**
   * The tightest applicable label-containment bound for `node`: its own
   * subprocess if it is a child, else its lane, else its participant pool,
   * else no constraint (a standalone process with no lanes) (#15).
   */
  const containerBoundsFor = (node: NodeLayout | undefined): LabelBounds | undefined => {
    if (!node) return undefined;
    if (node.isSubProcessChild && node.containerId) {
      const container = shiftedNodes.get(node.containerId);
      if (container) return { x: container.x, y: container.y, width: container.width, height: container.height };
    }
    return laneBoundsByNodeId.get(node.id) ?? participantBounds;
  };

  // Build a shifted view of the layout nodes so waypoint computation uses
  // the offset coordinates (edge-routing relies on NodeLayout .x/.y).
  const shiftedNodes: Map<string, NodeLayout> = new Map();
  for (const [id, node] of layout.nodes.entries()) {
    shiftedNodes.set(id, {
      ...node,
      x: node.x + dx,
      y: node.y + dy,
      centerX: node.centerX + dx,
      centerY: node.centerY + dy,
    });
  }
  // Build a layout view that uses shifted nodes but keeps everything else.
  // containerObstacles (pool borders, the pool caption gutter, lane
  // dividers) are already in plane-absolute coordinates, matching the
  // dx/dy-shifted node coordinates used for routing (see #11).
  const shiftedLayout: ProcessLayoutResult = {
    ...layout,
    nodes: shiftedNodes,
    containerObstacles,
  };

  // 1. Route every sequence flow (channel planning, 7-case waypoint
  // computation, collision repair, orthogonalization) -- extracted to
  // process-routing.ts so it is testable as a pure geometry computation,
  // independent of DI serialization (#31).
  const edgeWaypoints = routeProcessFlows(shiftedLayout, opts, warnings);

  // 1.5 Pre-compute edge labels (before node labels, to reserve space)
  const placedLabels: LabelBounds[] = [];
  const edgeLabelBounds = new Map<string, LabelBounds>();
  for (const flow of shiftedLayout.allFlows) {
    const waypoints = edgeWaypoints.get(flow.id);
    if (!waypoints) continue;
    const edgeLabel = computeEdgeLabelBounds(
      flow,
      waypoints,
      edgeWaypoints,
      placedLabels,
      shiftedLayout.nodes,
      containerBoundsFor(shiftedLayout.nodes.get(flow.sourceRef?.id)),
      warnings,
    );
    if (edgeLabel) {
      edgeLabelBounds.set(flow.id, edgeLabel);
      placedLabels.push(edgeLabel);
    }
  }

  // Keyed by node id, so the post-label re-repair pass below can exclude a
  // flow's own endpoint labels without needing every LabelBounds to carry
  // an owner reference.
  const nodeLabelBounds = new Map<string, LabelBounds>();

  // 2. Shape DI for each node with collision-free labels
  for (const [id, node] of shiftedNodes.entries()) {
    const isMarkerVisible = node.element.$type.endsWith("Gateway") ? true : undefined;
    const isExpanded = node.element.$type === "bpmn:SubProcess" ? true : undefined;

    const shapeAttrs: any = {
      id: `${id}_di`,
      bpmnElement: node.element,
      bounds: moddle.create("dc:Bounds", {
        x: Math.round(node.x),
        y: Math.round(node.y),
        width: Math.round(node.width),
        height: Math.round(node.height),
      }),
    };
    if (isMarkerVisible !== undefined) shapeAttrs.isMarkerVisible = isMarkerVisible;
    if (isExpanded !== undefined) shapeAttrs.isExpanded = isExpanded;

    const hasName =
      typeof node.element.name === "string" && node.element.name.trim().length > 0;
    const needsLabel =
      (node.element.$type.endsWith("Event") || node.element.$type.endsWith("Gateway")) && hasName;

    if (needsLabel) {
      const labelBounds = solveLabelPlacement(
        node,
        edgeWaypoints,
        shiftedNodes,
        placedLabels,
        containerBoundsFor(node),
        warnings,
      );
      placedLabels.push(labelBounds);
      nodeLabelBounds.set(id, labelBounds);
      shapeAttrs.label = namedLabel(
        labelBounds.x,
        labelBounds.y,
        labelBounds.width,
        labelBounds.height,
      );
    } else if (
      hasName &&
      (node.element.$type === "bpmn:DataObjectReference" ||
        node.element.$type === "bpmn:DataStoreReference")
    ) {
      // Route through the same candidate-enumeration/collision-rejection
      // pipeline as event/gateway labels, instead of an unchecked fixed box
      // that never entered placedLabels and so was invisible to every other
      // label's own collision check (#18).
      const labelBounds = solveLabelPlacement(
        node,
        edgeWaypoints,
        shiftedNodes,
        placedLabels,
        containerBoundsFor(node),
        warnings,
      );
      placedLabels.push(labelBounds);
      nodeLabelBounds.set(id, labelBounds);
      shapeAttrs.label = namedLabel(labelBounds.x, labelBounds.y, labelBounds.width, labelBounds.height);
    }

    elements.push(moddle.create("bpmndi:BPMNShape", shapeAttrs));
  }

  // Re-repair any route that ended up crossing a label placed after it was
  // routed (§2: paths shall avoid labels). Routes are chosen before labels
  // exist, so this is deliberately reactive rather than reserving
  // speculative label space up front for every route search -- that
  // alternative was tried and rejected: it perturbed routes that were
  // already correct, including one case that started cutting through an
  // expanded subprocess it had previously avoided cleanly (see #30).
  for (const flow of shiftedLayout.allFlows) {
    const waypoints = edgeWaypoints.get(flow.id);
    if (!waypoints) continue;
    const excluded = new Set<LabelBounds>();
    const ownEdgeLabel = edgeLabelBounds.get(flow.id);
    if (ownEdgeLabel) excluded.add(ownEdgeLabel);
    const srcLabel = nodeLabelBounds.get(flow.sourceRef?.id);
    if (srcLabel) excluded.add(srcLabel);
    const tgtLabel = nodeLabelBounds.get(flow.targetRef?.id);
    if (tgtLabel) excluded.add(tgtLabel);
    const otherLabels = placedLabels.filter((label) => !excluded.has(label));
    if (otherLabels.length === 0) continue;

    const labelObstacles: NodeLayout[] = otherLabels.map((label, index) => ({
      id: `label-avoid-${flow.id}-${index}`,
      element: { $type: "bpmn:LabelObstacle" },
      col: 0,
      track: 0,
      ...label,
      centerX: label.x + label.width / 2,
      centerY: label.y + label.height / 2,
    }));
    const layoutWithLabels: ProcessLayoutResult = {
      ...shiftedLayout,
      containerObstacles: [...(shiftedLayout.containerObstacles ?? []), ...labelObstacles],
    };
    const beforeWithLabels = countRouteHits(waypoints, layoutWithLabels, flow, edgeWaypoints);
    if (beforeWithLabels === 0) continue;

    // A route may never be adopted here just for crossing fewer labels while
    // crossing more shapes/edges than before -- §8 ranks no-overlap above
    // label placement, so this pass may only trade a label crossing for
    // nothing worse, never for a new or additional shape/edge crossing.
    const beforeShapeHits = countRouteHits(waypoints, shiftedLayout, flow, edgeWaypoints);
    const src = shiftedLayout.nodes.get(flow.sourceRef?.id);
    const tgt = shiftedLayout.nodes.get(flow.targetRef?.id);
    const repaired = repairSegmentCollisions(waypoints, layoutWithLabels, flow, edgeWaypoints, routingPolicy);
    if (
      validateConnectionPoints(repaired, src, tgt) &&
      countRouteHits(repaired, layoutWithLabels, flow, edgeWaypoints) < beforeWithLabels &&
      countRouteHits(repaired, shiftedLayout, flow, edgeWaypoints) <= beforeShapeHits
    ) {
      edgeWaypoints.set(flow.id, snapRouteWaypoints(ensureOrthogonalWaypoints(repaired), opts.gridSize));
    }
  }

  // 3. Edge DI for each sequence flow
  for (const flow of shiftedLayout.allFlows) {
    const waypoints = edgeWaypoints.get(flow.id);
    if (!waypoints) continue;

    const edgeDiAttrs: any = {
      id: `${flow.id}_di`,
      bpmnElement: flow,
      // See the message-flow edge above: dedupe here too, at the point
      // waypoints become dc:Point elements, so the label re-repair pass
      // just above (which can rewrite a route) can't reintroduce a
      // zero-length segment that earlier dedup passes already removed (#46).
      waypoint: dedupeConsecutivePoints(waypoints.map((pt) => ({ x: Math.round(pt.x), y: Math.round(pt.y) }))).map(
        (pt) => moddle.create("dc:Point", pt),
      ),
    };

    const edgeLabel = edgeLabelBounds.get(flow.id);
    if (edgeLabel) {
      edgeDiAttrs.label = moddle.create("bpmndi:BPMNLabel", {
        bounds: moddle.create("dc:Bounds", {
          x: edgeLabel.x,
          y: edgeLabel.y,
          width: edgeLabel.width,
          height: edgeLabel.height,
        }),
      });
    }

    elements.push(moddle.create("bpmndi:BPMNEdge", edgeDiAttrs));
  }

  return { elements, nodes: shiftedNodes, edgeWaypoints, placedLabels };
}

export function createProcessDi(
  moddle: any,
  rootElement: any,
  process: any,
  layout: ProcessLayoutResult,
  opts: ResolvedLayoutOptions,
  warnings?: LayoutWarning[],
): void {
  const planeElements: any[] = [];
  let containerObstacles: NodeLayout[] = [];
  let laneBoundsByNodeId = new Map<string, LabelBounds>();

  // Lane DI: partition every lane (including nested childLaneSet lanes and
  // lanes with no member nodes) into contiguous, non-overlapping bands
  // spanning the full width of the process's content.
  if ((process.laneSets || []).length > 0) {
    const topNodes = Array.from(layout.nodes.values()).filter((node) => !node.isSubProcessChild);
    if (topNodes.length > 0) {
      const minX = Math.min(...topNodes.map((node) => node.x));
      const maxX = Math.max(...topNodes.map((node) => node.x + node.width));
      const minY = Math.min(...topNodes.map((node) => node.y));
      const maxY = Math.max(...topNodes.map((node) => node.y + node.height));
      const xSpan = { x: minX - 30, width: maxX - minX + 60 };
      const ySpan = { y: minY - 30, height: maxY - minY + 60 };
      const bands = computeLaneBands(process.laneSets, layout.nodes, xSpan, ySpan);
      containerObstacles = laneDividerObstacles(bands);
      laneBoundsByNodeId = leafLaneBoundsByNodeId(bands);
      for (const band of bands) {
        const bounds = { x: band.x, y: band.y, width: band.width, height: band.height };
        const shapeAttrs: any = {
          id: `${band.lane.id}_di`,
          bpmnElement: band.lane,
          bounds: moddle.create("dc:Bounds", bounds),
        };
        if (band.lane.name) {
          shapeAttrs.label = moddle.create("bpmndi:BPMNLabel", {
            bounds: moddle.create("dc:Bounds", laneLabelBounds(band)),
          });
        }
        planeElements.push(moddle.create("bpmndi:BPMNShape", shapeAttrs));
      }
    }
  }

  // Generate node shapes and edge DI using the shared helper (no offset for
  // standalone processes — dx=0, dy=0).
  for (const el of buildProcessShapesAndEdges(
    moddle, process, layout, opts, 0, 0, containerObstacles, laneBoundsByNodeId, undefined, warnings,
  ).elements) {
    planeElements.push(el);
  }

  normalizePlaneOrigin(planeElements);

  const plane = moddle.create("bpmndi:BPMNPlane", {
    id: `BPMNPlane_${process.id}`,
    bpmnElement: process,
    planeElement: planeElements,
  });

  rootElement.diagrams.push(
    moddle.create("bpmndi:BPMNDiagram", {
      id: `BPMNDiagram_${process.id}`,
      plane,
    }),
  );
}
