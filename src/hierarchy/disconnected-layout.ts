import { SUBPROCESS_MIN_HEIGHT, SUBPROCESS_MIN_WIDTH, isSubProcessType } from '../di-constants';
import type { Bounds, Point } from '../types';
import { getArtifactDimensions } from './artifact-layout';
import { getRefId, offsetAndCollectChildren, type ScopeLayoutResult } from './subprocess-layout';

export function isEventSubProcess(el: any): boolean {
  return el.$type === 'bpmn:SubProcess' && el.triggeredByEvent === true;
}

export function computeCurrentDiagramBounds(
  shapes: Array<{ bounds: Bounds }>,
  edges: Array<{ waypoints: Point[] }>
): {
  minX: number;
  maxX: number;
  maxY: number;
} {
  if (shapes.length === 0) {
    return { minX: 100, maxX: 500, maxY: 40 };
  }
  let minX = shapes[0].bounds.x;
  let maxX = shapes[0].bounds.x + shapes[0].bounds.width;
  let maxY = shapes[0].bounds.y + shapes[0].bounds.height;

  for (const s of shapes) {
    minX = Math.min(minX, s.bounds.x);
    maxX = Math.max(maxX, s.bounds.x + s.bounds.width);
    maxY = Math.max(maxY, s.bounds.y + s.bounds.height);
  }
  // Waypoints too: a loop or gateway channel can extend past every shape's
  // own bounds, and a disconnected item placed inside that channel would
  // force the flow it belongs to into a detour around the item.
  for (const e of edges) {
    for (const wp of e.waypoints) {
      minX = Math.min(minX, wp.x);
      maxX = Math.max(maxX, wp.x);
      maxY = Math.max(maxY, wp.y);
    }
  }
  return { minX, maxX, maxY };
}

export interface DisconnectedLayoutContext {
  childScopeResults: Map<string, ScopeLayoutResult>;
  boundsMap: Map<string, Bounds>;
  shapes: Array<{ element: any; bounds: Bounds; isExpanded?: boolean }>;
  associations?: any[];
}

function getItemHostBounds(item: any, ctx: DisconnectedLayoutContext): Bounds | undefined {
  if (!ctx.associations || !item.isForCompensation) {
    return undefined;
  }
  const assoc = ctx.associations.find((a: any) => getRefId(a.targetRef) === item.id);
  if (!assoc) {
    return undefined;
  }
  const srcId = getRefId(assoc.sourceRef);
  return ctx.boundsMap.get(srcId as string);
}

function getItemHostPreferredX(item: any, ctx: DisconnectedLayoutContext): number {
  const b = getItemHostBounds(item, ctx);
  return b ? b.x : -1;
}

export function layoutDisconnectedElements(
  items: any[],
  diagramBounds: { minX: number; maxX: number; maxY: number },
  ctx: DisconnectedLayoutContext
): void {
  const rowStartX = diagramBounds.minX;
  const rowBoundaryX = Math.max(diagramBounds.maxX, rowStartX + 600);
  let currentX = rowStartX;
  let currentY = diagramBounds.maxY + 60;
  let rowMaxHeight = 0;

  const sortedItems = [...items].sort((a, b) => {
    const bA = getItemHostBounds(a, ctx);
    const bB = getItemHostBounds(b, ctx);
    if (bA && bB) {
      if (bA.x !== bB.x) {
        return bA.x - bB.x;
      }
      return bB.y - bA.y;
    }
    return 0;
  });

  for (const item of sortedItems) {
    const childResult = isSubProcessType(item.$type)
      ? ctx.childScopeResults.get(item.id)
      : undefined;
    const itemDim = childResult ? undefined : getArtifactDimensions(item);
    const width = childResult ? Math.max(SUBPROCESS_MIN_WIDTH, childResult.width) : itemDim!.width;
    const height = childResult
      ? Math.max(SUBPROCESS_MIN_HEIGHT, childResult.height)
      : itemDim!.height;

    if (item.isForCompensation && ctx.associations) {
      const prefX = getItemHostPreferredX(item, ctx);
      if (prefX >= 0) {
        currentX = Math.max(currentX, prefX);
      }
    }

    if (currentX > rowStartX && currentX + width > rowBoundaryX) {
      currentX = rowStartX;
      currentY += rowMaxHeight + 40;
      rowMaxHeight = 0;
    }

    const bounds: Bounds = { x: currentX, y: currentY, width, height };
    ctx.boundsMap.set(item.id, bounds);

    if (childResult) {
      ctx.shapes.push({ element: item, bounds, isExpanded: true });
      offsetAndCollectChildren(childResult, bounds, ctx.shapes);
    } else {
      ctx.shapes.push({ element: item, bounds });
    }

    currentX += width + 40;
    rowMaxHeight = Math.max(rowMaxHeight, height);
  }
}
