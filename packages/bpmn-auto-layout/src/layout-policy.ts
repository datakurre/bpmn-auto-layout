export interface RoutePoint {
  x: number;
  y: number;
}

export interface RoutingPolicy {
  requireOrthogonal: boolean;
  minimumTurns: number;
  preferFewestTurns: boolean;
  preferredPathLengthFactor: number;
}

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  requireOrthogonal: true,
  minimumTurns: 0,
  preferFewestTurns: true,
  preferredPathLengthFactor: Number.POSITIVE_INFINITY,
};

export function resolveRoutingPolicy(overrides: Partial<RoutingPolicy> = {}): RoutingPolicy {
  return { ...DEFAULT_ROUTING_POLICY, ...overrides };
}

export function routeLength(points: RoutePoint[]): number {
  return points.slice(0, -1).reduce((total, point, index) => {
    const next = points[index + 1]!;
    return total + Math.abs(next.x - point.x) + Math.abs(next.y - point.y);
  }, 0);
}

export function routeTurns(points: RoutePoint[]): number {
  let turns = 0;
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1]!;
    const current = points[index]!;
    const next = points[index + 1]!;
    if ((previous.x === current.x) !== (current.x === next.x)) turns += 1;
  }
  return turns;
}

export function isOrthogonal(points: RoutePoint[]): boolean {
  return points.every((point, index) => {
    if (index === 0) return true;
    const previous = points[index - 1]!;
    return previous.x === point.x || previous.y === point.y;
  });
}

export function choosePreferredRoute(
  candidates: RoutePoint[][],
  policy: RoutingPolicy = DEFAULT_ROUTING_POLICY,
): RoutePoint[] | null {
  const valid = candidates.filter(
    (candidate) =>
      (!policy.requireOrthogonal || isOrthogonal(candidate)) && routeTurns(candidate) >= policy.minimumTurns,
  );
  if (valid.length === 0) return null;

  const shortest = Math.min(...valid.map(routeLength));
  const bounded = valid.filter((candidate) => routeLength(candidate) <= shortest * policy.preferredPathLengthFactor);
  const pool = bounded.length > 0 ? bounded : valid;
  return [...pool].sort((left, right) => {
    if (policy.preferFewestTurns) {
      const turnDifference = routeTurns(left) - routeTurns(right);
      if (turnDifference !== 0) return turnDifference;
    }
    const lengthDifference = routeLength(left) - routeLength(right);
    if (lengthDifference !== 0) return lengthDifference;
    return JSON.stringify(left).localeCompare(JSON.stringify(right));
  })[0]!;
}
