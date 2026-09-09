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
import { planChannels } from "./channel-planning";
import { computeWaypoints, channelY } from "./edge-routing";
import { repairSegmentCollisions } from "./collision-repair";
import {
  fanOutAttachPoints,
  ensureOrthogonalWaypoints,
  solveLabelPlacement,
  computeEdgeLabelBounds,
  type LabelBounds,
} from "./label-placement";


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
): void {
  const collaboration = (root.rootElements || []).find(
    (element: any) => element.$type === "bpmn:Collaboration",
  );
  if (!collaboration || !collaboration.participants?.length) return;

  const planeElements: any[] = [];

  /**
   * nodePositions maps every element id (participant, flow node, subprocess child)
   * to its final absolute bounds within the collaboration plane.  Used later for
   * message-flow waypoint computation.
   */
  const nodePositions = new Map<
    string,
    { x: number; y: number; width: number; height: number }
  >();

  // Per-participant absolute offsets: process-local (x,y) → collaboration-plane (x,y)
  const participantOffsets = new Map<string, { dx: number; dy: number }>();

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
    const participantH = maxY - minY + PAD_TOP + PAD_BOTTOM;

    // Translation from process-local to collaboration-plane coords
    const dx = participantX + PAD_LEFT - minX;
    const dy = participantY + PAD_TOP - minY;
    participantOffsets.set(process.id, { dx, dy });

    const participantBounds = {
      x: participantX,
      y: participantY,
      width: participantW,
      height: participantH,
    };
    nodePositions.set(participant.id, participantBounds);

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
    for (const laneSet of process.laneSets || []) {
      for (const lane of laneSet.lanes || []) {
        const members = (lane.flowNodeRef || [])
          .map((ref: any) => layout.nodes.get(ref.id))
          .filter((n: NodeLayout | undefined): n is NodeLayout =>
            Boolean(n && !n.isSubProcessChild),
          );
        if (members.length === 0) continue;
        const lMinX = Math.min(...members.map((n: NodeLayout) => n.x));
        const lMaxX = Math.max(...members.map((n: NodeLayout) => n.x + n.width));
        const lMinY = Math.min(...members.map((n: NodeLayout) => n.y));
        const lMaxY = Math.max(...members.map((n: NodeLayout) => n.y + n.height));
        const laneBounds = {
          x: lMinX + dx - 30,
          y: lMinY + dy - 15,
          width: lMaxX - lMinX + 60,
          height: lMaxY - lMinY + 30,
        };
        const laneAttrs: any = {
          id: `${lane.id}_di`,
          bpmnElement: lane,
          isHorizontal: true,
          bounds: moddle.create("dc:Bounds", laneBounds),
        };
        if (lane.name)
          laneAttrs.label = moddle.create("bpmndi:BPMNLabel", {
            bounds: moddle.create("dc:Bounds", {
              x: laneBounds.x + 3,
              y: laneBounds.y + laneBounds.height / 2 - 10,
              width: 20,
              height: 20,
            }),
          });
        planeElements.push(moddle.create("bpmndi:BPMNShape", laneAttrs));
      }
    }

    // ── 3. Node (flow element) shapes for this participant ────────────────
    //    Use the full createProcessDi shape logic but emit into planeElements
    //    with translated coordinates.
    const processPlaneElements = buildProcessShapesAndEdges(
      moddle, process, layout, opts, dx, dy,
    );
    for (const el of processPlaneElements) planeElements.push(el);

    // Populate nodePositions for all flow nodes (for message-flow routing)
    for (const node of layout.nodes.values()) {
      nodePositions.set(node.id, {
        x: node.x + dx,
        y: node.y + dy,
        width: node.width,
        height: node.height,
      });
    }
  }

  // ── 4. Message flow edges ─────────────────────────────────────────────
  for (const flow of collaboration.messageFlows || []) {
    const source = nodePositions.get(flow.sourceRef?.id);
    const target = nodePositions.get(flow.targetRef?.id);
    if (!source || !target) continue;
    const srcCx = source.x + source.width / 2;
    const srcCy = source.y + source.height / 2;
    const tgtCx = target.x + target.width / 2;
    const tgtCy = target.y + target.height / 2;
    const midY = (srcCy + tgtCy) / 2;
    const points = [
      { x: srcCx, y: srcCy },
      { x: srcCx, y: midY },
      { x: tgtCx, y: midY },
      { x: tgtCx, y: tgtCy },
    ];
    const edgeAttrs: any = {
      id: `${flow.id}_di`,
      bpmnElement: flow,
      waypoint: points.map((p) => moddle.create("dc:Point", p)),
    };
    if (flow.name) {
      edgeAttrs.label = moddle.create("bpmndi:BPMNLabel", {
        bounds: moddle.create("dc:Bounds", {
          x: (srcCx + tgtCx) / 2 - 45,
          y: midY - 20,
          width: 90,
          height: 20,
        }),
      });
    }
    planeElements.push(moddle.create("bpmndi:BPMNEdge", edgeAttrs));
  }

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
function buildProcessShapesAndEdges(
  moddle: any,
  process: any,
  layout: ProcessLayoutResult,
  opts: ResolvedLayoutOptions,
  dx = 0,
  dy = 0,
): any[] {
  const elements: any[] = [];
  const routingPolicy = resolveRoutingPolicy(opts.routing);
  const namedLabel = (x: number, y: number, width = 90, height = 20) =>
    moddle.create("bpmndi:BPMNLabel", {
      bounds: moddle.create("dc:Bounds", { x, y, width, height }),
    });

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
  const shiftedLayout: ProcessLayoutResult = {
    ...layout,
    nodes: shiftedNodes,
  };

  // 1. Pre-compute edge waypoints (two passes: record → resolve channel lanes)
  const edgeWaypoints = new Map<string, Array<{ x: number; y: number }>>();
  const { recorder, resolve } = planChannels(shiftedLayout.nodes);
  for (const pass of [recorder, null]) {
    shiftedLayout.channels = pass ?? resolve();
    edgeWaypoints.clear();
    for (const flow of shiftedLayout.allFlows) {
      const src = shiftedLayout.nodes.get(flow.sourceRef?.id);
      const tgt = shiftedLayout.nodes.get(flow.targetRef?.id);
      if (!src || !tgt) continue;
      edgeWaypoints.set(
        flow.id,
        repairSegmentCollisions(
          computeWaypoints(src, tgt, shiftedLayout, opts, flow),
          shiftedLayout,
          flow,
          new Map(),
          routingPolicy,
        ),
      );
    }
  }

  fanOutAttachPoints(edgeWaypoints, shiftedLayout);

  // Post-repair: re-route lower-track merge flows and re-apply collision repair
  for (const flow of shiftedLayout.allFlows) {
    const existing = edgeWaypoints.get(flow.id);
    if (!existing) continue;
    const src = shiftedLayout.nodes.get(flow.sourceRef?.id);
    const tgt = shiftedLayout.nodes.get(flow.targetRef?.id);
    const isLowerMerge =
      src &&
      tgt &&
      src.track > tgt.track &&
      tgt.element?.$type?.endsWith("Gateway") &&
      !src.element?.$type?.endsWith("Gateway");
    if (isLowerMerge) {
      edgeWaypoints.set(flow.id, computeWaypoints(src, tgt, shiftedLayout, opts, flow));
      continue;
    }
    edgeWaypoints.set(
      flow.id,
      repairSegmentCollisions(existing, shiftedLayout, flow, edgeWaypoints, routingPolicy),
    );
  }

  // Restore upper-channel bypasses for non-exclusive gateways with an upper-track branch
  for (const flow of shiftedLayout.allFlows) {
    const src = shiftedLayout.nodes.get(flow.sourceRef?.id);
    const tgt = shiftedLayout.nodes.get(flow.targetRef?.id);
    const hasUpperBranch =
      src &&
      tgt &&
      src.track === tgt.track &&
      src.element.$type.endsWith("Gateway") &&
      Array.from(shiftedLayout.nodes.values()).some(
        (node) =>
          node.id !== src.id &&
          node.id !== tgt.id &&
          !node.isSubProcessChild &&
          node.track === src.track &&
          node.x < tgt.x &&
          node.x + node.width > src.x + src.width &&
          node.y < src.centerY &&
          node.y + node.height > src.centerY,
      ) &&
      shiftedLayout.allFlows.some((candidate) => {
        if (candidate.id === flow.id || candidate.sourceRef?.id !== src.id) return false;
        const target = shiftedLayout.nodes.get(candidate.targetRef?.id);
        return target && target.track < src.track;
      });
    if (hasUpperBranch && src && tgt) {
      const upper = channelY(shiftedLayout, flow, "above", src.centerX, tgt.centerX);
      edgeWaypoints.set(flow.id, [
        { x: src.centerX, y: src.y },
        { x: src.centerX, y: upper },
        { x: tgt.centerX, y: upper },
        { x: tgt.centerX, y: tgt.y },
      ]);
    }
  }

  for (const [flowId, points] of edgeWaypoints) {
    edgeWaypoints.set(flowId, ensureOrthogonalWaypoints(points));
  }

  // 1.5 Pre-compute edge labels (before node labels, to reserve space)
  const placedLabels: LabelBounds[] = [];
  const edgeLabelBounds = new Map<string, LabelBounds>();
  for (const flow of shiftedLayout.allFlows) {
    const waypoints = edgeWaypoints.get(flow.id);
    if (!waypoints) continue;
    const edgeLabel = computeEdgeLabelBounds(flow, waypoints, edgeWaypoints, placedLabels, shiftedLayout.nodes);
    if (edgeLabel) {
      edgeLabelBounds.set(flow.id, edgeLabel);
      placedLabels.push(edgeLabel);
    }
  }

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
      const labelBounds = solveLabelPlacement(node, edgeWaypoints, shiftedNodes, placedLabels);
      placedLabels.push(labelBounds);
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
      shapeAttrs.label = namedLabel(node.x + node.width / 2 - 45, node.y + node.height + 8);
    }

    elements.push(moddle.create("bpmndi:BPMNShape", shapeAttrs));
  }

  // 3. Edge DI for each sequence flow
  for (const flow of shiftedLayout.allFlows) {
    const waypoints = edgeWaypoints.get(flow.id);
    if (!waypoints) continue;

    const edgeDiAttrs: any = {
      id: `${flow.id}_di`,
      bpmnElement: flow,
      waypoint: waypoints.map((pt) =>
        moddle.create("dc:Point", {
          x: Math.round(pt.x),
          y: Math.round(pt.y),
        }),
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

  return elements;
}

export function createProcessDi(
  moddle: any,
  rootElement: any,
  process: any,
  layout: ProcessLayoutResult,
  opts: ResolvedLayoutOptions,
): void {
  const planeElements: any[] = [];
  const namedLabel = (x: number, y: number, width = 90, height = 20) =>
    moddle.create("bpmndi:BPMNLabel", {
      bounds: moddle.create("dc:Bounds", { x, y, width, height }),
    });

  // Lane DI: derive bounds from referenced member nodes
  for (const laneSet of process.laneSets || []) {
    for (const lane of laneSet.lanes || []) {
      const members = (lane.flowNodeRef || [])
        .map((ref: any) => layout.nodes.get(ref.id))
        .filter((node: NodeLayout | undefined): node is NodeLayout =>
          Boolean(node && !node.isSubProcessChild),
        );
      if (members.length === 0) continue;
      const minX = Math.min(...members.map((node: NodeLayout) => node.x));
      const maxX = Math.max(...members.map((node: NodeLayout) => node.x + node.width));
      const minY = Math.min(...members.map((node: NodeLayout) => node.y));
      const maxY = Math.max(...members.map((node: NodeLayout) => node.y + node.height));
      const bounds = { x: minX - 30, y: minY - 30, width: maxX - minX + 60, height: maxY - minY + 60 };
      const shapeAttrs: any = {
        id: `${lane.id}_di`,
        bpmnElement: lane,
        bounds: moddle.create("dc:Bounds", bounds),
      };
      if (lane.name) shapeAttrs.label = namedLabel(bounds.x + 15, bounds.y + 15, 90, 20);
      planeElements.push(moddle.create("bpmndi:BPMNShape", shapeAttrs));
    }
  }

  // Generate node shapes and edge DI using the shared helper (no offset for
  // standalone processes — dx=0, dy=0).
  for (const el of buildProcessShapesAndEdges(moddle, process, layout, opts)) {
    planeElements.push(el);
  }

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
