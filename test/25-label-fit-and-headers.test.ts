import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { layoutProcess } from '../src/index';
import { layoutPathLabel, type PlacedEdge } from '../src/graph/label-layout';
import type { Bounds } from '../src/types';
import { scoreDiagram } from '../src/layout-metrics';
import {
  computeHeaderLabelLength,
  computeNodeDimensions,
  computeUniformActivityDimensions,
  countWrappedLines,
} from '../src/graph/text-fit';
import { expectSnapshotMatch } from './helpers/snapshot-helper';
import { measureLabelFit, readLaidOutShapes } from './helpers/label-fit-metrics';

const task = (name?: string) => ({ $type: 'bpmn:UserTask', name });
const process = (flowElements: any[]) => ({ flowElements });

const LONG_TASK =
  'Enter confirmed public-exam details and upload the final dissertation for printing approval';

describe('text-fit helpers', () => {
  it('counts wrapped lines greedily, breaking at spaces, hyphens and newlines', () => {
    expect(countWrappedLines('Short', 90)).toBe(1);
    expect(countWrappedLines('one\n\nthree', 90)).toBe(3);
    expect(countWrappedLines('Review application and propose preliminary examiners', 90)).toBe(5);
    expect(countWrappedLines('permission-to-print decision', 60)).toBeGreaterThan(
      countWrappedLines('permission-to-print decision', 200)
    );
  });

  it('sizes pool and lane headers so the label fits in two lines', () => {
    expect(computeHeaderLabelLength(undefined)).toBe(0);
    expect(computeHeaderLabelLength('  ')).toBe(0);
    expect(computeHeaderLabelLength('Customer')).toBeLessThanOrEqual(60);
    const name = 'Opponent — guide-derived, unobserved path';
    const length = computeHeaderLabelLength(name);
    expect(length % 10).toBe(0);
    expect(countWrappedLines(name, length)).toBeLessThanOrEqual(2);
    expect(countWrappedLines(name, length - 10)).toBeGreaterThan(2);
  });

  it('keeps the default box for unlabeled, short and non-activity nodes', () => {
    expect(computeNodeDimensions(undefined)).toEqual({ width: 100, height: 80 });
    expect(computeNodeDimensions('bpmn:StartEvent', LONG_TASK)).toEqual({ width: 36, height: 36 });
    expect(computeNodeDimensions('bpmn:UserTask')).toEqual({ width: 100, height: 80 });
    expect(computeNodeDimensions('bpmn:UserTask', '  ')).toEqual({ width: 100, height: 80 });
    expect(computeNodeDimensions('bpmn:UserTask', 'Assign opponent')).toEqual({
      width: 100,
      height: 80,
    });
  });

  it('widens an activity before making it taller', () => {
    const wide = computeNodeDimensions('bpmn:Task', 'Maintain progress, studies, publications');
    expect(wide.width).toBeGreaterThan(100);
    expect(wide.height).toBe(80);
    const tall = computeNodeDimensions('bpmn:UserTask', LONG_TASK);
    expect(tall.width).toBe(140);
    expect(tall.height).toBeGreaterThan(80);
  });

  it('gives every activity the uniform size when one is given, and leaves other nodes alone', () => {
    const uniform = { width: 140, height: 100 };
    expect(computeNodeDimensions('bpmn:UserTask', 'Short', uniform)).toEqual(uniform);
    expect(computeNodeDimensions('bpmn:Task', undefined, uniform)).toEqual(uniform);
    expect(computeNodeDimensions('bpmn:EndEvent', 'Done', uniform)).toEqual({
      width: 36,
      height: 36,
    });
  });

  it('computes the uniform size from the largest label, including nested activities', () => {
    expect(computeUniformActivityDimensions([])).toEqual({ width: 100, height: 80 });
    expect(computeUniformActivityDimensions([{}, process([task('Short')])])).toEqual({
      width: 100,
      height: 80,
    });
    const nested = process([
      task('Short'),
      { $type: 'bpmn:StartEvent', name: LONG_TASK },
      { $type: 'bpmn:SubProcess', flowElements: [task(LONG_TASK)] },
    ]);
    expect(computeUniformActivityDimensions([nested])).toEqual(
      computeNodeDimensions('bpmn:UserTask', LONG_TASK)
    );
  });

  it('reserves room for the task-type icon only on tasks that draw one', () => {
    const name = 'Review and release the statement to the student now';
    const plain = computeNodeDimensions('bpmn:Task', name);
    const withIcon = computeNodeDimensions('bpmn:UserTask', name);
    expect(withIcon.width).toBe(plain.width);
    expect(withIcon.height).toBeGreaterThan(plain.height);
  });
});

describe('Long labels in collaborations with lanes', () => {
  const fixture = readFileSync(
    new URL('./fixtures/grant-review-collaboration.bpmn', import.meta.url),
    'utf8'
  );

  it('lays out the grant review collaboration cleanly', async () => {
    const resultXml = await layoutProcess(fixture);
    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.metrics.edgeCrossings).toBe(0);
    expectSnapshotMatch(resultXml, '25-grant-review-collaboration');
  });

  it('gives every activity the same size by default', async () => {
    const { shapes } = await readLaidOutShapes(await layoutProcess(fixture));
    const sizes = new Set(
      [...shapes].filter(([id]) => id.startsWith('Task_')).map(([, b]) => `${b.width}x${b.height}`)
    );
    expect([...sizes]).toHaveLength(1);
    expect(shapes.get('Task_DraftProposal')!.width).toBeGreaterThan(100);
  });

  it('sizes each activity to its own label when normalizeActivitySizes is false', async () => {
    const xml = await layoutProcess(fixture, { normalizeActivitySizes: false });
    const layout = await readLaidOutShapes(xml);
    const sizes = new Set(
      [...layout.shapes]
        .filter(([id]) => id.startsWith('Task_'))
        .map(([, b]) => `${b.width}x${b.height}`)
    );
    expect(sizes.size).toBeGreaterThan(1);
    expect(measureLabelFit(layout).overflowingTasks).toEqual([]);
  });

  it('fits every header, task label and element label', async () => {
    const layout = await readLaidOutShapes(await layoutProcess(fixture));
    expect(measureLabelFit(layout)).toEqual({
      overflowingHeaders: [],
      overflowingTasks: [],
      labelsInHeaderBand: [],
    });
    expect(layout.labels.size).toBeGreaterThan(0);
    expect(layout.shapes.get('Task_DraftProposal')!.width).toBeGreaterThan(100);
  });

  it('reports what does not fit when a diagram keeps its own cramped shapes', () => {
    const cramped = {
      shapes: new Map([
        ['Pool', { x: 0, y: 0, width: 500, height: 60 }],
        ['Task', { x: 100, y: 0, width: 100, height: 80 }],
        ['Event', { x: 200, y: 0, width: 36, height: 36 }],
      ]),
      labels: new Map([['Event', { x: 10, y: 10, width: 40, height: 14 }]]),
      names: new Map([
        ['Pool', 'A pool name that is far too long to wrap into two lines of sixty pixels'],
        ['Task', LONG_TASK],
        ['Event', 'Done'],
      ]),
      types: new Map([
        ['Pool', 'bpmn:Participant'],
        ['Task', 'bpmn:UserTask'],
        ['Event', 'bpmn:EndEvent'],
      ]),
    };
    expect(measureLabelFit(cramped)).toEqual({
      overflowingHeaders: ['Pool'],
      overflowingTasks: ['Task'],
      labelsInHeaderBand: ['Event'],
    });
  });
});

describe('Pool headers without lanes', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Defs_Long" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:collaboration id="Collab_Long">
    <bpmn:participant id="Pool_Long" name="External expert reviewer — invited by the funding committee, unobserved path" processRef="Proc_Long" />
    <bpmn:participant id="Pool_Box" name="Funder portal operated by the national research council office" />
    <bpmn:messageFlow id="MF_1" sourceRef="Task_1" targetRef="Pool_Box" />
  </bpmn:collaboration>
  <bpmn:process id="Proc_Long" isExecutable="false">
    <bpmn:startEvent id="Start_1" name="Begin" />
    <bpmn:task id="Task_1" name="Work" />
    <bpmn:sequenceFlow id="SF_1" sourceRef="Start_1" targetRef="Task_1" />
  </bpmn:process>
</bpmn:definitions>`;

  it('grows a pool and a black-box pool to fit a long name and centers the content', async () => {
    const { shapes, names } = await readLaidOutShapes(await layoutProcess(xml));
    for (const id of ['Pool_Long', 'Pool_Box']) {
      expect(countWrappedLines(names.get(id)!, shapes.get(id)!.height)).toBeLessThanOrEqual(2);
    }
    expect(shapes.get('Pool_Box')!.height).toBeGreaterThan(60);
    const pool = shapes.get('Pool_Long')!;
    const box = shapes.get('Task_1')!;
    const above = box.y - pool.y;
    const below = pool.y + pool.height - (box.y + box.height);
    expect(Math.abs(above - below)).toBeLessThanOrEqual(10);
  });
});

const poolAt = (y: number) => ({
  element: { $type: 'bpmn:Participant' },
  bounds: { x: 0, y, width: 1000, height: 100 },
});
const verticalAt200 = (top: number, bottom: number) => [
  { x: 200, y: top },
  { x: 200, y: bottom },
];

describe('Message flow labels between pools', () => {
  const pools = [poolAt(0), poolAt(160), poolAt(320)];

  function labelOf(
    waypoints: Array<{ x: number; y: number }>,
    ctx: { pools?: typeof pools; placedLabels?: Bounds[] } = { pools }
  ): Bounds {
    const edge: PlacedEdge = {
      element: { $type: 'bpmn:MessageFlow', id: 'MF', name: 'Notification' },
      waypoints,
    };
    layoutPathLabel(edge, ctx.placedLabels ?? [], { shapes: [], edges: [edge], pools: ctx.pools });
    return edge.labelBounds!;
  }

  it('centers labels of flows leaving the same pool in the gap below it', () => {
    const short = labelOf([
      { x: 200, y: 100 },
      { x: 200, y: 160 + 50 },
    ]);
    const long = labelOf([
      { x: 600, y: 100 },
      { x: 600, y: 320 + 50 },
    ]);
    expect(short.y).toBe(long.y);
    expect(short.y).toBe(Math.round((100 + 160 - short.height) / 2));
    expect(short.x).toBeGreaterThan(200);
  });

  it('uses the gap below the upper pool of the flow, wherever it ends', () => {
    const label = labelOf([
      { x: 200, y: 260 },
      { x: 200, y: 320 },
    ]);
    expect(label.y).toBe(Math.round((260 + 320 - label.height) / 2));
  });

  it('moves to the other side of the flow when the near side is taken', () => {
    const label = labelOf(
      [
        { x: 200, y: 100 },
        { x: 200, y: 160 },
      ],
      { pools, placedLabels: [{ x: 205, y: 100, width: 300, height: 60 }] }
    );
    expect(label.x + label.width).toBeLessThan(200);
    expect(label.y).toBe(Math.round((100 + 160 - label.height) / 2));
  });

  it('falls back to the flow midpoint when no gap applies or fits', () => {
    const midpoint = (label: Bounds, top: number, bottom: number) =>
      expect(Math.abs(label.y + label.height / 2 - (top + bottom) / 2)).toBeLessThanOrEqual(1);

    midpoint(labelOf(verticalAt200(330, 410)), 330, 410); // last pool: nothing below it
    midpoint(labelOf(verticalAt200(130, 150), { pools }), 130, 150); // starts between pools
    midpoint(labelOf(verticalAt200(200, 300), { pools: undefined }), 200, 300); // no pools known
    const short = labelOf(verticalAt200(100, 110)); // segment doesn't reach the gap's center
    expect(Math.abs(short.y + short.height / 2 - 105)).toBeLessThanOrEqual(1);
    const blocked = labelOf(verticalAt200(100, 300), {
      pools,
      placedLabels: [
        { x: 205, y: 100, width: 300, height: 60 },
        { x: -300, y: 100, width: 495, height: 60 },
      ],
    });
    expect(blocked.y).not.toBe(Math.round((100 + 160 - blocked.height) / 2));
  });
});
