import { CANVAS_MARGIN } from './di-constants';

interface PlaneGeometry {
  boundsList: any[];
  waypointLists: any[][];
}

function collectPlaneGeometry(elements: any[]): PlaneGeometry {
  const boundsList: any[] = [];
  const waypointLists: any[][] = [];

  for (const el of elements) {
    if (el.bounds) {
      boundsList.push(el.bounds);
    }
    if (el.label?.bounds) {
      boundsList.push(el.label.bounds);
    }
    if (Array.isArray(el.waypoint)) {
      waypointLists.push(el.waypoint);
    }
  }
  return { boundsList, waypointLists };
}

function computeMinCoordinates(geometry: PlaneGeometry): { minX: number; minY: number } {
  let minX = Infinity;
  let minY = Infinity;

  for (const b of geometry.boundsList) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
  }
  for (const waypoints of geometry.waypointLists) {
    for (const pt of waypoints) {
      minX = Math.min(minX, pt.x);
      minY = Math.min(minY, pt.y);
    }
  }
  return { minX, minY };
}

function applyShift(geometry: PlaneGeometry, shiftX: number, shiftY: number): void {
  for (const b of geometry.boundsList) {
    b.x += shiftX;
    b.y += shiftY;
  }
  for (const waypoints of geometry.waypointLists) {
    for (const pt of waypoints) {
      pt.x += shiftX;
      pt.y += shiftY;
    }
  }
}

export function normalizePlaneOrigin(plane: any, margin = CANVAS_MARGIN): void {
  const elements = plane?.planeElement || [];
  const geometry = collectPlaneGeometry(elements);
  const { minX, minY } = computeMinCoordinates(geometry);

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return;
  }

  const shiftX = minX < margin ? margin - minX : 0;
  const shiftY = minY < margin ? margin - minY : 0;

  if (shiftX === 0 && shiftY === 0) {
    return;
  }

  applyShift(geometry, shiftX, shiftY);
}
