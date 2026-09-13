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

function routeDiagonalAssociation(src: Bounds, tgt: Bounds): Point[] {
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

  const p1: Point = {
    x: srcCenter.x,
    y: srcCenter.y < tgtCenter.y ? src.y + src.height : src.y,
  };
  const p3: Point = {
    x: tgt.x + tgt.width,
    y: tgtCenter.y,
  };
  return [p1, { x: p1.x, y: p3.y }, p3];
}

export function routeAssociationEdge(sourceBounds: Bounds, targetBounds: Bounds): Point[] {
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

  return routeDiagonalAssociation(sourceBounds, targetBounds);
}

export function routeAssociations(
  associations: any[],
  boundsMap: Map<string, Bounds>,
  edges: Array<{ element: any; waypoints: Point[]; isFeedback?: boolean }>
): void {
  for (const assoc of associations) {
    if (edges.some((e) => e.element.id === assoc.id)) {
      continue;
    }
    const srcId = getRefId(assoc.sourceRef);
    const tgtId = getRefId(assoc.targetRef);
    const srcBounds = boundsMap.get(srcId as string);
    const tgtBounds = boundsMap.get(tgtId as string);
    if (srcBounds && tgtBounds) {
      const waypoints = routeAssociationEdge(srcBounds, tgtBounds);
      edges.push({ element: assoc, waypoints });
    }
  }
}
