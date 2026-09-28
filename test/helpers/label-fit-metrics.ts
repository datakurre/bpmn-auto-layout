import { BpmnModdle } from 'bpmn-moddle';
import { LANE_HEADER_WIDTH } from '../../src/di-constants';
import { countWrappedLines } from '../../src/graph/text-fit';
import type { Bounds } from '../../src/types';

export interface LaidOutShapes {
  shapes: Map<string, Bounds>;
  labels: Map<string, Bounds>;
  names: Map<string, string>;
  types: Map<string, string>;
}

export async function readLaidOutShapes(xml: string): Promise<LaidOutShapes> {
  const { rootElement } = await new BpmnModdle().fromXML(xml);
  const result: LaidOutShapes = {
    shapes: new Map(),
    labels: new Map(),
    names: new Map(),
    types: new Map(),
  };
  for (const el of (rootElement as any).diagrams[0].plane.planeElement) {
    if (el.$type !== 'bpmndi:BPMNShape') {
      continue;
    }
    const id = el.bpmnElement.id;
    result.shapes.set(id, { ...el.bounds });
    result.names.set(id, el.bpmnElement.name ?? '');
    result.types.set(id, el.bpmnElement.$type);
    if (el.label?.bounds) {
      result.labels.set(id, { ...el.label.bounds });
    }
  }
  return result;
}

export interface LabelFitReport {
  /** Pools and lanes whose rotated name needs more than the two lines their header holds. */
  overflowingHeaders: string[];
  /** Activities whose wrapped label is taller than the box. */
  overflowingTasks: string[];
  /** Element labels that overlap a pool's or lane's header band. */
  labelsInHeaderBand: string[];
}

const TASK_LINE_HEIGHT = 14.4;
const TASK_PADDING = 5;

export function measureLabelFit(layout: LaidOutShapes): LabelFitReport {
  const report: LabelFitReport = {
    overflowingHeaders: [],
    overflowingTasks: [],
    labelsInHeaderBand: [],
  };
  const containers: Array<[string, Bounds]> = [];

  for (const [id, bounds] of layout.shapes) {
    const type = layout.types.get(id)!;
    const name = layout.names.get(id)!;
    if (type === 'bpmn:Participant' || type === 'bpmn:Lane') {
      containers.push([id, bounds]);
      if (countWrappedLines(name, bounds.height) > 2) {
        report.overflowingHeaders.push(id);
      }
    } else if (type.endsWith('Task') && name) {
      const lines = countWrappedLines(name, bounds.width - 2 * TASK_PADDING);
      if (lines * TASK_LINE_HEIGHT + 2 * TASK_PADDING > bounds.height) {
        report.overflowingTasks.push(id);
      }
    }
  }

  for (const [id, label] of layout.labels) {
    const hitsHeader = containers.some(
      ([, c]) =>
        label.x < c.x + LANE_HEADER_WIDTH &&
        label.x + label.width > c.x &&
        label.y < c.y + c.height &&
        label.y + label.height > c.y
    );
    if (hitsHeader) {
      report.labelsInHeaderBand.push(id);
    }
  }
  return report;
}
