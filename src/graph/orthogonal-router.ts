import type { Bounds, Point } from '../types';

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
  // Compute clearance below all relevant shapes
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

  const channelY = maxBottomY + 40;
  const srcBottom: Point = {
    x: Math.round(sourceBounds.x + sourceBounds.width / 2),
    y: sourceBounds.y + sourceBounds.height,
  };
  const tgtBottom: Point = {
    x: Math.round(targetBounds.x + targetBounds.width / 2),
    y: targetBounds.y + targetBounds.height,
  };

  return [srcBottom, { x: srcBottom.x, y: channelY }, { x: tgtBottom.x, y: channelY }, tgtBottom];
}
