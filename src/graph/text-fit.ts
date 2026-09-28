import { getElementDimensions } from '../di-constants';
import { estimateWordWidth } from './label-layout';
import type { ElementDimension } from '../types';

const ICON_ACTIVITY_TYPES = new Set([
  'bpmn:UserTask',
  'bpmn:ServiceTask',
  'bpmn:SendTask',
  'bpmn:ReceiveTask',
  'bpmn:ManualTask',
  'bpmn:BusinessRuleTask',
  'bpmn:ScriptTask',
]);
const LABELED_ACTIVITY_TYPES = new Set([
  ...ICON_ACTIVITY_TYPES,
  'bpmn:Task',
  'bpmn:CallActivity',
  'bpmn:SubProcess',
  'bpmn:AdHocSubProcess',
]);

// bpmn-js wraps embedded labels greedily, breaking at whitespace and after
// hyphens, and pads task labels by 5px on every side. Header labels (pools
// and lanes) are laid out along the shape's height with no padding, in a
// 30px band that holds two lines of text.
const TASK_LABEL_PADDING = 5;
const TASK_LABEL_LINE_HEIGHT = 14.4;
const TASK_LABEL_VERTICAL_ALLOWANCE = 30;
// Space above a label that keeps its first line below the task-type icon.
const TASK_ICON_CLEARANCE = 25;
const TASK_PREFERRED_MAX_LINES = 3;
const TASK_WIDTH_STEP = 20;
const TASK_MAX_WIDTH = 140;
const HEADER_MAX_LINES = 2;
const HEADER_LENGTH_STEP = 10;
// The width estimate is an average-font approximation; keep a margin so a
// slightly wider real font doesn't spill onto an extra line.
const WIDTH_SAFETY_FACTOR = 1.08;

// A word, up to and including its first hyphen, is the unit bpmn-js can break at.
function tokenizeForWrap(text: string): string[] {
  return text.match(/[^\s-]*-|[^\s-]+/g) ?? [];
}

/** Number of lines bpmn-js will need to wrap `text` into `maxWidth` pixels. */
export function countWrappedLines(text: string, maxWidth: number): number {
  let lines = 0;
  for (const paragraph of text.split('\n')) {
    let lineWidth = 0;
    lines += 1;
    for (const token of tokenizeForWrap(paragraph)) {
      const tokenWidth = estimateWordWidth(token) * WIDTH_SAFETY_FACTOR;
      const gap = lineWidth > 0 ? estimateWordWidth(' ') : 0;
      if (lineWidth > 0 && lineWidth + gap + tokenWidth > maxWidth) {
        lines += 1;
        lineWidth = tokenWidth;
      } else {
        lineWidth += gap + tokenWidth;
      }
    }
  }
  return lines;
}

/**
 * Smallest length (a multiple of 10) along which a pool or lane header label
 * wraps into at most two lines, i.e. fits the 30px header band. 0 for an
 * unnamed pool or lane.
 */
export function computeHeaderLabelLength(name: string | undefined): number {
  if (!name || name.trim() === '') {
    return 0;
  }
  let length = HEADER_LENGTH_STEP;
  while (countWrappedLines(name, length) > HEADER_MAX_LINES) {
    length += HEADER_LENGTH_STEP;
  }
  return length;
}

/**
 * Size of a flow node: its default box, except that an activity whose label
 * doesn't fit that box is widened first (up to 140px, so the label needs at
 * most three lines) and then made taller. A task with a type icon in its
 * top-left corner also keeps the label's first line clear of that icon.
 */
export function computeNodeDimensions(type: string | undefined, name?: string): ElementDimension {
  const base = getElementDimensions(type ?? '');
  if (!type || !LABELED_ACTIVITY_TYPES.has(type) || !name || name.trim() === '') {
    return base;
  }
  let width = base.width;
  let lines = countWrappedLines(name, width - 2 * TASK_LABEL_PADDING);
  while (lines > TASK_PREFERRED_MAX_LINES && width < TASK_MAX_WIDTH) {
    width += TASK_WIDTH_STEP;
    lines = countWrappedLines(name, width - 2 * TASK_LABEL_PADDING);
  }
  const clearance = ICON_ACTIVITY_TYPES.has(type)
    ? TASK_ICON_CLEARANCE
    : TASK_LABEL_VERTICAL_ALLOWANCE / 2;
  const neededHeight = Math.ceil((lines * TASK_LABEL_LINE_HEIGHT + 2 * clearance) / 10) * 10;
  return { width, height: Math.max(base.height, neededHeight) };
}
