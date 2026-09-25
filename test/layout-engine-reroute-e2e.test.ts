import { describe, it, expect } from 'vitest';
import { BpmnModdle } from 'bpmn-moddle';
import { BpmnBuilder } from '../src/bpmn-builder';
import { layoutProcess } from '../src/index';
import { layoutScope, routeScope, type ScopeAnalysis } from '../src/hierarchy/subprocess-layout';
import {
  alignIntraProcessBranches,
  type AlignableScopeResult,
} from '../src/hierarchy/path-alignment';
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

function buildAnalysisMap(
  processId: string,
  result: { analysis: ScopeAnalysis; childAnalysis: Map<string, ScopeAnalysis> }
): Map<string, ScopeAnalysis> {
  return new Map([[processId, result.analysis], ...result.childAnalysis]);
}

// #100/#103 acceptance criterion: re-running the final routing on the
// output's bounds, with each scope's own analysis, must reproduce exactly the
// waypoints layoutProcess actually emitted for every sequence flow and
// association -- top-level, inside a subprocess, and after a subprocess has
// been moved by alignIntraProcessBranches. This is what makes "route once,
// after placement" true rather than "route once, coincidentally matching a
// route computed earlier".
describe('routeScope reproduces the real output (#100/#103, end-to-end)', () => {
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

    const boundsMap = new Map(
      ['S', 'T1', 'T2', 'E'].map((id) => [id, extractBounds(finalXml, id)])
    );
    const analysisMap = buildAnalysisMap(process.id, result);
    const edges = routeScope(process, { boundsMap, analysisMap });

    expect(edges.length).toBeGreaterThan(0);
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

    const boundsMap = new Map<string, Bounds>();
    for (const id of ['A_s', 'A_1', 'A_send', 'A_2', 'A_e', 'B_s', 'B_receive', 'B_e']) {
      boundsMap.set(id, extractBounds(finalXml, id));
    }

    let matchedAny = false;
    for (const process of processes) {
      const result = layoutScope(process);
      const analysisMap = buildAnalysisMap(process.id, result);
      const edges = routeScope(process, { boundsMap, analysisMap });

      for (const edge of edges) {
        matchedAny = true;
        expect(edge.waypoints).toEqual(extractWaypoints(finalXml, edge.element.id));
      }
    }
    expect(matchedAny).toBe(true);
  });

  it('matches the output for flows inside a subprocess that alignIntraProcessBranches shifts', () => {
    // Same fixture as the "shifts a shifted subprocess's descendant shapes
    // along with it" test in path-alignment.test.ts: a candidate gateway
    // (GW1) whose non-join branch is a SubProcess (Fail) containing its own
    // task and a self-loop sequence flow. alignIntraProcessBranches shifts
    // Fail (and its descendant shapes) right by deltaX; routeScope must then
    // route Fail's internal flow, and the flow from GW1 into Fail, using
    // Fail's new position -- not a stale, rigidly-translated route.
    const gw = { id: 'GW1', $type: 'bpmn:ExclusiveGateway' };
    const join = { id: 'Join1', $type: 'bpmn:ExclusiveGateway' };
    const obs = { id: 'Obs', $type: 'bpmn:Task' };
    const col1 = { id: 'Col1', $type: 'bpmn:Task' };
    const col2 = { id: 'Col2', $type: 'bpmn:Task' };
    const child = { id: 'Sub_Child', $type: 'bpmn:Task' };
    const childFlow = {
      id: 'Sub_Flow',
      $type: 'bpmn:SequenceFlow',
      sourceRef: 'Sub_Child',
      targetRef: 'Sub_Child',
    };
    const sub = { id: 'Fail', $type: 'bpmn:SubProcess', flowElements: [child, childFlow] };
    const failEnd = { id: 'FailEnd', $type: 'bpmn:EndEvent' };

    const flowJoin = {
      $type: 'bpmn:SequenceFlow',
      id: 'F_Join',
      sourceRef: 'GW1',
      targetRef: 'Join1',
    };
    const flowJoinObs = {
      $type: 'bpmn:SequenceFlow',
      id: 'F_JoinObs',
      sourceRef: 'Obs',
      targetRef: 'Join1',
    };
    const flowFail = {
      $type: 'bpmn:SequenceFlow',
      id: 'F_Fail',
      sourceRef: 'GW1',
      targetRef: 'Fail',
    };
    const flowDownstream = {
      $type: 'bpmn:SequenceFlow',
      id: 'F_Downstream',
      sourceRef: 'Fail',
      targetRef: 'FailEnd',
    };

    const process = {
      id: 'Proc1',
      $type: 'bpmn:Process',
      flowElements: [
        gw,
        join,
        obs,
        col1,
        col2,
        sub,
        failEnd,
        flowJoin,
        flowJoinObs,
        flowFail,
        flowDownstream,
      ],
    };

    const result: AlignableScopeResult = {
      width: 800,
      minX: 100,
      shapes: [
        { element: gw, bounds: { x: 100, y: 100, width: 50, height: 50 } },
        { element: join, bounds: { x: 600, y: 200, width: 50, height: 50 } },
        { element: obs, bounds: { x: 100, y: 160, width: 100, height: 80 } },
        { element: col1, bounds: { x: 300, y: 160, width: 100, height: 80 } },
        { element: col2, bounds: { x: 350, y: 160, width: 100, height: 80 } },
        { element: sub, bounds: { x: 180, y: 100, width: 100, height: 50 }, isExpanded: true },
        { element: failEnd, bounds: { x: 320, y: 100, width: 36, height: 36 } },
        { element: child, bounds: { x: 200, y: 110, width: 40, height: 30 } },
      ],
    };

    const shifted = alignIntraProcessBranches({ process, result });
    expect(shifted).toBe(true);

    const boundsMap = new Map(result.shapes.map((s) => [s.element.id, s.bounds]));
    const edges = routeScope(process, { boundsMap, analysisMap: new Map() });

    const edgeMap = new Map(edges.map((e) => [e.element.id, e]));
    const subChildBounds = boundsMap.get('Sub_Child')!;

    // Sub_Flow is a self-loop on Sub_Child; whatever route the router picks
    // for it must sit at Sub_Child's actual (post-shift) position, not the
    // pre-shift one.
    const subFlowWaypoints = edgeMap.get('Sub_Flow')!.waypoints;
    expect(subFlowWaypoints.length).toBeGreaterThan(0);
    for (const wp of subFlowWaypoints) {
      expect(wp.x).toBeGreaterThanOrEqual(subChildBounds.x);
      expect(wp.x).toBeLessThanOrEqual(subChildBounds.x + subChildBounds.width);
    }

    // F_Fail (GW1 -> Fail) must land on Fail's shifted bounds too.
    const failBounds = boundsMap.get('Fail')!;
    const flowFailWaypoints = edgeMap.get('F_Fail')!.waypoints;
    const lastPoint = flowFailWaypoints[flowFailWaypoints.length - 1];
    expect(lastPoint.x).toBeGreaterThanOrEqual(failBounds.x - 1);
    expect(lastPoint.x).toBeLessThanOrEqual(failBounds.x + failBounds.width + 1);
  });
});
