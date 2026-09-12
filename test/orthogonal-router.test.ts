import { describe, it, expect } from 'vitest';
import { routeOrthogonalEdge } from '../src/graph/orthogonal-router';
import type { Bounds } from '../src/types';

describe('orthogonal-router', () => {
  it('routes forward collinear connection with 0 bends', () => {
    const src: Bounds = { x: 100, y: 100, width: 100, height: 80 };
    const tgt: Bounds = { x: 300, y: 100, width: 100, height: 80 };
    const waypoints = routeOrthogonalEdge(src, tgt);
    expect(waypoints).toEqual([
      { x: 200, y: 140 },
      { x: 300, y: 140 },
    ]);
  });

  it('routes forward non-collinear connection with gap > 100', () => {
    const src: Bounds = { x: 100, y: 100, width: 100, height: 80 };
    const tgt: Bounds = { x: 350, y: 200, width: 100, height: 80 };
    const waypoints = routeOrthogonalEdge(src, tgt);
    expect(waypoints).toHaveLength(4);
    expect(waypoints[0]).toEqual({ x: 200, y: 140 });
    // gap is 350 - 200 = 150 > 100, so stepX = 350 - 30 = 320
    expect(waypoints[1]).toEqual({ x: 320, y: 140 });
    expect(waypoints[2]).toEqual({ x: 320, y: 240 });
    expect(waypoints[3]).toEqual({ x: 350, y: 240 });
  });

  it('routes forward non-collinear connection with gap <= 100', () => {
    const src: Bounds = { x: 100, y: 100, width: 100, height: 80 };
    const tgt: Bounds = { x: 250, y: 200, width: 100, height: 80 };
    const waypoints = routeOrthogonalEdge(src, tgt);
    expect(waypoints).toHaveLength(4);
    expect(waypoints[0]).toEqual({ x: 200, y: 140 });
    // gap is 250 - 200 = 50 <= 100, so stepX = round((200 + 250) / 2) = 225
    expect(waypoints[1]).toEqual({ x: 225, y: 140 });
    expect(waypoints[2]).toEqual({ x: 225, y: 240 });
    expect(waypoints[3]).toEqual({ x: 250, y: 240 });
  });

  it('routes feedback loop when allBounds is omitted', () => {
    const src: Bounds = { x: 300, y: 100, width: 100, height: 80 };
    const tgt: Bounds = { x: 100, y: 100, width: 100, height: 80 };
    const waypoints = routeOrthogonalEdge(src, tgt);
    // Neither blocked, exits bottom of src, enters bottom of tgt
    expect(waypoints).toHaveLength(4);
    expect(waypoints[0]).toEqual({ x: 350, y: 180 });
    expect(waypoints[3]).toEqual({ x: 150, y: 180 });
  });

  it('routes feedback loop when tgt is blocked but stepX is clear and non-intersecting Y obstacle exists', () => {
    const src: Bounds = { x: 300, y: 100, width: 100, height: 80 };
    const tgt: Bounds = { x: 100, y: 100, width: 100, height: 80 };
    const obsBelowTgt: Bounds = { x: 140, y: 190, width: 20, height: 40 };
    // Matches stepX (80) in X, but Y is above tgtLeftY (140)
    const obsAboveY: Bounds = { x: 70, y: 0, width: 30, height: 50 };

    const waypoints = routeOrthogonalEdge(src, tgt, [src, tgt, obsBelowTgt, obsAboveY]);

    expect(waypoints[waypoints.length - 1]).toEqual({ x: 100, y: 140 });
    // stepX is default tgt.x - 20 = 80
    expect(waypoints[waypoints.length - 2]).toEqual({ x: 80, y: 140 });
  });

  it('routes feedback loop with srcBlocked and tgtBlocked including obstacle blocking stepX', () => {
    const src: Bounds = { x: 400, y: 100, width: 100, height: 80 };
    const tgt: Bounds = { x: 100, y: 100, width: 100, height: 80 };
    // Obstacle below src: x: 440 to 460, y: 190 to 230
    const obsBelowSrc: Bounds = { x: 440, y: 190, width: 20, height: 40 };
    // Obstacle below tgt: x: 140 to 160, y: 190 to 230
    const obsBelowTgt: Bounds = { x: 140, y: 190, width: 20, height: 40 };
    // Obstacle blocking default stepX (tgt.x - 20 = 80): x: 75 to 95, y: 120 to 160
    const obsBlockStepX: Bounds = { x: 75, y: 120, width: 20, height: 40 };

    const waypoints = routeOrthogonalEdge(src, tgt, [
      src,
      tgt,
      obsBelowSrc,
      obsBelowTgt,
      obsBlockStepX,
    ]);

    // src is blocked below -> exits right
    expect(waypoints[0]).toEqual({ x: 500, y: 140 });
    // tgt is blocked below -> enters left at clear stepX (minObstacleX - 30 = 75 - 30 = 45)
    expect(waypoints[waypoints.length - 1]).toEqual({ x: 100, y: 140 });
    expect(waypoints[waypoints.length - 2]).toEqual({ x: 45, y: 140 });
  });
});
