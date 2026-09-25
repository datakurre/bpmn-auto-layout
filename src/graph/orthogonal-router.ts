import type { Bounds, Point } from '../types';
import {
  axisIntervalsOverlap,
  verticalSegmentHitsBox,
  isVerticalSpanBlocked,
  isHorizontalSpanBlocked,
} from './obstacles';

/** Horizontal gap kept between a loop edge's vertical drop and any shape. */
const STEP_CLEARANCE = 20;

interface ObstacleCheckContext {
  ignore: Bounds;
  obstacles?: Bounds[];
}

function hasObstacleBelow(pt: Point, endY: number, ctx: ObstacleCheckContext): boolean {
  if (!ctx.obstacles) {
    return false;
  }
  // A proper y-interval overlap test, not `b.y >= pt.y`: a one-sided
  // comparison misses an obstacle whose top edge sits above `pt` but whose
  // body still overlaps the [pt.y, endY) drop/climb span -- which happens
  // whenever `pt`'s own node already overlaps that obstacle (a regression this fixes).
  return ctx.obstacles.some(
    (b) =>
      b !== ctx.ignore && pt.x > b.x && pt.x < b.x + b.width && b.y < endY && b.y + b.height > pt.y
  );
}

interface FeedbackSpanContext {
  minX: number;
  maxX: number;
}

function hasBoundaryEventBelowInSpan(span: FeedbackSpanContext, allBounds: Bounds[]): boolean {
  return allBounds.some(
    (b) =>
      b.width === 36 &&
      b.height === 36 &&
      b.x + b.width > span.minX &&
      b.x < span.maxX &&
      allBounds.some(
        (other) =>
          other !== b &&
          b.x >= other.x &&
          b.x + b.width <= other.x + other.width &&
          b.y > other.y + other.height / 2
      )
  );
}

function hasObstaclesAboveInSpan(
  span: { minX: number; maxX: number; maxY: number },
  allBounds: Bounds[]
): boolean {
  return allBounds.some(
    (b) => b.x + b.width > span.minX && b.x < span.maxX && b.y + b.height <= span.maxY
  );
}

function hasBlockedDownwardFeedbackExit(
  sourceBounds: Bounds,
  targetBounds: Bounds,
  allBounds: Bounds[]
): boolean {
  const srcBottom: Point = {
    x: Math.round(sourceBounds.x + sourceBounds.width / 2),
    y: sourceBounds.y + sourceBounds.height,
  };
  const channelY = computeChannelY(sourceBounds, targetBounds, allBounds);
  if (!hasObstacleBelow(srcBottom, channelY, { ignore: sourceBounds, obstacles: allBounds })) {
    return false;
  }
  const srcRight: Point = {
    x: sourceBounds.x + sourceBounds.width,
    y: Math.round(sourceBounds.y + sourceBounds.height / 2),
  };
  const srcStepX = getClearSourceStepX(sourceBounds, channelY, allBounds);
  return isCollinearPathBlocked(
    srcRight.y,
    { xStart: srcRight.x, xEnd: srcStepX, ignore: [sourceBounds] },
    allBounds
  );
}

function shouldUseUpwardFeedbackRoute(
  sourceBounds: Bounds,
  targetBounds: Bounds,
  allBounds: Bounds[]
): boolean {
  const minX = Math.min(sourceBounds.x, targetBounds.x);
  const maxX = Math.max(sourceBounds.x + sourceBounds.width, targetBounds.x + targetBounds.width);
  const maxY = Math.min(sourceBounds.y, targetBounds.y);
  if (hasObstaclesAboveInSpan({ minX, maxX, maxY }, allBounds)) {
    return false;
  }
  if (sourceBounds.y + sourceBounds.height <= targetBounds.y) {
    return true;
  }
  if (
    Math.abs(sourceBounds.y - targetBounds.y) <= 20 &&
    (hasBoundaryEventBelowInSpan({ minX, maxX }, allBounds) ||
      hasBlockedDownwardFeedbackExit(sourceBounds, targetBounds, allBounds))
  ) {
    return true;
  }
  return false;
}

function computeChannelYTop(
  sourceBounds: Bounds,
  targetBounds: Bounds,
  allBounds: Bounds[]
): number {
  let minTopY = Math.min(sourceBounds.y, targetBounds.y);
  const minX = Math.min(sourceBounds.x, targetBounds.x);
  const maxX = Math.max(sourceBounds.x + sourceBounds.width, targetBounds.x + targetBounds.width);
  for (const b of allBounds) {
    if (b.x + b.width >= minX && b.x <= maxX) {
      minTopY = Math.min(minTopY, b.y);
    }
  }
  return minTopY - 40;
}

function computeUpwardFeedbackWaypoints(src: Bounds, tgt: Bounds, channelY: number): Point[] {
  const srcTop: Point = {
    x: Math.round(src.x + src.width / 2),
    y: src.y,
  };
  const tgtTop: Point = {
    x: Math.round(tgt.x + tgt.width / 2),
    y: tgt.y,
  };
  return [srcTop, { x: srcTop.x, y: channelY }, { x: tgtTop.x, y: channelY }, tgtTop];
}

function computeChannelY(sourceBounds: Bounds, targetBounds: Bounds, allBounds?: Bounds[]): number {
  let maxBottomY = Math.max(
    sourceBounds.y + sourceBounds.height,
    targetBounds.y + targetBounds.height
  );

  if (allBounds) {
    const minX = Math.min(sourceBounds.x, targetBounds.x);
    for (let iter = 0; iter < 3; iter++) {
      const rawStepX = getClearSourceStepX(sourceBounds, maxBottomY + 40, allBounds);
      const maxX = Math.max(
        sourceBounds.x + sourceBounds.width,
        targetBounds.x + targetBounds.width,
        rawStepX
      );
      let changed = false;
      for (const b of allBounds) {
        if (b.x + b.width >= minX && b.x <= maxX && b.y + b.height > maxBottomY) {
          maxBottomY = b.y + b.height;
          changed = true;
        }
      }
      if (!changed) {
        break;
      }
    }
  }

  return maxBottomY + 40;
}

interface FeedbackRouteContext {
  channelY: number;
  allBounds?: Bounds[];
}

function getClearSourceStepX(src: Bounds, channelY: number, obstacles: Bounds[]): number {
  let stepX = src.x + src.width + 20;
  const srcRightY = Math.round(src.y + src.height / 2);
  const minY = Math.min(srcRightY, channelY);
  const maxY = Math.max(srcRightY, channelY);

  for (const b of obstacles) {
    if (b === src) {
      continue;
    }
    if (b.x + b.width >= stepX && b.x >= src.x) {
      if (axisIntervalsOverlap({ start: minY, end: maxY }, { start: b.y, end: b.y + b.height })) {
        stepX = Math.max(stepX, b.x + b.width + 20);
      }
    }
  }
  return stepX;
}

/**
 * First column right of `src` where the loop's drop from the source's
 * right-middle to `channelY` clears every shape by STEP_CLEARANCE.
 *
 * Unlike getClearSourceStepX -- which steps past every shape to the right
 * that merely shares the drop's y-range, and whose far-right answer the
 * upward/downward decision in hasBlockedDownwardFeedbackExit relies on --
 * this only steps past shapes that actually occupy the current column, so
 * the drawn route uses a free gap next to the source instead of running
 * horizontally through the rest of the row (#99).
 */
function getNearestClearSourceStepX(src: Bounds, channelY: number, obstacles: Bounds[]): number {
  let stepX = src.x + src.width + STEP_CLEARANCE;
  const span = { start: Math.round(src.y + src.height / 2), end: channelY };
  const blockers = obstacles
    .filter(
      (b) =>
        b !== src &&
        b.x + b.width + STEP_CLEARANCE > stepX &&
        axisIntervalsOverlap(span, { start: b.y, end: b.y + b.height })
    )
    .sort((a, b) => a.x - b.x);
  for (const b of blockers) {
    if (b.x - STEP_CLEARANCE < stepX) {
      stepX = Math.max(stepX, b.x + b.width + STEP_CLEARANCE);
    }
  }
  return stepX;
}

function getClearTargetStepX(tgt: Bounds, channelY: number, obstacles: Bounds[]): number {
  let stepX = tgt.x - 20;
  const tgtLeftY = Math.round(tgt.y + tgt.height / 2);
  const minY = Math.min(tgtLeftY, channelY);
  const maxY = Math.max(tgtLeftY, channelY);

  let minObstacleX = Infinity;
  for (const b of obstacles) {
    if (b === tgt) {
      continue;
    }
    if (verticalSegmentHitsBox(stepX, { start: minY, end: maxY }, b)) {
      minObstacleX = Math.min(minObstacleX, b.x);
    }
  }

  if (minObstacleX < Infinity) {
    stepX = minObstacleX - 30;
  }
  return stepX;
}

function computeFeedbackWaypoints(src: Bounds, tgt: Bounds, ctx: FeedbackRouteContext): Point[] {
  const srcBottom: Point = {
    x: Math.round(src.x + src.width / 2),
    y: src.y + src.height,
  };
  const tgtBottom: Point = {
    x: Math.round(tgt.x + tgt.width / 2),
    y: tgt.y + tgt.height,
  };

  const srcBlocked = hasObstacleBelow(srcBottom, ctx.channelY, {
    ignore: src,
    obstacles: ctx.allBounds,
  });
  const tgtBlocked = hasObstacleBelow(tgtBottom, ctx.channelY, {
    ignore: tgt,
    obstacles: ctx.allBounds,
  });

  const waypoints: Point[] = [];

  if (srcBlocked) {
    const srcRight: Point = { x: src.x + src.width, y: Math.round(src.y + src.height / 2) };
    const srcStepX = getNearestClearSourceStepX(src, ctx.channelY, ctx.allBounds!);
    waypoints.push(srcRight, { x: srcStepX, y: srcRight.y }, { x: srcStepX, y: ctx.channelY });
  } else {
    waypoints.push(srcBottom, { x: srcBottom.x, y: ctx.channelY });
  }

  if (tgtBlocked) {
    const tgtLeft: Point = { x: tgt.x, y: Math.round(tgt.y + tgt.height / 2) };
    const tgtStepX = getClearTargetStepX(tgt, ctx.channelY, ctx.allBounds!);
    waypoints.push({ x: tgtStepX, y: ctx.channelY }, { x: tgtStepX, y: tgtLeft.y }, tgtLeft);
  } else {
    waypoints.push({ x: tgtBottom.x, y: ctx.channelY }, tgtBottom);
  }

  return waypoints;
}

interface CollinearDetourContext {
  sourceBounds: Bounds;
  targetBounds: Bounds;
  channelY: number;
  allBounds?: Bounds[];
}

/**
 * Detours a currently-blocked but genuinely forward, currently-collinear
 * edge into a channel below everything and back up, the same shape of
 * route `computeFeedbackWaypoints` builds for a true loop-back -- but
 * anchored at the source's right edge and the target's left edge instead
 * of their bottom-centers, so a forward edge still visually leaves from
 * the right and arrives from the left even while detouring (a regression this fixes).
 * Falling back to bottom-center anchors here would make an ordinary
 * forward edge read as a loop-back whenever it needs to dodge an obstacle.
 */
function computeCollinearDetourWaypoints(
  srcExit: Point,
  tgtEntry: Point,
  ctx: CollinearDetourContext
): Point[] {
  const { sourceBounds, targetBounds, channelY, allBounds } = ctx;
  const waypoints: Point[] = [srcExit];

  const srcBlocked = hasObstacleBelow(srcExit, channelY, {
    ignore: sourceBounds,
    obstacles: allBounds,
  });
  if (srcBlocked) {
    const srcStepX = srcExit.x + 20;
    waypoints.push({ x: srcStepX, y: srcExit.y }, { x: srcStepX, y: channelY });
  } else {
    waypoints.push({ x: srcExit.x, y: channelY });
  }

  const tgtBlocked = hasObstacleBelow(tgtEntry, channelY, {
    ignore: targetBounds,
    obstacles: allBounds,
  });
  if (tgtBlocked) {
    const tgtStepX = getClearTargetStepX(targetBounds, channelY, allBounds!);
    waypoints.push({ x: tgtStepX, y: channelY }, { x: tgtStepX, y: tgtEntry.y });
  } else {
    waypoints.push({ x: tgtEntry.x, y: channelY });
  }

  waypoints.push(tgtEntry);
  return waypoints;
}

interface ForwardStepBlockerContext {
  yStart: number;
  yEnd: number;
  obstacles: Bounds[];
  ignore: Bounds[];
}

/**
 * The S-bend's vertical leg sits at `stepX` and must not pass through an
 * unrelated shape that now happens to sit between source and target (e.g. a
 * sibling gateway branch kept collinear with the gateway by issue #88's
 * fix). Finds the leftmost obstacle straddling `stepX` within the leg's
 * y-span, if any.
 */
function findForwardStepBlockerX(stepX: number, ctx: ForwardStepBlockerContext): number {
  const span = { start: ctx.yStart, end: ctx.yEnd };
  let blockingX = Infinity;
  for (const b of ctx.obstacles) {
    if (ctx.ignore.includes(b)) {
      continue;
    }
    if (verticalSegmentHitsBox(stepX, span, b)) {
      blockingX = Math.min(blockingX, b.x);
    }
  }
  return blockingX;
}

interface DepartureBlockerContext {
  srcExit: Point;
  stepX: number;
  obstacles: Bounds[];
  ignore: Bounds[];
}

function findHorizontalDepartureBlockerX(ctx: DepartureBlockerContext): number {
  let blockingX = Infinity;
  for (const b of ctx.obstacles) {
    if (ctx.ignore.includes(b)) {
      continue;
    }
    if (
      b.x > ctx.srcExit.x &&
      b.x < ctx.stepX &&
      ctx.srcExit.y > b.y &&
      ctx.srcExit.y < b.y + b.height
    ) {
      blockingX = Math.min(blockingX, b.x);
    }
  }
  return blockingX;
}

interface ClearForwardStepContext {
  srcExit: Point;
  tgtEntry: Point;
  obstacles: Bounds[] | undefined;
  ignore: Bounds[];
}

function findClearForwardStepX(initialStepX: number, ctx: ClearForwardStepContext): number {
  if (!ctx.obstacles || ctx.obstacles.length === 0) {
    return initialStepX;
  }
  let stepX = initialStepX;
  const depBlockerX = findHorizontalDepartureBlockerX({
    srcExit: ctx.srcExit,
    stepX,
    obstacles: ctx.obstacles,
    ignore: ctx.ignore,
  });
  if (depBlockerX < Infinity) {
    const depCandidate = depBlockerX - 20;
    if (depCandidate > ctx.srcExit.x) {
      stepX = depCandidate;
    }
  }
  const blockingX = findForwardStepBlockerX(stepX, {
    yStart: ctx.srcExit.y,
    yEnd: ctx.tgtEntry.y,
    obstacles: ctx.obstacles,
    ignore: ctx.ignore,
  });
  if (blockingX === Infinity) {
    return stepX;
  }
  const candidate = blockingX - 20;
  return candidate > ctx.srcExit.x ? candidate : stepX;
}

interface CollinearSpan {
  xStart: number;
  xEnd: number;
  ignore: Bounds[];
}

/**
 * Whether some obstacle sits directly on a straight collinear run between
 * two x positions at height `y` -- e.g. a chain of same-track nodes a
 * multi-rank bypass edge jumps over.
 */
function isCollinearPathBlocked(y: number, span: CollinearSpan, obstacles: Bounds[]): boolean {
  return isHorizontalSpanBlocked(
    y,
    { start: span.xStart, end: span.xEnd },
    { obstacles, ignore: span.ignore }
  );
}

interface VerticalSpan {
  yStart: number;
  yEnd: number;
  ignore: Bounds[];
}

function isVerticalPathBlocked(x: number, span: VerticalSpan, obstacles?: Bounds[]): boolean {
  return isVerticalSpanBlocked(
    x,
    { start: span.yStart, end: span.yEnd },
    { obstacles, ignore: span.ignore }
  );
}

function routeVerticalCollinearEdge(
  sourceBounds: Bounds,
  targetBounds: Bounds,
  allBounds?: Bounds[]
): Point[] | undefined {
  const srcCenterX = Math.round(sourceBounds.x + sourceBounds.width / 2);
  const tgtCenterX = Math.round(targetBounds.x + targetBounds.width / 2);
  if (Math.abs(srcCenterX - tgtCenterX) > 20) {
    return undefined;
  }

  if (sourceBounds.y >= targetBounds.y + targetBounds.height) {
    const srcTop: Point = { x: srcCenterX, y: sourceBounds.y };
    const tgtBottom: Point = { x: tgtCenterX, y: targetBounds.y + targetBounds.height };
    const span = { yStart: srcTop.y, yEnd: tgtBottom.y, ignore: [sourceBounds, targetBounds] };
    const blocked =
      isVerticalPathBlocked(srcCenterX, span, allBounds) ||
      isVerticalPathBlocked(tgtCenterX, span, allBounds);
    if (!blocked) {
      if (srcTop.x === tgtBottom.x) {
        return [srcTop, tgtBottom];
      }
      const midY = Math.round((srcTop.y + tgtBottom.y) / 2);
      return [srcTop, { x: srcTop.x, y: midY }, { x: tgtBottom.x, y: midY }, tgtBottom];
    }
  }

  if (sourceBounds.y + sourceBounds.height <= targetBounds.y) {
    const srcBottom: Point = { x: srcCenterX, y: sourceBounds.y + sourceBounds.height };
    const tgtTop: Point = { x: tgtCenterX, y: targetBounds.y };
    const span = { yStart: srcBottom.y, yEnd: tgtTop.y, ignore: [sourceBounds, targetBounds] };
    const blocked =
      isVerticalPathBlocked(srcCenterX, span, allBounds) ||
      isVerticalPathBlocked(tgtCenterX, span, allBounds);
    if (!blocked) {
      if (srcBottom.x === tgtTop.x) {
        return [srcBottom, tgtTop];
      }
      const midY = Math.round((srcBottom.y + tgtTop.y) / 2);
      return [srcBottom, { x: srcBottom.x, y: midY }, { x: tgtTop.x, y: midY }, tgtTop];
    }
  }

  return undefined;
}

export function routeOrthogonalEdge(
  sourceBounds: Bounds,
  targetBounds: Bounds,
  allBounds?: Bounds[]
): Point[] {
  const vertCollinear = routeVerticalCollinearEdge(sourceBounds, targetBounds, allBounds);
  if (vertCollinear) {
    return vertCollinear;
  }

  // If target is to the right of source (forward flow)
  if (sourceBounds.x + sourceBounds.width <= targetBounds.x) {
    const srcExit: Point = {
      x: sourceBounds.x + sourceBounds.width,
      y: Math.round(sourceBounds.y + sourceBounds.height / 2),
    };

    const tgtEntry: Point = {
      x: targetBounds.x,
      y: Math.round(targetBounds.y + targetBounds.height / 2),
    };

    // Straight collinear connection (0 bends), unless something now sits
    // between source and target on that same track -- a multi-rank edge
    // bypassing a chain of same-track nodes (e.g. a sibling branch kept
    // collinear with its gateway by issue #88) can no longer assume the
    // row is clear, since corridor routing is currently unwired (#81).
    if (srcExit.y === tgtEntry.y) {
      if (
        !allBounds ||
        !isCollinearPathBlocked(
          srcExit.y,
          { xStart: srcExit.x, xEnd: tgtEntry.x, ignore: [sourceBounds, targetBounds] },
          allBounds
        )
      ) {
        return [srcExit, tgtEntry];
      }
      // Drop into a channel below everything -- and, critically, check
      // both the drop and the return leg for obstacles first, the same
      // way a true feedback/loop-back edge does. An earlier version built
      // this route by hand with no such check, so it could plow straight
      // through some unrelated shape on the way back up.
      const channelY = computeChannelY(sourceBounds, targetBounds, allBounds);
      return computeCollinearDetourWaypoints(srcExit, tgtEntry, {
        sourceBounds,
        targetBounds,
        channelY,
        allBounds,
      });
    }

    // Forward S-bend (Manhattan step with 2 bends)
    const gap = tgtEntry.x - srcExit.x;
    const stepX = gap > 100 ? tgtEntry.x - 30 : Math.round((srcExit.x + tgtEntry.x) / 2);
    const clearStepX = findClearForwardStepX(stepX, {
      srcExit,
      tgtEntry,
      obstacles: allBounds,
      ignore: [sourceBounds, targetBounds],
    });
    return [srcExit, { x: clearStepX, y: srcExit.y }, { x: clearStepX, y: tgtEntry.y }, tgtEntry];
  }

  // Feedback loop upward if clear
  if (allBounds && shouldUseUpwardFeedbackRoute(sourceBounds, targetBounds, allBounds)) {
    const channelY = computeChannelYTop(sourceBounds, targetBounds, allBounds);
    return computeUpwardFeedbackWaypoints(sourceBounds, targetBounds, channelY);
  }

  // Forward wrapped edge (target is on a lower row and behind source)
  if (sourceBounds.y + sourceBounds.height + 20 <= targetBounds.y) {
    return routeForwardWrappedEdge(sourceBounds, targetBounds);
  }

  // Feedback loop (target is at or behind source)
  const channelY = computeChannelY(sourceBounds, targetBounds, allBounds);
  return computeFeedbackWaypoints(sourceBounds, targetBounds, { channelY, allBounds });
}

function routeForwardWrappedEdge(src: Bounds, tgt: Bounds): Point[] {
  const srcRight: Point = {
    x: src.x + src.width,
    y: Math.round(src.y + src.height / 2),
  };
  const tgtLeft: Point = {
    x: tgt.x,
    y: Math.round(tgt.y + tgt.height / 2),
  };
  const midY = Math.round((src.y + src.height + tgt.y) / 2);
  const stepSrcX = srcRight.x + 20;
  const stepTgtX = tgtLeft.x - 20;
  return [
    srcRight,
    { x: stepSrcX, y: srcRight.y },
    { x: stepSrcX, y: midY },
    { x: stepTgtX, y: midY },
    { x: stepTgtX, y: tgtLeft.y },
    tgtLeft,
  ];
}
