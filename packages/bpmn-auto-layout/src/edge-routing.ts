/**
 * Edge routing — `computeWaypoints` and its companion decision function
 * `shouldUseUpsideRoute`.
 *
 * These functions translate the abstract track/column layout produced by
 * node-placement.ts into concrete orthogonal waypoint sequences for every
 * sequence flow.  Seven explicit routing cases handle every topology the BPMN
 * grammar can produce; `repairSegmentCollisions` (collision-repair.ts) handles
 * any residual intersections afterwards.
 */

import type { NodeLayout, ProcessLayoutResult } from "./layout-types";
import { CHANNEL_CLEARANCE } from "./element-dimensions";
import { segmentHitCount } from "./collision-repair";

// ---------------------------------------------------------------------------
// Channel Y helper
// ---------------------------------------------------------------------------

/** Read the resolved channel Y for a flow from the process layout's channel plan. */
export function channelY(
  layout: ProcessLayoutResult,
  flow: any,
  side: "above" | "below",
  x1: number,
  x2: number,
): number {
  return layout.channels?.channelY(flow?.id ?? "", side, x1, x2) ?? 0;
}

// ---------------------------------------------------------------------------
// Upside-route eligibility
// ---------------------------------------------------------------------------

/**
 * Returns true when two gateway nodes on the same track should be connected via
 * a channel *above* the node band rather than below it.  This prevents the
 * bypass from crossing lower-track branches that depart the source gateway
 * downward.
 */
export function shouldUseUpsideRoute(
  src: NodeLayout,
  tgt: NodeLayout,
  layout: ProcessLayoutResult,
  flowId?: string,
): boolean {
  if (!src.element.$type.endsWith("Gateway") || !tgt.element.$type.endsWith("Gateway")) {
    return false;
  }
  if (src.track !== tgt.track) return false;

  const minTrack = Math.min(0, ...Array.from(layout.nodes.values()).map((n) => n.track));
  const minCol = Math.min(src.col, tgt.col);
  const maxCol = Math.max(src.col, tgt.col);
  if (minTrack < 0) {
    const hasUpperObstacle = Array.from(layout.nodes.values()).some(
      (n) => n.track < 0 && n.col >= minCol && n.col <= maxCol,
    );
    if (hasUpperObstacle) return false;
  }

  const intermediateNodes = Array.from(layout.nodes.values()).filter(
    (n) =>
      n.id !== src.id && n.id !== tgt.id && n.track === src.track && n.col > minCol && n.col < maxCol,
  );
  if (intermediateNodes.length === 0) return false;

  const otherIncomingSameTrack = layout.allFlows.filter((f) => {
    if (f.id === flowId || f.targetRef?.id !== tgt.id) return false;
    const fSrc = layout.nodes.get(f.sourceRef?.id);
    return fSrc && fSrc.track === tgt.track && fSrc.id !== src.id;
  });

  const currentSpan = Math.abs(src.col - tgt.col);
  const isLonger = otherIncomingSameTrack.every((f) => {
    const fSrc = layout.nodes.get(f.sourceRef?.id)!;
    return currentSpan > Math.abs(fSrc.col - tgt.col);
  });
  if (!isLonger) return false;

  if (tgt.col <= src.col) {
    const hasForwardBypass = layout.allFlows.some((f) => {
      if (f.id === flowId || f.sourceRef?.id !== src.id) return false;
      const fTgt = layout.nodes.get(f.targetRef?.id);
      return fTgt && fTgt.track === src.track && fTgt.col > src.col + 1;
    });
    if (hasForwardBypass) return false;
  }

  const otherOutgoing = layout.allFlows.filter((f) => f.id !== flowId && f.sourceRef?.id === src.id);
  const srcHasBottomOutgoing = otherOutgoing.some((f) => {
    const fTgt = layout.nodes.get(f.targetRef?.id);
    if (!fTgt) return false;
    return fTgt.col <= src.col || fTgt.track > src.track;
  });

  const otherIncoming = layout.allFlows.filter((f) => f.id !== flowId && f.targetRef?.id === tgt.id);
  const tgtHasBottomIncoming = otherIncoming.some((f) => {
    const fSrc = layout.nodes.get(f.sourceRef?.id);
    if (!fSrc) return false;
    return tgt.col <= fSrc.col || fSrc.track > tgt.track;
  });

  const tgtOutgoing = layout.allFlows.filter((f) => f.sourceRef?.id === tgt.id);
  const tgtHasBottomOutgoing = tgtOutgoing.some((f) => {
    const fTgt = layout.nodes.get(f.targetRef?.id);
    if (!fTgt) return false;
    return fTgt.col <= tgt.col || fTgt.track > tgt.track;
  });

  return (
    srcHasBottomOutgoing ||
    tgtHasBottomIncoming ||
    tgtHasBottomOutgoing ||
    otherIncoming.length > 0
  );
}

// ---------------------------------------------------------------------------
// Waypoint computation — seven routing cases
// ---------------------------------------------------------------------------

export function computeWaypoints(
  src: NodeLayout,
  tgt: NodeLayout,
  layout: ProcessLayoutResult,
  opts: { track1Y: number },
  flow?: any,
): Array<{ x: number; y: number }> {
  // Case 1: SubProcess child internal flow — direct horizontal stub
  if (src.isSubProcessChild && tgt.isSubProcessChild) {
    return [
      { x: src.x + src.width, y: src.centerY },
      { x: tgt.x, y: tgt.centerY },
    ];
  }

  // Case 1.5: Upside route between gateways to prevent lane collisions
  if (shouldUseUpsideRoute(src, tgt, layout, flow?.id)) {
    const upper = channelY(layout, flow, "above", src.centerX, tgt.centerX);
    return [
      { x: src.centerX, y: src.y },
      { x: src.centerX, y: upper },
      { x: tgt.centerX, y: upper },
      { x: tgt.centerX, y: tgt.y },
    ];
  }

  // Case 2: Loop-back / back-edge (target column ≤ source column)
  if (tgt.col <= src.col) {
    const lane = channelY(layout, flow, "below", src.centerX, tgt.centerX);
    return [
      { x: src.centerX, y: src.y + src.height },
      { x: src.centerX, y: lane },
      { x: tgt.centerX, y: lane },
      { x: tgt.centerX, y: tgt.y + tgt.height },
    ];
  }

  // Case 3: Same track, forward flow
  if (src.track === tgt.track) {
    const hasObstacle = Array.from(layout.nodes.values()).some(
      (n) =>
        n.id !== src.id &&
        n.id !== tgt.id &&
        n.track === src.track &&
        !n.isSubProcessChild &&
        n.x < tgt.x &&
        n.x + n.width > src.x + src.width &&
        n.y < src.centerY &&
        n.y + n.height > src.centerY,
    );

    const srcExitY =
      src.element.$type === "bpmn:SubProcess" ? opts.track1Y : src.centerY;
    const tgtEntryY =
      tgt.element.$type === "bpmn:SubProcess" ? opts.track1Y : tgt.centerY;

    if (!hasObstacle) {
      return [
        { x: src.x + src.width, y: srcExitY },
        { x: tgt.x, y: tgtEntryY },
      ];
    }

    // Forward bypass via channel: keep the bypass opposite any vertical
    // gateway branch so the three outgoing directions remain distinct.
    const hasUpperBranch =
      src.element.$type.endsWith("Gateway") &&
      layout.allFlows.some((candidate) => {
        if (candidate.id === flow?.id || candidate.sourceRef?.id !== src.id) return false;
        const target = layout.nodes.get(candidate.targetRef?.id);
        return target && target.track < src.track;
      });
    const hasLowerBranch =
      src.element.$type.endsWith("Gateway") &&
      layout.allFlows.some((candidate) => {
        if (candidate.id === flow?.id || candidate.sourceRef?.id !== src.id) return false;
        const target = layout.nodes.get(candidate.targetRef?.id);
        return target && target.track > src.track;
      });
    const channelSide = hasUpperBranch || hasLowerBranch ? "above" : "below";
    const lane = channelY(
      layout,
      flow,
      channelSide,
      src.centerX,
      tgt.centerX,
    );
    return [
      { x: src.centerX, y: channelSide === "above" ? src.y : src.y + src.height },
      { x: src.centerX, y: lane },
      { x: tgt.centerX, y: lane },
      { x: tgt.centerX, y: channelSide === "above" ? tgt.y : tgt.y + tgt.height },
    ];
  }

  // Case 4: Branching UP from gateway to upper track
  if (src.track > tgt.track && src.element.$type.endsWith("Gateway") && !tgt.element.$type.endsWith("Gateway")) {
    if (src.centerX >= tgt.x && src.centerX <= tgt.x + tgt.width) {
      return [
        { x: src.centerX, y: src.y },
        { x: src.centerX, y: tgt.y + tgt.height },
      ];
    }
    const entryX = src.centerX > tgt.x + tgt.width ? tgt.x + tgt.width : tgt.x;
    const direct = [
      { x: src.centerX, y: src.y },
      { x: src.centerX, y: tgt.centerY },
      { x: entryX, y: tgt.centerY },
    ];
    const blockers = Array.from(layout.nodes.values()).filter(
      (n) => n.id !== src.id && n.id !== tgt.id && n.element?.$type !== "bpmn:SubProcess",
    );
    if (segmentHitCount(direct[0]!, direct[1]!, blockers) > 0 && entryX === tgt.x) {
      const gapX = (src.x + src.width + tgt.x) / 2;
      const blockerBottom = Math.max(
        tgt.y + tgt.height,
        ...blockers
          .filter((n) => n.x < src.centerX && src.centerX < n.x + n.width && n.y + n.height < src.y)
          .map((n) => n.y + n.height),
      );
      const midY = (blockerBottom + src.y) / 2;
      const jog = [
        { x: src.centerX, y: src.y },
        { x: src.centerX, y: midY },
        { x: gapX, y: midY },
        { x: gapX, y: tgt.centerY },
        { x: tgt.x, y: tgt.centerY },
      ];
      let jogHits = 0;
      for (let i = 0; i < jog.length - 1; i += 1) jogHits += segmentHitCount(jog[i]!, jog[i + 1]!, blockers);
      if (jogHits === 0) return jog;
    }
    return direct;
  }

  // Case 5: Merging DOWN from upper track into a gateway
  if (src.track < tgt.track && tgt.element.$type.endsWith("Gateway") && src.centerY < tgt.centerY) {
    return [
      { x: src.x + src.width, y: src.centerY },
      { x: tgt.centerX, y: src.centerY },
      { x: tgt.centerX, y: tgt.y },
    ];
  }

  // Case 6: Branching down from gateway to lower track
  if (src.track < tgt.track) {
    if (src.element.$type.endsWith("Gateway")) {
      if (src.centerX >= tgt.x && src.centerX <= tgt.x + tgt.width) {
        return [
          { x: src.centerX, y: src.y + src.height },
          { x: src.centerX, y: tgt.y },
        ];
      }
      const entryX = src.centerX > tgt.x + tgt.width ? tgt.x + tgt.width : tgt.x;
      const direct = [
        { x: src.centerX, y: src.y + src.height },
        { x: src.centerX, y: tgt.centerY },
        { x: entryX, y: tgt.centerY },
      ];
      const blockers = Array.from(layout.nodes.values()).filter(
        (n) =>
          n.id !== src.id && n.id !== tgt.id && !n.isSubProcessChild && n.element?.$type !== "bpmn:SubProcess",
      );
      const directHits = direct
        .slice(0, -1)
        .reduce((count, p, i) => count + segmentHitCount(p, direct[i + 1]!, blockers), 0);
      if (directHits > 0) {
        const relevant = blockers.filter(
          (n) =>
            n.x < Math.max(src.centerX, tgt.centerX) &&
            n.x + n.width > Math.min(src.centerX, tgt.centerX) &&
            n.y < tgt.centerY &&
            n.y + n.height > src.y + src.height,
        );
        const crossY = Math.max(
          tgt.centerY,
          ...relevant.map((n) => n.y + n.height + CHANNEL_CLEARANCE),
        );
        for (const dir of [1, -1] as const) {
          const bypassX =
            dir > 0
              ? Math.max(src.x + src.width, ...relevant.map((n) => n.x + n.width)) + CHANNEL_CLEARANCE
              : Math.min(src.x, ...relevant.map((n) => n.x)) - CHANNEL_CLEARANCE;
          const bypass = [
            { x: src.centerX, y: src.y + src.height },
            { x: bypassX, y: src.y + src.height },
            { x: bypassX, y: crossY },
            { x: entryX, y: crossY },
            { x: entryX, y: tgt.centerY },
          ];
          const bypassHits = bypass
            .slice(0, -1)
            .reduce((count, p, i) => count + segmentHitCount(p, bypass[i + 1]!, blockers), 0);
          if (bypassHits === 0) return bypass;
        }
      }
      return direct;
    }
    // Non-gateway exits right of task, drops to target centerY
    if (src.track < 0 && tgt.element.$type.endsWith("EndEvent")) {
      const lane = channelY(layout, flow, "above", src.centerX, tgt.centerX) - CHANNEL_CLEARANCE;
      return [
        { x: src.x + src.width, y: src.centerY },
        { x: src.x + src.width, y: lane },
        { x: tgt.centerX, y: lane },
        { x: tgt.centerX, y: tgt.y + tgt.height },
      ];
    }
    return [
      { x: src.x + src.width, y: src.centerY },
      { x: (src.x + src.width + tgt.x) / 2, y: src.centerY },
      { x: (src.x + src.width + tgt.x) / 2, y: tgt.centerY },
      { x: tgt.x, y: tgt.centerY },
    ];
  }

  // Case 7: Merging up from lower track into a gateway
  if (src.track > tgt.track && tgt.element.$type.endsWith("Gateway")) {
    const isOtherExit = layout.allFlows.some(
      (f) =>
        f.id !== flow?.id &&
        f.sourceRef?.id === src.id &&
        (layout.nodes.get(f.targetRef?.id)?.track ?? 0) < src.track,
    );
    const otherFlow = layout.allFlows.find(
      (f) =>
        f.id !== flow?.id &&
        f.sourceRef?.id === src.id &&
        (layout.nodes.get(f.targetRef?.id)?.track ?? 0) < src.track,
    );
    const otherTgt = otherFlow ? layout.nodes.get(otherFlow.targetRef?.id) : null;
    const isLonger = otherTgt ? tgt.col > otherTgt.col : false;

    if (isOtherExit && isLonger && src.element.$type.endsWith("Gateway")) {
      const lane = channelY(layout, flow, "below", src.centerX, tgt.centerX);
      return [
        { x: src.centerX, y: src.y + src.height },
        { x: src.centerX, y: lane },
        { x: tgt.centerX, y: lane },
        { x: tgt.centerX, y: tgt.y + tgt.height },
      ];
    }

    const straight = [
      { x: src.x + src.width, y: src.centerY },
      { x: tgt.centerX, y: src.centerY },
      { x: tgt.centerX, y: tgt.y + tgt.height },
    ];
    const between = Array.from(layout.nodes.values()).filter(
      (n) => n.id !== src.id && n.id !== tgt.id && n.element?.$type !== "bpmn:SubProcess",
    );
    if (segmentHitCount(straight[0]!, straight[1]!, between) > 0) {
      const lane = channelY(layout, flow, "below", src.centerX, tgt.centerX);
      return [
        { x: src.centerX, y: src.y + src.height },
        { x: src.centerX, y: lane },
        { x: tgt.centerX, y: lane },
        { x: tgt.centerX, y: tgt.y + tgt.height },
      ];
    }
    return straight;
  }

  // Fallback orthogonal
  return [
    { x: src.x + src.width, y: src.centerY },
    { x: tgt.centerX, y: src.centerY },
    { x: tgt.centerX, y: tgt.centerY },
    { x: tgt.x, y: tgt.centerY },
  ];
}
