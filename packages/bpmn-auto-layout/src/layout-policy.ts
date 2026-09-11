export interface RoutePoint {
  x: number;
  y: number;
}

/**
 * The §8 priority model, as an explicit, checkable structure rather than an
 * implicit ordering that only exists in prose. When two candidate layouts
 * (or two candidate routes, label positions, component placements, ...)
 * conflict, the one that satisfies the lower-numbered (more important)
 * level always wins, regardless of how well the loser scores on any
 * higher-numbered level (see #29).
 *
 * This is deliberately a shared vocabulary and a comparison primitive
 * (comparePriorityViolations below), not a rewrite of every
 * candidate-producing pass to use it -- retrofitting routing cases, label
 * candidates, and component packing to all report violations against this
 * ladder is real design work the issue itself asks to defer to a separate
 * discussion. choosePreferredRoute below already encodes levels 3 and 6 for
 * one such pass.
 */
export interface PriorityLevel {
  level: number;
  name: string;
  description: string;
}

export const LAYOUT_PRIORITY_LEVELS: readonly PriorityLevel[] = [
  { level: 1, name: "geometry-and-containment", description: "Valid BPMN geometry and container containment" },
  { level: 2, name: "no-overlaps", description: "No overlaps, crossings, or invalid attachments" },
  { level: 3, name: "orthogonal-routing", description: "Orthogonal routing" },
  {
    level: 4,
    name: "structure-and-alignment",
    description: "Clear left-to-right process structure and element alignment",
  },
  { level: 5, name: "spacing-and-labels", description: "Consistent spacing and label placement" },
  { level: 6, name: "path-length-and-turns", description: "Minimal path length and turns" },
  { level: 7, name: "compactness", description: "Compactness" },
] as const;

/**
 * Lexicographic comparison of two candidates by which priority levels they
 * violate: a violation at a lower (more important) level always outweighs
 * any number of violations at higher levels, no matter how the candidates
 * compare on those higher levels. Returns negative when `a` is preferable
 * to `b`, positive when `b` is preferable, 0 when they violate the same
 * set of levels (a further, level-specific tiebreak is then up to the
 * caller).
 */
export function comparePriorityViolations(a: ReadonlySet<number>, b: ReadonlySet<number>): number {
  for (const { level } of LAYOUT_PRIORITY_LEVELS) {
    const aViolates = a.has(level);
    const bViolates = b.has(level);
    if (aViolates !== bViolates) return aViolates ? 1 : -1;
  }
  return 0;
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

/**
 * Encodes priority levels 3 (orthogonal-routing, a hard filter here) and 6
 * (path-length-and-turns, the tiebreak order below) of the LAYOUT_PRIORITY_LEVELS
 * ladder for one candidate-producing pass: route selection. Levels 1-2
 * (geometry/containment, no-overlaps) are enforced upstream by the caller's
 * obstacle set before candidates ever reach here.
 */
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
