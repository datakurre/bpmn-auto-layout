import { describe, it, expect } from 'vitest';
import {
  axisIntervalsOverlap,
  verticalSegmentHitsBox,
  horizontalSegmentHitsBox,
  isVerticalSpanBlocked,
  isHorizontalSpanBlocked,
} from '../src/graph/obstacles';
import type { Bounds } from '../src/types';

const box: Bounds = { x: 100, y: 100, width: 50, height: 50 };

describe('axisIntervalsOverlap', () => {
  it('is true when the intervals overlap', () => {
    expect(axisIntervalsOverlap({ start: 0, end: 10 }, { start: 5, end: 15 })).toBe(true);
  });

  it('is false when the intervals only touch', () => {
    expect(axisIntervalsOverlap({ start: 0, end: 10 }, { start: 10, end: 20 })).toBe(false);
  });

  it('gives the same result regardless of endpoint order', () => {
    expect(axisIntervalsOverlap({ start: 10, end: 0 }, { start: 15, end: 5 })).toBe(true);
  });
});

describe('verticalSegmentHitsBox', () => {
  it('is true for a segment clearly crossing the box', () => {
    expect(verticalSegmentHitsBox(125, { start: 80, end: 200 }, box)).toBe(true);
  });

  it('is false when the segment only touches the box edge (x)', () => {
    expect(verticalSegmentHitsBox(100, { start: 80, end: 200 }, box)).toBe(false);
    expect(verticalSegmentHitsBox(150, { start: 80, end: 200 }, box)).toBe(false);
  });

  it('is false when the span only touches the box edge (y)', () => {
    expect(verticalSegmentHitsBox(125, { start: 0, end: 100 }, box)).toBe(false);
    expect(verticalSegmentHitsBox(125, { start: 150, end: 250 }, box)).toBe(false);
  });

  it('gives the same result regardless of span endpoint order', () => {
    expect(verticalSegmentHitsBox(125, { start: 200, end: 80 }, box)).toBe(true);
  });

  it('is false when the segment is fully outside the box horizontally', () => {
    expect(verticalSegmentHitsBox(10, { start: 80, end: 200 }, box)).toBe(false);
  });
});

describe('horizontalSegmentHitsBox', () => {
  it('is true for a segment clearly crossing the box', () => {
    expect(horizontalSegmentHitsBox(125, { start: 80, end: 200 }, box)).toBe(true);
  });

  it('is false when the segment only touches the box edge (y)', () => {
    expect(horizontalSegmentHitsBox(100, { start: 80, end: 200 }, box)).toBe(false);
    expect(horizontalSegmentHitsBox(150, { start: 80, end: 200 }, box)).toBe(false);
  });

  it('is false when the span only touches the box edge (x)', () => {
    expect(horizontalSegmentHitsBox(125, { start: 0, end: 100 }, box)).toBe(false);
    expect(horizontalSegmentHitsBox(125, { start: 150, end: 250 }, box)).toBe(false);
  });

  it('gives the same result regardless of span endpoint order', () => {
    expect(horizontalSegmentHitsBox(125, { start: 200, end: 80 }, box)).toBe(true);
  });
});

describe('isVerticalSpanBlocked', () => {
  it('is false when obstacles is undefined or empty', () => {
    expect(isVerticalSpanBlocked(125, { start: 80, end: 200 })).toBe(false);
    expect(isVerticalSpanBlocked(125, { start: 80, end: 200 }, { obstacles: [] })).toBe(false);
  });

  it('is true when an obstacle blocks the span', () => {
    expect(isVerticalSpanBlocked(125, { start: 80, end: 200 }, { obstacles: [box] })).toBe(true);
  });

  it('ignores obstacles listed in opts.ignore', () => {
    expect(
      isVerticalSpanBlocked(125, { start: 80, end: 200 }, { obstacles: [box], ignore: [box] })
    ).toBe(false);
  });
});

describe('isHorizontalSpanBlocked', () => {
  it('is false when obstacles is undefined or empty', () => {
    expect(isHorizontalSpanBlocked(125, { start: 80, end: 200 })).toBe(false);
    expect(isHorizontalSpanBlocked(125, { start: 80, end: 200 }, { obstacles: [] })).toBe(false);
  });

  it('is true when an obstacle blocks the span', () => {
    expect(isHorizontalSpanBlocked(125, { start: 80, end: 200 }, { obstacles: [box] })).toBe(true);
  });

  it('ignores obstacles listed in opts.ignore', () => {
    expect(
      isHorizontalSpanBlocked(125, { start: 80, end: 200 }, { obstacles: [box], ignore: [box] })
    ).toBe(false);
  });
});
