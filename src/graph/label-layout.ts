import {
  ARTIFACT_LABEL_MARGIN,
  EVENT_LABEL_MARGIN,
  FLOW_LABEL_MARGIN,
  GATEWAY_LABEL_MARGIN,
  LABEL_LINE_HEIGHT,
} from '../di-constants';
import type { Bounds, Point } from '../types';

export interface PlacedShape {
  element: any;
  bounds: Bounds;
  isExpanded?: boolean;
  labelBounds?: Bounds;
}

export interface PlacedEdge {
  element: any;
  waypoints: Point[];
  labelBounds?: Bounds;
}

export interface LabelLayoutContext {
  shapes: PlacedShape[];
  edges: PlacedEdge[];
  lanes?: Array<{ element: any; bounds: Bounds }>;
}

export interface CollisionContext {
  shapes: PlacedShape[];
  edges: PlacedEdge[];
  placedLabels: Bounds[];
  ignoreElementId?: string;
}

export function isEvent(element: any): boolean {
  const t = element?.$type || '';
  return (
    t === 'bpmn:StartEvent' ||
    t === 'bpmn:EndEvent' ||
    t === 'bpmn:IntermediateCatchEvent' ||
    t === 'bpmn:IntermediateThrowEvent' ||
    t === 'bpmn:BoundaryEvent'
  );
}

export function isBoundaryEvent(element: any): boolean {
  return (element?.$type || '') === 'bpmn:BoundaryEvent';
}

export function isGateway(element: any): boolean {
  const t = element?.$type || '';
  return (
    t === 'bpmn:ExclusiveGateway' ||
    t === 'bpmn:ParallelGateway' ||
    t === 'bpmn:InclusiveGateway' ||
    t === 'bpmn:EventBasedGateway' ||
    t === 'bpmn:ComplexGateway'
  );
}

export function isArtifact(element: any): boolean {
  const t = element?.$type || '';
  return t === 'bpmn:DataObjectReference' || t === 'bpmn:DataStoreReference';
}

export function isFlow(element: any): boolean {
  const t = element?.$type || '';
  return t === 'bpmn:SequenceFlow' || t === 'bpmn:MessageFlow';
}

export function estimateWordWidth(word: string): number {
  let width = 0;
  for (const char of word) {
    if (char === ' ') {
      width += 3.5;
    } else if (/[mwMW]/.test(char)) {
      width += 9.5;
    } else if (/[ijlrtfI1]/.test(char)) {
      width += 3.5;
    } else if (/[A-Z]/.test(char)) {
      width += 7.5;
    } else {
      width += 6.0;
    }
  }
  return width;
}

export function computeLabelVisualShift(text?: string): number {
  if (!text || text.trim() === '') {
    return 0;
  }
  const words = text.split(/\s+/);
  let maxWordW = 0;
  for (const w of words) {
    if (!w) {
      continue;
    }
    const wLen = estimateWordWidth(w);
    if (wLen > maxWordW) {
      maxWordW = wLen;
    }
  }
  const lines = text.split('\n');
  let maxLineW = 0;
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      continue;
    }
    const lLen = estimateWordWidth(trimmedLine);
    if (lLen > maxLineW) {
      maxLineW = lLen;
    }
  }
  const neededW = Math.ceil(maxWordW) + 4;
  const boxW = Math.ceil(maxLineW);
  if (boxW < neededW) {
    return 2;
  }
  return 0;
}

export function estimateLabelDimensions(text: string): { width: number; height: number } {
  const lines = text.split('\n');
  let maxLineWidth = 0;
  for (const line of lines) {
    const lineWidth = estimateWordWidth(line);
    maxLineWidth = Math.max(maxLineWidth, Math.ceil(lineWidth) + 4);
  }
  let width = Math.max(20, maxLineWidth);
  if (width % 2 !== 0) {
    width += 1;
  }
  let height = lines.length === 1 ? LABEL_LINE_HEIGHT : lines.length * (LABEL_LINE_HEIGHT - 1) + 1;
  if (height % 2 !== 0) {
    height += 1;
  }
  return { width, height };
}

export function generateTextWrapCandidates(text: string): string[] {
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/);
  if (words.length <= 1) {
    return [trimmed];
  }
  const candidates: string[] = [trimmed];

  let bestMidSplit = '';
  let minDiff = Number.POSITIVE_INFINITY;
  for (let i = 1; i < words.length; i++) {
    const line1 = words.slice(0, i).join(' ');
    const line2 = words.slice(i).join(' ');
    const diff = Math.abs(line1.length - line2.length);
    if (diff < minDiff) {
      minDiff = diff;
      bestMidSplit = `${line1}\n${line2}`;
    }
  }
  candidates.push(bestMidSplit);

  if (words.length >= 3) {
    appendThreeLineWrapCandidates(words, candidates);
  }

  return candidates;
}

function appendThreeLineWrapCandidates(words: string[], candidates: string[]): void {
  let best3Split = '';
  let min3Diff = Number.POSITIVE_INFINITY;
  for (let i = 1; i < words.length - 1; i++) {
    for (let j = i + 1; j < words.length; j++) {
      const l1 = words.slice(0, i).join(' ');
      const l2 = words.slice(i, j).join(' ');
      const l3 = words.slice(j).join(' ');
      const maxLen = Math.max(l1.length, l2.length, l3.length);
      const minLen = Math.min(l1.length, l2.length, l3.length);
      const diff = maxLen - minLen;
      if (diff < min3Diff) {
        min3Diff = diff;
        best3Split = `${l1}\n${l2}\n${l3}`;
      }
    }
  }
  candidates.push(best3Split);
}

export function boxesOverlap(a: Bounds, b: Bounds): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function doesSegmentCollideWithBox(p1: Point, p2: Point, box: Bounds): boolean {
  const minX = Math.min(p1.x, p2.x);
  const maxX = Math.max(p1.x, p2.x);
  const minY = Math.min(p1.y, p2.y);
  const maxY = Math.max(p1.y, p2.y);

  if (
    maxX <= box.x + 1 ||
    minX >= box.x + box.width - 1 ||
    maxY <= box.y + 1 ||
    minY >= box.y + box.height - 1
  ) {
    return false;
  }

  if (p1.y === p2.y) {
    return p1.y >= box.y - 1 && p1.y <= box.y + box.height + 1;
  }
  if (p1.x === p2.x) {
    return p1.x >= box.x - 1 && p1.x <= box.x + box.width + 1;
  }
  return true;
}

export function doesBoxCollide(box: Bounds, cctx: CollisionContext): boolean {
  for (const s of cctx.shapes) {
    if (s.element.id === cctx.ignoreElementId) {
      continue;
    }
    const t = s.element?.$type;
    if (t === 'bpmn:Participant' || t === 'bpmn:Lane') {
      continue;
    }
    if (boxesOverlap(box, s.bounds)) {
      return true;
    }
  }

  for (const edge of cctx.edges) {
    if (edge.element.id === cctx.ignoreElementId) {
      continue;
    }
    const wps = edge.waypoints;
    for (let i = 0; i < wps.length - 1; i++) {
      if (doesSegmentCollideWithBox(wps[i], wps[i + 1], box)) {
        return true;
      }
    }
  }

  return cctx.placedLabels.some((lbl) => boxesOverlap(box, lbl));
}

export interface ElementLabelGeom {
  elementBounds: Bounds;
  dim: { width: number; height: number };
  margin: number;
  element?: any;
  text?: string;
}

function computeOrthogonalElementBounds(
  geom: ElementLabelGeom,
  side: 'bottom' | 'top' | 'right' | 'left'
): Bounds {
  const { elementBounds, dim, margin, element, text } = geom;
  const shift = computeLabelVisualShift(text);
  const cx = Math.round(elementBounds.x + elementBounds.width / 2) - shift;
  const cy = Math.round(elementBounds.y + elementBounds.height / 2);
  const isBoundary = isBoundaryEvent(element);

  if (side === 'bottom') {
    return {
      x: cx - dim.width / 2,
      y: elementBounds.y + elementBounds.height + margin,
      width: dim.width,
      height: dim.height,
    };
  }
  if (side === 'top') {
    return {
      x: cx - dim.width / 2,
      y: elementBounds.y - margin - dim.height,
      width: dim.width,
      height: dim.height,
    };
  }
  if (side === 'right') {
    return {
      x: elementBounds.x + elementBounds.width + margin,
      y: isBoundary ? cy + 2 : cy - dim.height / 2,
      width: dim.width,
      height: dim.height,
    };
  }
  return {
    x: elementBounds.x - margin - dim.width,
    y: isBoundary ? cy + 2 : cy - dim.height / 2,
    width: dim.width,
    height: dim.height,
  };
}

function computeGatewayDiagonalBounds(
  geom: ElementLabelGeom,
  corner: 'top-right' | 'bottom-right' | 'top-left' | 'bottom-left'
): Bounds {
  const { elementBounds, dim } = geom;
  const cx = Math.round(elementBounds.x + elementBounds.width / 2);
  const cy = Math.round(elementBounds.y + elementBounds.height / 2);
  if (corner === 'top-right') {
    return { x: cx + 14, y: cy - 14 - dim.height, width: dim.width, height: dim.height };
  }
  if (corner === 'bottom-right') {
    return { x: cx + 14, y: cy + 14, width: dim.width, height: dim.height };
  }
  if (corner === 'top-left') {
    return {
      x: cx - 14 - dim.width,
      y: cy - 14 - dim.height,
      width: dim.width,
      height: dim.height,
    };
  }
  return { x: cx - 14 - dim.width, y: cy + 14, width: dim.width, height: dim.height };
}

function computeDiagonalElementBounds(
  geom: ElementLabelGeom,
  corner: 'top-right' | 'bottom-right' | 'top-left' | 'bottom-left'
): Bounds {
  if (isGateway(geom.element)) {
    return computeGatewayDiagonalBounds(geom, corner);
  }
  const { elementBounds, dim, margin } = geom;
  if (corner === 'top-right') {
    return {
      x: elementBounds.x + elementBounds.width + margin,
      y: elementBounds.y - margin - dim.height,
      width: dim.width,
      height: dim.height,
    };
  }
  if (corner === 'bottom-right') {
    return {
      x: elementBounds.x + elementBounds.width + margin,
      y: elementBounds.y + elementBounds.height + margin,
      width: dim.width,
      height: dim.height,
    };
  }
  if (corner === 'top-left') {
    return {
      x: elementBounds.x - margin - dim.width,
      y: elementBounds.y - margin - dim.height,
      width: dim.width,
      height: dim.height,
    };
  }
  return {
    x: elementBounds.x - margin - dim.width,
    y: elementBounds.y + elementBounds.height + margin,
    width: dim.width,
    height: dim.height,
  };
}

interface PlacementAttempt {
  labelBounds: Bounds;
  text: string;
}

export interface PlacementContext {
  shape: PlacedShape;
  margin: number;
  cctx: CollisionContext;
}

function findBestOrthogonalPlacement(pctx: PlacementContext): PlacementAttempt | undefined {
  const wrapCandidates = generateTextWrapCandidates(pctx.shape.element.name);
  const sides: Array<'bottom' | 'top' | 'right' | 'left'> = ['bottom', 'top', 'right', 'left'];

  for (const text of wrapCandidates) {
    const dim = estimateLabelDimensions(text);
    const geom: ElementLabelGeom = {
      elementBounds: pctx.shape.bounds,
      dim,
      margin: pctx.margin,
      element: pctx.shape.element,
      text,
    };
    for (const side of sides) {
      const candidate = computeOrthogonalElementBounds(geom, side);
      if (!doesBoxCollide(candidate, pctx.cctx)) {
        return { labelBounds: candidate, text };
      }
    }
  }

  return undefined;
}

function findBestDiagonalPlacement(pctx: PlacementContext): PlacementAttempt {
  const wrapCandidates = generateTextWrapCandidates(pctx.shape.element.name);
  const corners: Array<'top-right' | 'bottom-right' | 'top-left' | 'bottom-left'> = [
    'top-right',
    'bottom-right',
    'top-left',
    'bottom-left',
  ];

  for (const text of wrapCandidates) {
    const dim = estimateLabelDimensions(text);
    const geom: ElementLabelGeom = {
      elementBounds: pctx.shape.bounds,
      dim,
      margin: pctx.margin,
      element: pctx.shape.element,
      text,
    };
    for (const corner of corners) {
      const candidate = computeDiagonalElementBounds(geom, corner);
      if (!doesBoxCollide(candidate, pctx.cctx)) {
        return { labelBounds: candidate, text };
      }
    }
  }

  const fallbackText = wrapCandidates[wrapCandidates.length - 1];
  const dim = estimateLabelDimensions(fallbackText);
  const geom: ElementLabelGeom = {
    elementBounds: pctx.shape.bounds,
    dim,
    margin: pctx.margin,
    element: pctx.shape.element,
    text: fallbackText,
  };
  return {
    labelBounds: computeOrthogonalElementBounds(geom, 'bottom'),
    text: fallbackText,
  };
}

export function layoutElementLabel(
  shape: PlacedShape,
  placedLabels: Bounds[],
  ctx: LabelLayoutContext
): void {
  if (!shape.element?.name || shape.element.name.trim() === '') {
    return;
  }

  let margin = EVENT_LABEL_MARGIN;
  if (isGateway(shape.element)) {
    margin = GATEWAY_LABEL_MARGIN;
  } else if (isArtifact(shape.element)) {
    margin = ARTIFACT_LABEL_MARGIN;
  }

  const cctx: CollisionContext = {
    shapes: ctx.shapes,
    edges: ctx.edges,
    placedLabels,
    ignoreElementId: shape.element.id,
  };
  const pctx: PlacementContext = { shape, margin, cctx };

  const placement = findBestOrthogonalPlacement(pctx) || findBestDiagonalPlacement(pctx);

  shape.labelBounds = placement.labelBounds;
  shape.element.name = placement.text;
  placedLabels.push(placement.labelBounds);
}

export interface PathLabelGeom {
  p1: Point;
  p2: Point;
  dim: { width: number; height: number };
  margin: number;
  text?: string;
}

export function computePathSegmentLabel(
  geom: PathLabelGeom,
  side: 'top' | 'bottom' | 'right' | 'left'
): Bounds {
  const { p1, p2, dim, margin, text } = geom;
  const isHorizontal = p1.y === p2.y;
  const shift = computeLabelVisualShift(text);
  const mx = Math.round((p1.x + p2.x) / 2) - shift;
  const my = Math.round((p1.y + p2.y) / 2);

  if (isHorizontal) {
    const y = side === 'top' ? p1.y - margin - dim.height : p1.y + margin;
    return {
      x: mx - dim.width / 2,
      y,
      width: dim.width,
      height: dim.height,
    };
  }

  const x = side === 'right' ? p1.x + margin : p1.x - margin - dim.width;
  return {
    x,
    y: my - dim.height / 2,
    width: dim.width,
    height: dim.height,
  };
}

export function layoutPathLabel(
  edge: PlacedEdge,
  placedLabels: Bounds[],
  ctx: LabelLayoutContext
): void {
  if (!edge.element?.name || edge.element.name.trim() === '' || edge.waypoints.length < 2) {
    return;
  }

  const wrapCandidates = generateTextWrapCandidates(edge.element.name);
  const wps = edge.waypoints;
  const margin = FLOW_LABEL_MARGIN;

  let bestSegIndex = 0;
  let maxSegLen = 0;
  for (let i = 0; i < wps.length - 1; i++) {
    const len = Math.hypot(wps[i + 1].x - wps[i].x, wps[i + 1].y - wps[i].y);
    if (len > maxSegLen) {
      maxSegLen = len;
      bestSegIndex = i;
    }
  }

  const p1 = wps[bestSegIndex];
  const p2 = wps[bestSegIndex + 1];
  const isHorizontal = p1.y === p2.y;
  const sides: Array<'top' | 'bottom' | 'right' | 'left'> = isHorizontal
    ? ['top', 'bottom']
    : ['right', 'left'];

  const cctx: CollisionContext = {
    shapes: ctx.shapes,
    edges: ctx.edges,
    placedLabels,
    ignoreElementId: edge.element.id,
  };

  for (const text of wrapCandidates) {
    const dim = estimateLabelDimensions(text);
    const geom: PathLabelGeom = { p1, p2, dim, margin, text };
    for (const side of sides) {
      const candidate = computePathSegmentLabel(geom, side);
      if (!doesBoxCollide(candidate, cctx)) {
        edge.labelBounds = candidate;
        edge.element.name = text;
        placedLabels.push(candidate);
        return;
      }
    }
  }

  const fallbackText = wrapCandidates[0];
  const dim = estimateLabelDimensions(fallbackText);
  const geom: PathLabelGeom = { p1, p2, dim, margin, text: fallbackText };
  const fallbackBounds = computePathSegmentLabel(geom, sides[0]);
  edge.labelBounds = fallbackBounds;
  placedLabels.push(fallbackBounds);
}

export function layoutAllLabels(ctx: LabelLayoutContext): void {
  const placedLabels: Bounds[] = [];

  for (const shape of ctx.shapes) {
    if (isEvent(shape.element) || isGateway(shape.element) || isArtifact(shape.element)) {
      layoutElementLabel(shape, placedLabels, ctx);
    }
  }

  for (const edge of ctx.edges) {
    if (isFlow(edge.element)) {
      layoutPathLabel(edge, placedLabels, ctx);
    }
  }
}
