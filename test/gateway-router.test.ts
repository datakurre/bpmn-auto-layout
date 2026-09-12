import { describe, it, expect } from 'vitest';
import type { Bounds } from '../src/types';
import {
  isVerticalCorridorClear,
  isHorizontalCorridorClear,
  routeGatewayOutgoingEdges,
  type GatewayFlowInfo,
} from '../src/graph/gateway-router';

describe('gateway-router', () => {
  const gwBounds: Bounds = { x: 200, y: 200, width: 50, height: 50 };

  describe('isVerticalCorridorClear', () => {
    it('returns true when obstacles are undefined or empty', () => {
      expect(isVerticalCorridorClear(225, { start: 100, end: 200 })).toBe(true);
      expect(isVerticalCorridorClear(225, { start: 100, end: 200 }, [])).toBe(true);
    });

    it('returns false when an obstacle intersects the vertical span', () => {
      const obstacles: Bounds[] = [{ x: 200, y: 120, width: 50, height: 50 }];
      expect(isVerticalCorridorClear(225, { start: 100, end: 200 }, obstacles)).toBe(false);
      // reversed start/end
      expect(isVerticalCorridorClear(225, { start: 200, end: 100 }, obstacles)).toBe(false);
    });

    it('returns true when obstacle matches X but not Y', () => {
      const obstacles: Bounds[] = [{ x: 200, y: 300, width: 50, height: 50 }];
      expect(isVerticalCorridorClear(225, { start: 100, end: 200 }, obstacles)).toBe(true);
    });

    it('returns true when obstacle does not match X', () => {
      const obstacles: Bounds[] = [{ x: 300, y: 120, width: 50, height: 50 }];
      expect(isVerticalCorridorClear(225, { start: 100, end: 200 }, obstacles)).toBe(true);
    });
  });

  describe('isHorizontalCorridorClear', () => {
    it('returns true when obstacles are undefined or empty', () => {
      expect(isHorizontalCorridorClear(225, { start: 100, end: 200 })).toBe(true);
      expect(isHorizontalCorridorClear(225, { start: 100, end: 200 }, [])).toBe(true);
    });

    it('returns false when an obstacle intersects the horizontal span', () => {
      const obstacles: Bounds[] = [{ x: 120, y: 200, width: 50, height: 50 }];
      expect(isHorizontalCorridorClear(225, { start: 100, end: 200 }, obstacles)).toBe(false);
      // reversed start/end
      expect(isHorizontalCorridorClear(225, { start: 200, end: 100 }, obstacles)).toBe(false);
    });

    it('returns true when obstacle matches Y but not X', () => {
      const obstacles: Bounds[] = [{ x: 300, y: 200, width: 50, height: 50 }];
      expect(isHorizontalCorridorClear(225, { start: 100, end: 200 }, obstacles)).toBe(true);
    });

    it('returns true when obstacle does not match Y', () => {
      const obstacles: Bounds[] = [{ x: 120, y: 300, width: 50, height: 50 }];
      expect(isHorizontalCorridorClear(225, { start: 100, end: 200 }, obstacles)).toBe(true);
    });
  });

  describe('routeGatewayOutgoingEdges', () => {
    it('routes collinear forward target via direct right with 0 bends', () => {
      const tgtBounds: Bounds = { x: 400, y: 185, width: 100, height: 80 }; // center Y = 225
      const flows: GatewayFlowInfo[] = [{ flow: { id: 'Flow_1' }, targetBounds: tgtBounds }];

      const routeMap = routeGatewayOutgoingEdges(flows, { gatewayBounds: gwBounds });
      const pts = routeMap.get('Flow_1')!;
      expect(pts).toHaveLength(2);
      expect(pts[0]).toEqual({ x: 250, y: 225 });
      expect(pts[1]).toEqual({ x: 400, y: 225 });
    });

    it('routes target above via direct top and target below via direct bottom', () => {
      const tgtAbove: Bounds = { x: 400, y: 50, width: 100, height: 80 }; // center Y = 90
      const tgtBelow: Bounds = { x: 400, y: 350, width: 100, height: 80 }; // center Y = 390
      const flows: GatewayFlowInfo[] = [
        { flow: { id: 'Flow_Above' }, targetBounds: tgtAbove },
        { flow: { id: 'Flow_Below' }, targetBounds: tgtBelow },
      ];

      const routeMap = routeGatewayOutgoingEdges(flows, {
        gatewayBounds: gwBounds,
        allBounds: [gwBounds, tgtAbove, tgtBelow],
      });

      const ptsTop = routeMap.get('Flow_Above')!;
      expect(ptsTop).toHaveLength(3);
      expect(ptsTop[0]).toEqual({ x: 225, y: 200 }); // exit Top
      expect(ptsTop[1]).toEqual({ x: 225, y: 90 });
      expect(ptsTop[2]).toEqual({ x: 400, y: 90 }); // entry target

      const ptsBottom = routeMap.get('Flow_Below')!;
      expect(ptsBottom).toHaveLength(3);
      expect(ptsBottom[0]).toEqual({ x: 225, y: 250 }); // exit Bottom
      expect(ptsBottom[1]).toEqual({ x: 225, y: 390 });
      expect(ptsBottom[2]).toEqual({ x: 400, y: 390 }); // entry target
    });

    it('falls back to right port when top corridor is obstructed', () => {
      const tgtAbove: Bounds = { x: 400, y: 50, width: 100, height: 80 }; // center Y = 90
      // Obstacle blocking the vertical corridor at x = 225
      const blocker: Bounds = { x: 210, y: 120, width: 30, height: 30 };
      const flows: GatewayFlowInfo[] = [{ flow: { id: 'Flow_Above' }, targetBounds: tgtAbove }];

      const routeMap = routeGatewayOutgoingEdges(flows, {
        gatewayBounds: gwBounds,
        allBounds: [gwBounds, tgtAbove, blocker],
      });

      const pts = routeMap.get('Flow_Above')!;
      // Obstructed -> routed via Right port (S-bend, 4 points)
      expect(pts).toHaveLength(4);
      expect(pts[0]).toEqual({ x: 250, y: 225 }); // exit Right
    });

    it('falls back to right port when horizontal corridor of top path is obstructed', () => {
      const tgtAbove: Bounds = { x: 400, y: 50, width: 100, height: 80 }; // center Y = 90
      // Obstacle blocking the horizontal corridor at y = 90 between x=225 and x=400
      const blocker: Bounds = { x: 280, y: 80, width: 30, height: 30 };
      const flows: GatewayFlowInfo[] = [{ flow: { id: 'Flow_Above' }, targetBounds: tgtAbove }];

      const routeMap = routeGatewayOutgoingEdges(flows, {
        gatewayBounds: gwBounds,
        allBounds: [gwBounds, tgtAbove, blocker],
      });

      const pts = routeMap.get('Flow_Above')!;
      expect(pts).toHaveLength(4);
      expect(pts[0]).toEqual({ x: 250, y: 225 });
    });

    it('falls back to right port when bottom corridor is obstructed', () => {
      const tgtBelow: Bounds = { x: 400, y: 350, width: 100, height: 80 }; // center Y = 390
      // Obstacle blocking vertical corridor at x = 225
      const blocker: Bounds = { x: 210, y: 280, width: 30, height: 30 };
      const flows: GatewayFlowInfo[] = [{ flow: { id: 'Flow_Below' }, targetBounds: tgtBelow }];

      const routeMap = routeGatewayOutgoingEdges(flows, {
        gatewayBounds: gwBounds,
        allBounds: [gwBounds, tgtBelow, blocker],
      });

      const pts = routeMap.get('Flow_Below')!;
      expect(pts).toHaveLength(4);
      expect(pts[0]).toEqual({ x: 250, y: 225 });
    });

    it('sorts multiple above and multiple below targets and routes surplus to right port', () => {
      // Multiple above targets (exercising sort comparator)
      const tgtAbove1: Bounds = { x: 500, y: 20, width: 100, height: 80 }; // center Y = 60
      const tgtAbove2: Bounds = { x: 500, y: 100, width: 100, height: 80 }; // center Y = 140
      // Multiple below targets (exercising sort comparator)
      const tgtBelow1: Bounds = { x: 500, y: 300, width: 100, height: 80 }; // center Y = 340
      const tgtBelow2: Bounds = { x: 500, y: 400, width: 100, height: 80 }; // center Y = 440

      const flows: GatewayFlowInfo[] = [
        { flow: { id: 'Flow_Above2' }, targetBounds: tgtAbove2 },
        { flow: { id: 'Flow_Above1' }, targetBounds: tgtAbove1 },
        { flow: { id: 'Flow_Below1' }, targetBounds: tgtBelow1 },
        { flow: { id: 'Flow_Below2' }, targetBounds: tgtBelow2 },
      ];

      const routeMap = routeGatewayOutgoingEdges(flows, {
        gatewayBounds: gwBounds,
        allBounds: [gwBounds, tgtAbove1, tgtAbove2, tgtBelow1, tgtBelow2],
      });

      // Above1 is furthest above -> gets Top port
      const ptsTop = routeMap.get('Flow_Above1')!;
      expect(ptsTop[0]).toEqual({ x: 225, y: 200 });

      // Below2 is furthest below -> gets Bottom port
      const ptsBottom = routeMap.get('Flow_Below2')!;
      expect(ptsBottom[0]).toEqual({ x: 225, y: 250 });

      // Above2 and Below1 get Right port with staggered stepX offsets
      const ptsR1 = routeMap.get('Flow_Above2')!;
      const ptsR2 = routeMap.get('Flow_Below1')!;
      expect(ptsR1[0]).toEqual({ x: 250, y: 225 });
      expect(ptsR2[0]).toEqual({ x: 250, y: 225 });
      expect(ptsR2[1].x).toBeGreaterThan(ptsR1[1].x);
    });

    it('routes right flow with entryX - exitX <= 100 using midpoint', () => {
      // exitX = 250, entryX = 300 (diff = 50 <= 100)
      const tgtClose: Bounds = { x: 300, y: 100, width: 100, height: 80 };
      const flows: GatewayFlowInfo[] = [{ flow: { id: 'Flow_Close' }, targetBounds: tgtClose }];

      // Obstruct top so it must go right
      const blocker: Bounds = { x: 210, y: 120, width: 30, height: 30 };
      const routeMap = routeGatewayOutgoingEdges(flows, {
        gatewayBounds: gwBounds,
        allBounds: [gwBounds, tgtClose, blocker],
      });

      const pts = routeMap.get('Flow_Close')!;
      expect(pts).toHaveLength(4);
      // midpoint between 250 and 300 is 275
      expect(pts[1].x).toBe(275);
    });

    it('disables bottom port when gateway has incoming feedback edge', () => {
      const tgtBelow: Bounds = { x: 400, y: 350, width: 100, height: 80 };
      const flows: GatewayFlowInfo[] = [{ flow: { id: 'Flow_Below' }, targetBounds: tgtBelow }];

      const routeMap = routeGatewayOutgoingEdges(flows, {
        gatewayBounds: gwBounds,
        hasIncomingFeedback: true,
      });

      const pts = routeMap.get('Flow_Below')!;
      // Bottom disabled -> exits Right
      expect(pts[0]).toEqual({ x: 250, y: 225 });
    });

    it('routes targets above and below when allBounds is omitted', () => {
      const tgtAbove: Bounds = { x: 400, y: 50, width: 100, height: 80 };
      const tgtBelow: Bounds = { x: 400, y: 350, width: 100, height: 80 };
      const flows: GatewayFlowInfo[] = [
        { flow: { id: 'Flow_Above' }, targetBounds: tgtAbove },
        { flow: { id: 'Flow_Below' }, targetBounds: tgtBelow },
      ];

      const routeMap = routeGatewayOutgoingEdges(flows, {
        gatewayBounds: gwBounds,
      });

      expect(routeMap.get('Flow_Above')).toBeDefined();
      expect(routeMap.get('Flow_Below')).toBeDefined();
    });

    it('handles backward and explicit feedback edges and disables bottom port for forward below flows', () => {
      // Backward target (target.x < gw.x + gw.width)
      const tgtBack: Bounds = { x: 50, y: 185, width: 100, height: 80 };
      const tgtBelow: Bounds = { x: 400, y: 350, width: 100, height: 80 };
      const flows: GatewayFlowInfo[] = [
        { flow: { id: 'Flow_Back' }, targetBounds: tgtBack, isFeedback: true },
        { flow: { id: 'Flow_Below' }, targetBounds: tgtBelow },
      ];

      const routeMap = routeGatewayOutgoingEdges(flows, {
        gatewayBounds: gwBounds,
        allBounds: [gwBounds, tgtBack, tgtBelow],
      });

      // Backward flow routed via orthogonal router
      const ptsBack = routeMap.get('Flow_Back')!;
      expect(ptsBack.length).toBeGreaterThanOrEqual(2);

      // Forward flow below routed via Right because hasOutgoingFeedback disabled bottom
      const ptsBelow = routeMap.get('Flow_Below')!;
      expect(ptsBelow[0]).toEqual({ x: 250, y: 225 });
    });
  });
});
