import { describe, it, expect } from 'vitest';
import { BpmnBuilder } from '../src/bpmn-builder';
import { layoutProcess } from '../src/index';
import { scoreDiagram } from '../src/layout-metrics';

interface ExtractedBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function extractShapeBounds(xml: string): Map<string, ExtractedBounds> {
  const bounds = new Map<string, ExtractedBounds>();
  const shapeRegex =
    /<bpmndi:BPMNShape[^>]*bpmnElement="([^"]+)"[^>]*>\s*<dc:Bounds\s+x="([-\d.]+)"\s+y="([-\d.]+)"\s+width="([-\d.]+)"\s+height="([-\d.]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = shapeRegex.exec(xml)) !== null) {
    const [, id, x, y, width, height] = match;
    bounds.set(id, { x: Number(x), y: Number(y), width: Number(width), height: Number(height) });
  }
  return bounds;
}

function extractWaypointsByEdgePrefix(
  xml: string,
  prefix: string
): Array<{ x: number; y: number }> {
  const waypoints: Array<{ x: number; y: number }> = [];
  const edgeRegex = new RegExp(
    `<bpmndi:BPMNEdge[^>]*bpmnElement="${prefix}[^"]*"[^>]*>([\\s\\S]*?)</bpmndi:BPMNEdge>`,
    'g'
  );
  const waypointRegex = /<di:waypoint\s+x="([-\d.]+)"\s+y="([-\d.]+)"/g;
  let edgeMatch: RegExpExecArray | null;
  while ((edgeMatch = edgeRegex.exec(xml)) !== null) {
    let wpMatch: RegExpExecArray | null;
    waypointRegex.lastIndex = 0;
    while ((wpMatch = waypointRegex.exec(edgeMatch[1])) !== null) {
      waypoints.push({ x: Number(wpMatch[1]), y: Number(wpMatch[2]) });
    }
  }
  return waypoints;
}

function boundingBoxOf(boxes: ExtractedBounds[]): { minY: number; maxY: number } {
  return {
    minY: Math.min(...boxes.map((b) => b.y)),
    maxY: Math.max(...boxes.map((b) => b.y + b.height)),
  };
}

describe('Iteration 24: Multiple Top-Level Processes Without a Collaboration', () => {
  it('stacks two independent processes instead of overlapping them', async () => {
    const builder = new BpmnBuilder('Process_A');
    builder
      .addStartEvent('A_s', 'Start')
      .addTask('A_t', 'Do A')
      .addEndEvent('A_e', 'End')
      .addSequenceFlow('A_f1', 'A_s', 'A_t')
      .addSequenceFlow('A_f2', 'A_t', 'A_e')
      .addProcess('Process_B')
      .addStartEvent('B_s', 'Start')
      .addTask('B_t', 'Do B')
      .addEndEvent('B_e', 'End')
      .addSequenceFlow('B_f1', 'B_s', 'B_t')
      .addSequenceFlow('B_f2', 'B_t', 'B_e');

    const xml = await layoutProcess(await builder.toXml());
    const bounds = extractShapeBounds(xml);

    const aBounds = boundingBoxOf(['A_s', 'A_t', 'A_e'].map((id) => bounds.get(id)!));
    const bBounds = boundingBoxOf(['B_s', 'B_t', 'B_e'].map((id) => bounds.get(id)!));

    expect(aBounds.maxY).toBeLessThanOrEqual(bBounds.minY);
    expect(bBounds.minY).toBeGreaterThan(aBounds.minY);

    const score = await scoreDiagram(xml);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
  });

  it('starts the next process below a loop channel that extends past the previous process', async () => {
    const builder = new BpmnBuilder('Process_A');
    builder
      .addStartEvent('A_s', 'Start')
      .addTask('A_t1', 'Work 1')
      .addTask('A_t2', 'Work 2')
      .addEndEvent('A_e', 'End')
      .addSequenceFlow('A_f1', 'A_s', 'A_t1')
      .addSequenceFlow('A_f2', 'A_t1', 'A_t2')
      .addSequenceFlow('A_f3', 'A_t2', 'A_e')
      .addSequenceFlow('A_retry', 'A_t2', 'A_t1')
      .addProcess('Process_B')
      .addStartEvent('B_s', 'Start')
      .addTask('B_t', 'Do B')
      .addEndEvent('B_e', 'End')
      .addSequenceFlow('B_f1', 'B_s', 'B_t')
      .addSequenceFlow('B_f2', 'B_t', 'B_e');

    const xml = await layoutProcess(await builder.toXml());
    const bounds = extractShapeBounds(xml);
    const aWaypoints = extractWaypointsByEdgePrefix(xml, 'A_');

    const aShapeIds = ['A_s', 'A_t1', 'A_t2', 'A_e'];
    const aShapeMaxY = Math.max(
      ...aShapeIds.map((id) => bounds.get(id)!.y + bounds.get(id)!.height)
    );
    const aContentMaxY = Math.max(aShapeMaxY, ...aWaypoints.map((wp) => wp.y));
    // The retry loop's channel must extend past the shapes' own bounds, otherwise
    // this fixture isn't exercising the waypoint-aware bottom computation at all.
    expect(aContentMaxY).toBeGreaterThan(aShapeMaxY);

    const bBounds = boundingBoxOf(['B_s', 'B_t', 'B_e'].map((id) => bounds.get(id)!));
    expect(bBounds.minY).toBeGreaterThanOrEqual(aContentMaxY);

    const score = await scoreDiagram(xml);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
  });

  it('keeps a lane in the second process from overlapping the first process', async () => {
    const builder = new BpmnBuilder('Process_A');
    builder
      .addStartEvent('A_s', 'Start')
      .addTask('A_t', 'Do A')
      .addEndEvent('A_e', 'End')
      .addSequenceFlow('A_f1', 'A_s', 'A_t')
      .addSequenceFlow('A_f2', 'A_t', 'A_e')
      .addProcess('Process_B')
      .addStartEvent('B_s', 'Start')
      .addTask('B_t1', 'Reviewer Task')
      .addTask('B_t2', 'Approver Task')
      .addEndEvent('B_e', 'End')
      .addSequenceFlow('B_f1', 'B_s', 'B_t1')
      .addSequenceFlow('B_f2', 'B_t1', 'B_t2')
      .addSequenceFlow('B_f3', 'B_t2', 'B_e')
      .addLane('Lane_Reviewer', ['B_s', 'B_t1'], 'Reviewer')
      .addLane('Lane_Approver', ['B_t2', 'B_e'], 'Approver');

    const xml = await layoutProcess(await builder.toXml());
    const bounds = extractShapeBounds(xml);

    const aBounds = boundingBoxOf(['A_s', 'A_t', 'A_e'].map((id) => bounds.get(id)!));
    const laneReviewer = bounds.get('Lane_Reviewer')!;
    const laneApprover = bounds.get('Lane_Approver')!;

    expect(laneReviewer.y).toBeGreaterThanOrEqual(aBounds.maxY);
    expect(laneApprover.y).toBeGreaterThanOrEqual(laneReviewer.y + laneReviewer.height);

    for (const id of ['B_s', 'B_t1', 'B_t2', 'B_e']) {
      const b = bounds.get(id)!;
      expect(b.y).toBeGreaterThanOrEqual(aBounds.maxY);
    }

    const score = await scoreDiagram(xml);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
  });
});
