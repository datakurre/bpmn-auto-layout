import type { Bounds, Point } from '../types';
import { routeOrthogonalEdge } from './orthogonal-router';

export interface GatewayFlowInfo {
  flow: any;
  targetBounds: Bounds;
  isFeedback?: boolean;
}

export interface GatewayIncomingFlowInfo {
  flow: any;
  sourceBounds: Bounds;
  isFeedback?: boolean;
}

export interface GatewayRouteOptions {
  gatewayBounds: Bounds;
  allBounds?: Bounds[];
  hasIncomingFeedback?: boolean;
  usedPorts?: Set<'top' | 'bottom' | 'left' | 'right'>;
}

export interface GatewayIncomingRouteOptions {
  gatewayBounds: Bounds;
  allBounds?: Bounds[];
  hasIncomingFeedback?: boolean;
  usedPorts?: Set<'top' | 'bottom' | 'left' | 'right'>;
}

export interface LinearSpan {
  start: number;
  end: number;
}

interface CorridorEndpoints {
  vStart: number;
  vEnd: number;
  hStart: number;
  hEnd: number;
  hY: number;
  vX: number;
}

export function isVerticalCorridorClear(
  x: number,
  span: LinearSpan,
  obstacles?: Bounds[]
): boolean {
  if (!obstacles || obstacles.length === 0) {
    return true;
  }
  const minY = Math.min(span.start, span.end);
  const maxY = Math.max(span.start, span.end);

  for (const b of obstacles) {
    if (x > b.x && x < b.x + b.width) {
      if (Math.max(minY, b.y) < Math.min(maxY, b.y + b.height)) {
        return false;
      }
    }
  }
  return true;
}

export function isHorizontalCorridorClear(
  y: number,
  span: LinearSpan,
  obstacles?: Bounds[]
): boolean {
  if (!obstacles || obstacles.length === 0) {
    return true;
  }
  const minX = Math.min(span.start, span.end);
  const maxX = Math.max(span.start, span.end);

  for (const b of obstacles) {
    if (y > b.y && y < b.y + b.height) {
      if (Math.max(minX, b.x) < Math.min(maxX, b.x + b.width)) {
        return false;
      }
    }
  }
  return true;
}

function checkDirectPortClear(endpoints: CorridorEndpoints, obstacles?: Bounds[]): boolean {
  const vClear = isVerticalCorridorClear(
    endpoints.vX,
    { start: endpoints.vStart, end: endpoints.vEnd },
    obstacles
  );
  if (!vClear) {
    return false;
  }
  return isHorizontalCorridorClear(
    endpoints.hY,
    { start: endpoints.hStart, end: endpoints.hEnd },
    obstacles
  );
}

function routeDirectTop(gw: Bounds, tgt: Bounds): Point[] {
  const exitX = Math.round(gw.x + gw.width / 2);
  const exitY = gw.y;
  const entryX = tgt.x;
  const entryY = Math.round(tgt.y + tgt.height / 2);
  return [
    { x: exitX, y: exitY },
    { x: exitX, y: entryY },
    { x: entryX, y: entryY },
  ];
}

function routeDirectBottom(gw: Bounds, tgt: Bounds): Point[] {
  const exitX = Math.round(gw.x + gw.width / 2);
  const exitY = gw.y + gw.height;
  const entryX = tgt.x;
  const entryY = Math.round(tgt.y + tgt.height / 2);
  return [
    { x: exitX, y: exitY },
    { x: exitX, y: entryY },
    { x: entryX, y: entryY },
  ];
}

function routeDirectRight(gw: Bounds, tgt: Bounds, stepXOffset = 0): Point[] {
  const exitX = gw.x + gw.width;
  const exitY = Math.round(gw.y + gw.height / 2);
  const entryX = tgt.x;
  const entryY = Math.round(tgt.y + tgt.height / 2);

  if (exitY === entryY) {
    return [
      { x: exitX, y: exitY },
      { x: entryX, y: entryY },
    ];
  }

  const baseStepX = entryX - exitX > 100 ? entryX - 30 : Math.round((exitX + entryX) / 2);
  const stepX = baseStepX + stepXOffset;
  return [
    { x: exitX, y: exitY },
    { x: stepX, y: exitY },
    { x: stepX, y: entryY },
    { x: entryX, y: entryY },
  ];
}

function routeDirectIncomingTop(src: Bounds, gw: Bounds): Point[] {
  const exitX = src.x + src.width;
  const exitY = Math.round(src.y + src.height / 2);
  const entryX = Math.round(gw.x + gw.width / 2);
  const entryY = gw.y;
  return [
    { x: exitX, y: exitY },
    { x: entryX, y: exitY },
    { x: entryX, y: entryY },
  ];
}

function routeDirectIncomingBottom(src: Bounds, gw: Bounds): Point[] {
  const exitX = src.x + src.width;
  const exitY = Math.round(src.y + src.height / 2);
  const entryX = Math.round(gw.x + gw.width / 2);
  const entryY = gw.y + gw.height;
  return [
    { x: exitX, y: exitY },
    { x: entryX, y: exitY },
    { x: entryX, y: entryY },
  ];
}

function routeDirectIncomingLeft(src: Bounds, gw: Bounds, stepXOffset = 0): Point[] {
  const exitX = src.x + src.width;
  const exitY = Math.round(src.y + src.height / 2);
  const entryX = gw.x;
  const entryY = Math.round(gw.y + gw.height / 2);

  if (exitY === entryY) {
    return [
      { x: exitX, y: exitY },
      { x: entryX, y: entryY },
    ];
  }

  const baseStepX = entryX - exitX > 100 ? entryX - 30 : Math.round((exitX + entryX) / 2);
  const stepX = baseStepX + stepXOffset;
  return [
    { x: exitX, y: exitY },
    { x: stepX, y: exitY },
    { x: stepX, y: entryY },
    { x: entryX, y: entryY },
  ];
}

interface ObstaclesContext {
  allBounds?: Bounds[];
  gw: Bounds;
}

function getOtherObstacles(ctx: ObstaclesContext, other: Bounds): Bounds[] {
  if (!ctx.allBounds) {
    return [];
  }
  return ctx.allBounds.filter(
    (b) =>
      !(b.x === ctx.gw.x && b.y === ctx.gw.y && b.width === ctx.gw.width) &&
      !(b.x === other.x && b.y === other.y && b.width === other.width)
  );
}

function canUseTopPort(gw: Bounds, tgt: Bounds, obstacles?: Bounds[]): boolean {
  const exitX = Math.round(gw.x + gw.width / 2);
  const entryY = Math.round(tgt.y + tgt.height / 2);
  const endpoints: CorridorEndpoints = {
    vX: exitX,
    vStart: entryY,
    vEnd: gw.y,
    hY: entryY,
    hStart: exitX,
    hEnd: tgt.x,
  };
  return checkDirectPortClear(endpoints, obstacles);
}

function canUseBottomPort(gw: Bounds, tgt: Bounds, obstacles?: Bounds[]): boolean {
  const exitX = Math.round(gw.x + gw.width / 2);
  const entryY = Math.round(tgt.y + tgt.height / 2);
  const endpoints: CorridorEndpoints = {
    vX: exitX,
    vStart: gw.y + gw.height,
    vEnd: entryY,
    hY: entryY,
    hStart: exitX,
    hEnd: tgt.x,
  };
  return checkDirectPortClear(endpoints, obstacles);
}

function canUseIncomingTopPort(src: Bounds, gw: Bounds, obstacles?: Bounds[]): boolean {
  const exitX = src.x + src.width;
  const exitY = Math.round(src.y + src.height / 2);
  const entryX = Math.round(gw.x + gw.width / 2);
  const endpoints: CorridorEndpoints = {
    vX: entryX,
    vStart: exitY,
    vEnd: gw.y,
    hY: exitY,
    hStart: exitX,
    hEnd: entryX,
  };
  return checkDirectPortClear(endpoints, obstacles);
}

function canUseIncomingBottomPort(src: Bounds, gw: Bounds, obstacles?: Bounds[]): boolean {
  const exitX = src.x + src.width;
  const exitY = Math.round(src.y + src.height / 2);
  const entryX = Math.round(gw.x + gw.width / 2);
  const endpoints: CorridorEndpoints = {
    vX: entryX,
    vStart: gw.y + gw.height,
    vEnd: exitY,
    hY: exitY,
    hStart: exitX,
    hEnd: entryX,
  };
  return checkDirectPortClear(endpoints, obstacles);
}

interface CategorizedFlows {
  above: GatewayFlowInfo[];
  center: GatewayFlowInfo[];
  below: GatewayFlowInfo[];
}

function categorizeFlows(flows: GatewayFlowInfo[], gwCenterY: number): CategorizedFlows {
  const above: GatewayFlowInfo[] = [];
  const center: GatewayFlowInfo[] = [];
  const below: GatewayFlowInfo[] = [];

  for (const f of flows) {
    const tgtCenterY = f.targetBounds.y + f.targetBounds.height / 2;
    const diff = tgtCenterY - gwCenterY;
    if (diff < -2) {
      above.push(f);
    } else if (diff > 2) {
      below.push(f);
    } else {
      center.push(f);
    }
  }

  above.sort((a, b) => a.targetBounds.y - b.targetBounds.y);
  below.sort((a, b) => b.targetBounds.y - a.targetBounds.y);

  return { above, center, below };
}

interface CategorizedIncomingFlows {
  above: GatewayIncomingFlowInfo[];
  center: GatewayIncomingFlowInfo[];
  below: GatewayIncomingFlowInfo[];
}

function categorizeIncomingFlows(
  flows: GatewayIncomingFlowInfo[],
  gwCenterY: number
): CategorizedIncomingFlows {
  const above: GatewayIncomingFlowInfo[] = [];
  const center: GatewayIncomingFlowInfo[] = [];
  const below: GatewayIncomingFlowInfo[] = [];

  for (const f of flows) {
    const srcCenterY = f.sourceBounds.y + f.sourceBounds.height / 2;
    const diff = srcCenterY - gwCenterY;
    if (diff < -2) {
      above.push(f);
    } else if (diff > 2) {
      below.push(f);
    } else {
      center.push(f);
    }
  }

  above.sort((a, b) => a.sourceBounds.y - b.sourceBounds.y);
  below.sort((a, b) => b.sourceBounds.y - a.sourceBounds.y);

  return { above, center, below };
}

interface PortAssignments {
  topFlow?: GatewayFlowInfo;
  bottomFlow?: GatewayFlowInfo;
  rightFlows: GatewayFlowInfo[];
}

interface IncomingPortAssignments {
  topFlow?: GatewayIncomingFlowInfo;
  bottomFlow?: GatewayIncomingFlowInfo;
  leftFlows: GatewayIncomingFlowInfo[];
}

interface AssignmentContext {
  gw: Bounds;
  allBounds?: Bounds[];
}

function computePortAssignments(
  cat: CategorizedFlows,
  freePorts: { top: boolean; bottom: boolean; right: boolean },
  ctx: AssignmentContext
): PortAssignments {
  const assignments: PortAssignments = { rightFlows: [] };
  const obstaclesParams: ObstaclesContext = { allBounds: ctx.allBounds, gw: ctx.gw };

  // Assign Top port
  if (freePorts.top && cat.above.length > 0) {
    const candidate = cat.above[0];
    const obstacles = getOtherObstacles(obstaclesParams, candidate.targetBounds);
    if (canUseTopPort(ctx.gw, candidate.targetBounds, obstacles)) {
      assignments.topFlow = candidate;
      cat.above.shift();
    }
  }

  // Assign Bottom port
  if (freePorts.bottom && cat.below.length > 0) {
    const candidate = cat.below[0];
    const obstacles = getOtherObstacles(obstaclesParams, candidate.targetBounds);
    if (canUseBottomPort(ctx.gw, candidate.targetBounds, obstacles)) {
      assignments.bottomFlow = candidate;
      cat.below.shift();
    }
  }

  // All remaining flows exit Right
  assignments.rightFlows.push(...cat.center, ...cat.above, ...cat.below);
  return assignments;
}

function computeIncomingPortAssignments(
  cat: CategorizedIncomingFlows,
  freePorts: { top: boolean; bottom: boolean; left: boolean },
  ctx: AssignmentContext
): IncomingPortAssignments {
  const assignments: IncomingPortAssignments = { leftFlows: [] };
  const obstaclesParams: ObstaclesContext = { allBounds: ctx.allBounds, gw: ctx.gw };

  if (freePorts.top && cat.above.length > 0) {
    const candidate = cat.above[0];
    const obstacles = getOtherObstacles(obstaclesParams, candidate.sourceBounds);
    if (canUseIncomingTopPort(candidate.sourceBounds, ctx.gw, obstacles)) {
      assignments.topFlow = candidate;
      cat.above.shift();
    }
  }

  if (freePorts.bottom && cat.below.length > 0) {
    const candidate = cat.below[0];
    const obstacles = getOtherObstacles(obstaclesParams, candidate.sourceBounds);
    if (canUseIncomingBottomPort(candidate.sourceBounds, ctx.gw, obstacles)) {
      assignments.bottomFlow = candidate;
      cat.below.shift();
    }
  }

  assignments.leftFlows.push(...cat.center, ...cat.above, ...cat.below);
  return assignments;
}

export function routeGatewayOutgoingEdges(
  flows: GatewayFlowInfo[],
  options: GatewayRouteOptions
): Map<string, Point[]> {
  const result = new Map<string, Point[]>();
  const gw = options.gatewayBounds;
  const gwCenterY = gw.y + gw.height / 2;

  // Separate feedback loops from forward flows
  const forwardFlows: GatewayFlowInfo[] = [];
  let hasOutgoingFeedback = false;

  for (const f of flows) {
    const isBackwards = f.targetBounds.x < gw.x + gw.width;
    if (f.isFeedback || isBackwards) {
      hasOutgoingFeedback = true;
      const waypoints = routeOrthogonalEdge(gw, f.targetBounds, options.allBounds);
      result.set(f.flow.id, waypoints);
    } else {
      forwardFlows.push(f);
    }
  }

  const freePorts = {
    top: !options.usedPorts?.has('top'),
    bottom:
      !options.usedPorts?.has('bottom') && !hasOutgoingFeedback && !options.hasIncomingFeedback,
    right: true,
  };

  const cat = categorizeFlows(forwardFlows, gwCenterY);
  const assignments = computePortAssignments(cat, freePorts, {
    gw,
    allBounds: options.allBounds,
  });

  if (assignments.topFlow) {
    result.set(assignments.topFlow.flow.id, routeDirectTop(gw, assignments.topFlow.targetBounds));
    options.usedPorts?.add('top');
  }

  if (assignments.bottomFlow) {
    result.set(
      assignments.bottomFlow.flow.id,
      routeDirectBottom(gw, assignments.bottomFlow.targetBounds)
    );
    options.usedPorts?.add('bottom');
  }

  let stepOffset = 0;
  for (const rf of assignments.rightFlows) {
    result.set(rf.flow.id, routeDirectRight(gw, rf.targetBounds, stepOffset));
    options.usedPorts?.add('right');
    stepOffset += 10;
  }

  return result;
}

export function routeGatewayIncomingEdges(
  flows: GatewayIncomingFlowInfo[],
  options: GatewayIncomingRouteOptions
): { routes: Map<string, Point[]>; usedPorts: Set<'top' | 'bottom' | 'left' | 'right'> } {
  const routes = new Map<string, Point[]>();
  const usedPorts = options.usedPorts || new Set<'top' | 'bottom' | 'left' | 'right'>();
  const gw = options.gatewayBounds;
  const gwCenterY = gw.y + gw.height / 2;

  const forwardFlows: GatewayIncomingFlowInfo[] = [];
  let hasIncomingFeedback = Boolean(options.hasIncomingFeedback);

  for (const f of flows) {
    const isBackwards = f.sourceBounds.x + f.sourceBounds.width > gw.x;
    if (f.isFeedback || isBackwards) {
      hasIncomingFeedback = true;
      const waypoints = routeOrthogonalEdge(f.sourceBounds, gw, options.allBounds);
      routes.set(f.flow.id, waypoints);
    } else {
      forwardFlows.push(f);
    }
  }

  const freePorts = {
    top: !usedPorts.has('top'),
    bottom: !usedPorts.has('bottom') && !hasIncomingFeedback,
    left: true,
  };

  const cat = categorizeIncomingFlows(forwardFlows, gwCenterY);
  const assignments = computeIncomingPortAssignments(cat, freePorts, {
    gw,
    allBounds: options.allBounds,
  });

  if (assignments.topFlow) {
    routes.set(
      assignments.topFlow.flow.id,
      routeDirectIncomingTop(assignments.topFlow.sourceBounds, gw)
    );
    usedPorts.add('top');
  }

  if (assignments.bottomFlow) {
    routes.set(
      assignments.bottomFlow.flow.id,
      routeDirectIncomingBottom(assignments.bottomFlow.sourceBounds, gw)
    );
    usedPorts.add('bottom');
  }

  let stepOffset = 0;
  for (const lf of assignments.leftFlows) {
    routes.set(lf.flow.id, routeDirectIncomingLeft(lf.sourceBounds, gw, stepOffset));
    usedPorts.add('left');
    stepOffset -= 10;
  }

  return { routes, usedPorts };
}
