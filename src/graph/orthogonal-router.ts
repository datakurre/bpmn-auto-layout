import type { Bounds, Point } from '../types';

interface ObstacleCheckContext {
  ignore: Bounds;
  obstacles?: Bounds[];
}

function hasObstacleBelow(pt: Point, endY: number, ctx: ObstacleCheckContext): boolean {
  if (!ctx.obstacles) {
    return false;
  }
  return ctx.obstacles.some(
    (b) => b !== ctx.ignore && pt.x > b.x && pt.x < b.x + b.width && b.y >= pt.y && b.y < endY
  );
}

function computeChannelY(sourceBounds: Bounds, targetBounds: Bounds, allBounds?: Bounds[]): number {
  let maxBottomY = Math.max(
    sourceBounds.y + sourceBounds.height,
    targetBounds.y + targetBounds.height
  );

  if (allBounds) {
    const minX = Math.min(sourceBounds.x, targetBounds.x);
    const maxX = Math.max(sourceBounds.x + sourceBounds.width, targetBounds.x + targetBounds.width);
    for (const b of allBounds) {
      if (b.x + b.width >= minX && b.x <= maxX) {
        maxBottomY = Math.max(maxBottomY, b.y + b.height);
      }
    }
  }

  return maxBottomY + 40;
}

interface FeedbackRouteContext {
  channelY: number;
  allBounds?: Bounds[];
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
    const srcStepX = src.x + src.width + 20;
    waypoints.push(srcRight, { x: srcStepX, y: srcRight.y }, { x: srcStepX, y: ctx.channelY });
  } else {
    waypoints.push(srcBottom, { x: srcBottom.x, y: ctx.channelY });
  }

  if (tgtBlocked) {
    const tgtLeft: Point = { x: tgt.x, y: Math.round(tgt.y + tgt.height / 2) };
    const tgtStepX = tgt.x - 20;
    waypoints.push({ x: tgtStepX, y: ctx.channelY }, { x: tgtStepX, y: tgtLeft.y }, tgtLeft);
  } else {
    waypoints.push({ x: tgtBottom.x, y: ctx.channelY }, tgtBottom);
  }

  return waypoints;
}

export function routeOrthogonalEdge(
  sourceBounds: Bounds,
  targetBounds: Bounds,
  allBounds?: Bounds[]
): Point[] {
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

    // Straight collinear connection (0 bends)
    if (srcExit.y === tgtEntry.y) {
      return [srcExit, tgtEntry];
    }

    // Forward S-bend (Manhattan step with 2 bends)
    const gap = tgtEntry.x - srcExit.x;
    const stepX = gap > 100 ? tgtEntry.x - 30 : Math.round((srcExit.x + tgtEntry.x) / 2);
    return [srcExit, { x: stepX, y: srcExit.y }, { x: stepX, y: tgtEntry.y }, tgtEntry];
  }

  // Feedback loop (target is at or behind source)
  const channelY = computeChannelY(sourceBounds, targetBounds, allBounds);
  return computeFeedbackWaypoints(sourceBounds, targetBounds, { channelY, allBounds });
}
