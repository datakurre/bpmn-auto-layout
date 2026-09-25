import { describe, it, expect } from 'vitest';
import { BpmnModdle } from 'bpmn-moddle';
import { BpmnBuilder } from '../src/bpmn-builder';
import { layoutProcess } from '../src/index';
import { layoutScope, partitionScopeElements } from '../src/hierarchy/subprocess-layout';
import { rerouteTopLevelProcessFlows } from '../src/layout-engine';
import type { Bounds, Point } from '../src/types';

function extractBounds(xml: string, id: string): Bounds {
  const re = new RegExp(
    `<bpmndi:BPMNShape[^>]*bpmnElement="${id}"[^>]*>\\s*<dc:Bounds\\s+x="([-\\d.]+)"\\s+y="([-\\d.]+)"\\s+width="([-\\d.]+)"\\s+height="([-\\d.]+)"`
  );
  const match = re.exec(xml);
  if (!match) {
    throw new Error(`Shape "${id}" not found in xml`);
  }
  const [, x, y, width, height] = match;
  return { x: Number(x), y: Number(y), width: Number(width), height: Number(height) };
}

function extractWaypoints(xml: string, edgeId: string): Point[] {
  const re = new RegExp(
    `<bpmndi:BPMNEdge[^>]*bpmnElement="${edgeId}"[^>]*>([\\s\\S]*?)</bpmndi:BPMNEdge>`
  );
  const match = re.exec(xml);
  if (!match) {
    throw new Error(`Edge "${edgeId}" not found in xml`);
  }
  const waypointRe = /<di:waypoint\s+x="([-\d.]+)"\s+y="([-\d.]+)"/g;
  const points: Point[] = [];
  let wpMatch: RegExpExecArray | null;
  while ((wpMatch = waypointRe.exec(match[1])) !== null) {
    points.push({ x: Number(wpMatch[1]), y: Number(wpMatch[2]) });
  }
  return points;
}

// #100 phase 1 acceptance criterion: re-running the reroute on the final,
// already-laid-out bounds (with the process's real analysis) must reproduce
// exactly the waypoints layoutProcess actually emitted for every top-level
// sequence flow. This is what makes "route once, after placement" true rather
// than "route once, coincidentally matching a route computed earlier".
describe('rerouteTopLevelProcessFlows reproduces the real output (#100 phase 1, end-to-end)', () => {
  it('matches the output waypoints for a standalone process with a feedback loop', async () => {
    const builder = new BpmnBuilder('Proc');
    builder
      .addStartEvent('S', 'Start')
      .addTask('T1', 'Work 1')
      .addTask('T2', 'Work 2')
      .addEndEvent('E', 'End')
      .addSequenceFlow('F1', 'S', 'T1')
      .addSequenceFlow('F2', 'T1', 'T2')
      .addSequenceFlow('F3', 'T2', 'E')
      .addSequenceFlow('Retry', 'T2', 'T1');

    const xml = await builder.toXml();
    const finalXml = await layoutProcess(xml);

    const { rootElement } = await new BpmnModdle().fromXML(xml);
    const process = (rootElement as any).rootElements[0];
    const result = layoutScope(process);
    // Sanity check that this fixture actually exercises feedback-edge analysis,
    // not just plain forward flows.
    expect(result.analysis.feedbackEdges.has('Retry')).toBe(true);

    const shapeBoundsById = new Map(
      ['S', 'T1', 'T2', 'E'].map((id) => [id, extractBounds(finalXml, id)])
    );
    const { sequenceFlows } = partitionScopeElements(process);
    const edges = sequenceFlows.map((sf: any) => ({ element: sf, waypoints: [] as Point[] }));

    rerouteTopLevelProcessFlows(process, shapeBoundsById, { edges, analysis: result.analysis });

    for (const edge of edges) {
      expect(edge.waypoints).toEqual(extractWaypoints(finalXml, edge.element.id));
    }
  });

  it('matches the output waypoints in a collaboration where alignCollaborationPaths shifts a participant', async () => {
    const builder = new BpmnBuilder('Proc_A');
    builder
      .addStartEvent('A_s', 'Start')
      .addTask('A_1', 'Prepare')
      .addTask('A_send', 'Send request')
      .addTask('A_2', 'Follow up')
      .addEndEvent('A_e', 'End')
      .addSequenceFlow('A_f1', 'A_s', 'A_1')
      .addSequenceFlow('A_f2', 'A_1', 'A_send')
      .addSequenceFlow('A_f3', 'A_send', 'A_2')
      .addSequenceFlow('A_f4', 'A_2', 'A_e')
      .addProcess('Proc_B')
      .addStartEvent('B_s', 'Start')
      .addTask('B_receive', 'Receive request')
      .addEndEvent('B_e', 'End')
      .addSequenceFlow('B_f1', 'B_s', 'B_receive')
      .addSequenceFlow('B_f2', 'B_receive', 'B_e')
      .addParticipant('Pool_A', 'Proc_A', 'Sender')
      .addParticipant('Pool_B', 'Proc_B', 'Receiver')
      .addMessageFlow('MF1', 'A_send', 'B_receive');

    const xml = await builder.toXml();
    const finalXml = await layoutProcess(xml);

    // Confirm this fixture actually exercises the pair-shift path: A_send is
    // the 3rd node in its process and B_receive the 2nd in its own, so without
    // alignCollaborationPaths shifting Pool_B's content their centers would
    // land at different x. The message flow between them forces a shift.
    const sendBounds = extractBounds(finalXml, 'A_send');
    const receiveBounds = extractBounds(finalXml, 'B_receive');
    expect(receiveBounds.x + receiveBounds.width / 2).toBeCloseTo(
      sendBounds.x + sendBounds.width / 2,
      5
    );

    const { rootElement } = await new BpmnModdle().fromXML(xml);
    const processes = (rootElement as any).rootElements.filter(
      (el: any) => el.$type === 'bpmn:Process'
    );

    const shapeBoundsById = new Map<string, Bounds>();
    for (const id of ['A_s', 'A_1', 'A_send', 'A_2', 'A_e', 'B_s', 'B_receive', 'B_e']) {
      shapeBoundsById.set(id, extractBounds(finalXml, id));
    }

    for (const process of processes) {
      const result = layoutScope(process);
      const { sequenceFlows } = partitionScopeElements(process);
      const edges = sequenceFlows.map((sf: any) => ({ element: sf, waypoints: [] as Point[] }));

      rerouteTopLevelProcessFlows(process, shapeBoundsById, { edges, analysis: result.analysis });

      for (const edge of edges) {
        expect(edge.waypoints).toEqual(extractWaypoints(finalXml, edge.element.id));
      }
    }
  });
});
