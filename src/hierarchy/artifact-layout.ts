import { getElementDimensions } from '../di-constants';
import { estimateTextAnnotationDimensions } from '../graph/label-layout';
import type { Bounds, ElementDimension, Point } from '../types';
import { getRefId } from './subprocess-layout';

export function getArtifactDimensions(artifact: any): ElementDimension {
  if (artifact.$type === 'bpmn:TextAnnotation') {
    return estimateTextAnnotationDimensions(artifact.text || artifact.name);
  }
  return getElementDimensions(artifact.$type);
}

export function isArtifact(el: any): boolean {
  return (
    el.$type === 'bpmn:TextAnnotation' ||
    el.$type === 'bpmn:DataObjectReference' ||
    el.$type === 'bpmn:DataStoreReference' ||
    el.$type === 'bpmn:Group'
  );
}

export function isAssociation(el: any): boolean {
  return el.$type === 'bpmn:Association';
}

export interface ConnectedArtifactInfo {
  artifact: any;
  hostId: string;
}

export interface ConnectedLayoutContext {
  boundsMap: Map<string, Bounds>;
  shapes: Array<{ element: any; bounds: Bounds; isExpanded?: boolean }>;
}

export interface RowPlacementConfig {
  hostCenterX: number;
  y: (height: number) => number;
  ctx: ConnectedLayoutContext;
}

export function collectTaskDataAssociations(node: any): any[] {
  const result: any[] = [];
  for (const dia of node.dataInputAssociations || []) {
    const src = Array.isArray(dia.sourceRef) ? dia.sourceRef[0] : dia.sourceRef;
    const srcId = getRefId(src);
    result.push({
      $type: 'bpmn:Association',
      id: dia.id ?? `Assoc_${srcId}_${node.id}`,
      sourceRef: src,
      targetRef: node,
    });
  }
  for (const doa of node.dataOutputAssociations || []) {
    const tgtId = getRefId(doa.targetRef);
    result.push({
      $type: 'bpmn:Association',
      id: doa.id ?? `Assoc_${node.id}_${tgtId}`,
      sourceRef: node,
      targetRef: doa.targetRef,
    });
  }
  return result;
}

export function collectScopeAssociations(scopeElement: any, regularNodes: any[]): any[] {
  const flowElements = scopeElement.flowElements || [];
  const artifacts = scopeElement.artifacts || [];
  const result = [...flowElements.filter(isAssociation), ...artifacts.filter(isAssociation)];

  for (const node of regularNodes) {
    result.push(...collectTaskDataAssociations(node));
  }

  return result;
}

export function partitionArtifacts(
  artifacts: any[],
  associations: any[],
  regularNodeIds: Set<string>
): {
  connected: ConnectedArtifactInfo[];
  unconnected: any[];
} {
  const connected: ConnectedArtifactInfo[] = [];
  const unconnected: any[] = [];

  for (const art of artifacts) {
    let hostId: string | undefined;
    for (const assoc of associations) {
      const srcId = getRefId(assoc.sourceRef);
      const tgtId = getRefId(assoc.targetRef);
      if (srcId === art.id && tgtId && regularNodeIds.has(tgtId)) {
        hostId = tgtId;
        break;
      }
      if (tgtId === art.id && srcId && regularNodeIds.has(srcId)) {
        hostId = srcId;
        break;
      }
    }
    if (hostId) {
      connected.push({ artifact: art, hostId });
    } else {
      unconnected.push(art);
    }
  }

  return { connected, unconnected };
}

export function placeArtifactRow(artifacts: any[], config: RowPlacementConfig): void {
  if (artifacts.length === 0) {
    return;
  }
  const dims = artifacts.map((a) => getArtifactDimensions(a));
  const totalWidth = dims.reduce((sum, d) => sum + d.width, 0) + (artifacts.length - 1) * 20;
  let curX = Math.round(config.hostCenterX - totalWidth / 2);

  for (let i = 0; i < artifacts.length; i++) {
    const art = artifacts[i];
    const dim = dims[i];
    const bounds: Bounds = {
      x: curX,
      y: config.y(dim.height),
      width: dim.width,
      height: dim.height,
    };
    config.ctx.boundsMap.set(art.id, bounds);
    config.ctx.shapes.push({ element: art, bounds });
    curX += dim.width + 20;
  }
}

export function placeArtifactSide(
  artifacts: any[],
  hostBounds: Bounds,
  ctx: ConnectedLayoutContext
): void {
  let curX = hostBounds.x + hostBounds.width + 30;
  for (const art of artifacts) {
    const dim = getArtifactDimensions(art);
    const bounds: Bounds = {
      x: curX,
      y: Math.round(hostBounds.y + (hostBounds.height - dim.height) / 2),
      width: dim.width,
      height: dim.height,
    };
    ctx.boundsMap.set(art.id, bounds);
    ctx.shapes.push({ element: art, bounds });
    curX += dim.width + 20;
  }
}

export function placeHostArtifacts(
  artifacts: any[],
  hostBounds: Bounds,
  ctx: ConnectedLayoutContext
): void {
  const aboveList: any[] = [];
  const belowList: any[] = [];
  const sideList: any[] = [];

  for (const art of artifacts) {
    if (art.$type === 'bpmn:DataStoreReference') {
      belowList.push(art);
    } else if (art.$type === 'bpmn:DataObjectReference') {
      aboveList.push(art);
    } else if (aboveList.length === 0) {
      aboveList.push(art);
    } else if (belowList.length === 0) {
      belowList.push(art);
    } else {
      sideList.push(art);
    }
  }

  const hostCenterX = Math.round(hostBounds.x + hostBounds.width / 2);
  placeArtifactRow(aboveList, {
    hostCenterX,
    y: (h) => hostBounds.y - 30 - h,
    ctx,
  });
  placeArtifactRow(belowList, {
    hostCenterX,
    y: () => hostBounds.y + hostBounds.height + 30,
    ctx,
  });
  placeArtifactSide(sideList, hostBounds, ctx);
}

export function layoutConnectedArtifacts(
  connectedList: ConnectedArtifactInfo[],
  ctx: ConnectedLayoutContext
): void {
  const byHost = new Map<string, any[]>();
  for (const item of connectedList) {
    const list = byHost.get(item.hostId) || [];
    list.push(item.artifact);
    byHost.set(item.hostId, list);
  }

  for (const [hostId, artifacts] of byHost.entries()) {
    const hostBounds = ctx.boundsMap.get(hostId)!;
    placeHostArtifacts(artifacts, hostBounds, ctx);
  }
}

function isSameBounds(a: Bounds, b?: Bounds): boolean {
  return (
    b !== undefined && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  );
}

function filterObstacles(obstacles?: Bounds[], src?: Bounds, tgt?: Bounds): Bounds[] {
  if (!obstacles || obstacles.length === 0) {
    return [];
  }
  return obstacles.filter((obs) => !isSameBounds(obs, src) && !isSameBounds(obs, tgt));
}

function isSegmentObstructed(a: Point, b: Point, obs: Bounds): boolean {
  if (a.x === b.x) {
    if (a.x <= obs.x || a.x >= obs.x + obs.width) {
      return false;
    }
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);
    return Math.max(minY, obs.y) < Math.min(maxY, obs.y + obs.height);
  }
  if (a.y <= obs.y || a.y >= obs.y + obs.height) {
    return false;
  }
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  return Math.max(minX, obs.x) < Math.min(maxX, obs.x + obs.width);
}

function isPathObstructed(waypoints: Point[], obstacles: Bounds[]): boolean {
  for (const obs of obstacles) {
    for (let i = 0; i < waypoints.length - 1; i++) {
      if (isSegmentObstructed(waypoints[i], waypoints[i + 1], obs)) {
        return true;
      }
    }
  }
  return false;
}

function hasSiblingInRow(tgt: Bounds, obstacles: Bounds[]): boolean {
  return obstacles.some(
    (obs) => Math.abs(obs.y - tgt.y) < 10 && obs.height === tgt.height && obs.x !== tgt.x
  );
}

function routeLeftwardDiagonal(src: Bounds, tgt: Bounds, obstacles?: Bounds[]): Point[] {
  const srcCenter: Point = {
    x: Math.round(src.x + src.width / 2),
    y: Math.round(src.y + src.height / 2),
  };
  const tgtCenter: Point = {
    x: Math.round(tgt.x + tgt.width / 2),
    y: Math.round(tgt.y + tgt.height / 2),
  };
  const isAbove = srcCenter.y < tgtCenter.y;
  const p1: Point = {
    x: srcCenter.x,
    y: isAbove ? src.y + src.height : src.y,
  };
  const candidateRightPort: Point[] = [
    p1,
    { x: p1.x, y: tgtCenter.y },
    { x: tgt.x + tgt.width, y: tgtCenter.y },
  ];

  const filtered = filterObstacles(obstacles, src, tgt);
  const useTopOrBottom =
    isPathObstructed(candidateRightPort, filtered) || hasSiblingInRow(tgt, filtered);

  if (!useTopOrBottom) {
    return candidateRightPort;
  }

  const midY = isAbove
    ? Math.round((src.y + src.height + tgt.y) / 2)
    : Math.round((src.y + tgt.y + tgt.height) / 2);
  const targetY = isAbove ? tgt.y : tgt.y + tgt.height;

  const steppedRoute: Point[] = [
    p1,
    { x: p1.x, y: midY },
    { x: tgtCenter.x, y: midY },
    { x: tgtCenter.x, y: targetY },
  ];
  if (!isPathObstructed(steppedRoute, filtered)) {
    return steppedRoute;
  }

  // The mid-drop still clips something between src and tgt (e.g. a sibling
  // branch sharing src's column). Jog to tgt's own column immediately after
  // leaving src instead, so the long vertical run happens where tgt already
  // has clearance.
  return [p1, { x: tgtCenter.x, y: p1.y }, { x: tgtCenter.x, y: targetY }];
}

function routeDiagonalAssociation(src: Bounds, tgt: Bounds, obstacles?: Bounds[]): Point[] {
  const srcCenter: Point = {
    x: Math.round(src.x + src.width / 2),
    y: Math.round(src.y + src.height / 2),
  };
  const tgtCenter: Point = {
    x: Math.round(tgt.x + tgt.width / 2),
    y: Math.round(tgt.y + tgt.height / 2),
  };

  if (src.x + src.width <= tgt.x) {
    const p1: Point = { x: src.x + src.width, y: srcCenter.y };
    const p3: Point = {
      x: tgtCenter.x,
      y: srcCenter.y < tgtCenter.y ? tgt.y : tgt.y + tgt.height,
    };
    return [p1, { x: p3.x, y: p1.y }, p3];
  }

  return routeLeftwardDiagonal(src, tgt, obstacles);
}

export function routeAssociationEdge(
  sourceBounds: Bounds,
  targetBounds: Bounds,
  obstacles?: Bounds[]
): Point[] {
  const overlapMinX = Math.max(sourceBounds.x, targetBounds.x);
  const overlapMaxX = Math.min(
    sourceBounds.x + sourceBounds.width,
    targetBounds.x + targetBounds.width
  );

  if (overlapMinX < overlapMaxX) {
    const midX = Math.round((overlapMinX + overlapMaxX) / 2);
    if (sourceBounds.y + sourceBounds.height <= targetBounds.y) {
      return [
        { x: midX, y: sourceBounds.y + sourceBounds.height },
        { x: midX, y: targetBounds.y },
      ];
    }
    if (targetBounds.y + targetBounds.height <= sourceBounds.y) {
      return [
        { x: midX, y: sourceBounds.y },
        { x: midX, y: targetBounds.y + targetBounds.height },
      ];
    }
  }

  const overlapMinY = Math.max(sourceBounds.y, targetBounds.y);
  const overlapMaxY = Math.min(
    sourceBounds.y + sourceBounds.height,
    targetBounds.y + targetBounds.height
  );

  if (overlapMinY < overlapMaxY) {
    const midY = Math.round((overlapMinY + overlapMaxY) / 2);
    if (sourceBounds.x + sourceBounds.width <= targetBounds.x) {
      return [
        { x: sourceBounds.x + sourceBounds.width, y: midY },
        { x: targetBounds.x, y: midY },
      ];
    }
    if (targetBounds.x + targetBounds.width <= sourceBounds.x) {
      return [
        { x: sourceBounds.x, y: midY },
        { x: targetBounds.x + targetBounds.width, y: midY },
      ];
    }
  }

  return routeDiagonalAssociation(sourceBounds, targetBounds, obstacles);
}

export function routeAssociations(
  associations: any[],
  boundsMap: Map<string, Bounds>,
  edges: Array<{ element: any; waypoints: Point[]; isFeedback?: boolean }>
): void {
  const obstacles = [...boundsMap.values()];
  for (const assoc of associations) {
    if (edges.some((e) => e.element.id === assoc.id)) {
      continue;
    }
    const srcId = getRefId(assoc.sourceRef);
    const tgtId = getRefId(assoc.targetRef);
    const srcBounds = boundsMap.get(srcId as string);
    const tgtBounds = boundsMap.get(tgtId as string);
    if (srcBounds && tgtBounds) {
      const waypoints = routeAssociationEdge(srcBounds, tgtBounds, obstacles);
      edges.push({ element: assoc, waypoints });
    }
  }
}
