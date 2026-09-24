import type { Bounds } from '../types';

/**
 * A 1-D span along one axis. `start`/`end` are order-independent: callers
 * don't need to know in advance which endpoint is smaller.
 */
export interface AxisSpan {
  start: number;
  end: number;
}

/** Open-interval overlap test between two order-independent spans. */
export function axisIntervalsOverlap(span1: AxisSpan, span2: AxisSpan): boolean {
  const min1 = Math.min(span1.start, span1.end);
  const max1 = Math.max(span1.start, span1.end);
  const min2 = Math.min(span2.start, span2.end);
  const max2 = Math.max(span2.start, span2.end);
  return Math.max(min1, min2) < Math.min(max1, max2);
}

/**
 * Does a vertical segment at `x`, spanning `span` (order-independent),
 * pass through the inside of `b`? Touching a box edge does not count.
 */
export function verticalSegmentHitsBox(x: number, span: AxisSpan, b: Bounds): boolean {
  if (!(x > b.x && x < b.x + b.width)) {
    return false;
  }
  const minY = Math.min(span.start, span.end);
  const maxY = Math.max(span.start, span.end);
  return Math.max(minY, b.y) < Math.min(maxY, b.y + b.height);
}

/**
 * Does a horizontal segment at `y`, spanning `span` (order-independent),
 * pass through the inside of `b`? Touching a box edge does not count.
 */
export function horizontalSegmentHitsBox(y: number, span: AxisSpan, b: Bounds): boolean {
  if (!(y > b.y && y < b.y + b.height)) {
    return false;
  }
  const minX = Math.min(span.start, span.end);
  const maxX = Math.max(span.start, span.end);
  return Math.max(minX, b.x) < Math.min(maxX, b.x + b.width);
}

export interface SpanBlockOptions {
  obstacles?: Bounds[];
  ignore?: Bounds[];
}

/** Is a vertical segment at `x` blocked by any of `opts.obstacles` (other than `opts.ignore`)? */
export function isVerticalSpanBlocked(
  x: number,
  span: AxisSpan,
  opts: SpanBlockOptions = {}
): boolean {
  const { obstacles, ignore } = opts;
  if (!obstacles || obstacles.length === 0) {
    return false;
  }
  return obstacles.some((b) => !ignore?.includes(b) && verticalSegmentHitsBox(x, span, b));
}

/** Is a horizontal segment at `y` blocked by any of `opts.obstacles` (other than `opts.ignore`)? */
export function isHorizontalSpanBlocked(
  y: number,
  span: AxisSpan,
  opts: SpanBlockOptions = {}
): boolean {
  const { obstacles, ignore } = opts;
  if (!obstacles || obstacles.length === 0) {
    return false;
  }
  return obstacles.some((b) => !ignore?.includes(b) && horizontalSegmentHitsBox(y, span, b));
}
