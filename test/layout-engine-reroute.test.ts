import { describe, it, expect } from 'vitest';
import { rerouteTopLevelProcessFlows } from '../src/layout-engine';
import type { Point } from '../src/types';

interface TestEdge {
  element: any;
  waypoints: Point[];
  isFeedback?: boolean;
}

describe('rerouteTopLevelProcessFlows (#100 phase 1)', () => {
  it('routes using the supplied analysis rather than recomputing feedback edges from scratch', () => {
    const process = {
      $type: 'bpmn:Process',
      id: 'Proc2',
      flowElements: [
        { id: 'B1', $type: 'bpmn:Task' },
        { id: 'B2', $type: 'bpmn:Task' },
        { $type: 'bpmn:SequenceFlow', id: 'FB', sourceRef: 'B1', targetRef: 'B2' },
      ],
    };

    const shapeBoundsById = new Map([
      ['B1', { x: 300, y: 300, width: 100, height: 80 }],
      ['B2', { x: 250, y: 300, width: 100, height: 80 }],
    ]);

    // FB is a plain forward flow (no cycle), so recomputing feedback edges
    // from scratch would find nothing here. Supply an analysis that marks it
    // as feedback anyway -- as a return-path pass inside layoutScope would
    // have -- and check the reroute honors it rather than an empty
    // recomputed set (this is the #94 defect B behavior, now exercised from
    // its new call site rather than from inside alignCollaborationPaths).
    const edgeFB: TestEdge = {
      element: { id: 'FB', sourceRef: 'B1', targetRef: 'B2' },
      waypoints: [
        { x: 200, y: 340 },
        { x: 250, y: 340 },
      ],
    };

    rerouteTopLevelProcessFlows(process, shapeBoundsById, {
      edges: [edgeFB],
      analysis: {
        feedbackEdges: new Set(['FB']),
        returnNodes: new Set(),
        returnGateways: new Map(),
      },
    });

    expect(edgeFB.isFeedback).toBe(true);
  });

  it('only looks up bounds for the given process, ignoring shapes from other processes', () => {
    const process = {
      $type: 'bpmn:Process',
      id: 'Proc1',
      flowElements: [
        { id: 'A1', $type: 'bpmn:Task' },
        { id: 'A2', $type: 'bpmn:Task' },
        { $type: 'bpmn:SequenceFlow', id: 'FA', sourceRef: 'A1', targetRef: 'A2' },
      ],
    };

    // shapeBoundsById spans an entire collaboration; B1 belongs to a
    // different process and must not affect Proc1's own routing.
    const shapeBoundsById = new Map([
      ['A1', { x: 100, y: 100, width: 100, height: 80 }],
      ['A2', { x: 300, y: 100, width: 100, height: 80 }],
      ['B1', { x: 150, y: 130, width: 20, height: 20 }],
    ]);

    const edgeFA: TestEdge = {
      element: { id: 'FA', sourceRef: 'A1', targetRef: 'A2' },
      waypoints: [{ x: 200, y: 140 }],
    };

    rerouteTopLevelProcessFlows(process, shapeBoundsById, { edges: [edgeFA] });

    expect(edgeFA.waypoints[0]).toEqual({ x: 200, y: 140 });
    expect(edgeFA.isFeedback).toBeUndefined();
  });

  it('skips a node with no bounds yet instead of throwing', () => {
    const process = {
      $type: 'bpmn:Process',
      id: 'Proc1',
      flowElements: [
        { id: 'C1', $type: 'bpmn:Task' },
        { id: 'C2', $type: 'bpmn:Task' },
        { $type: 'bpmn:SequenceFlow', id: 'FC', sourceRef: 'C1', targetRef: 'C2' },
      ],
    };

    // C2 hasn't been placed yet, so it has no entry in shapeBoundsById.
    const shapeBoundsById = new Map([['C1', { x: 100, y: 100, width: 100, height: 80 }]]);

    const edgeFC: TestEdge = {
      element: { id: 'FC', sourceRef: 'C1', targetRef: 'C2' },
      waypoints: [{ x: 200, y: 140 }],
    };

    expect(() =>
      rerouteTopLevelProcessFlows(process, shapeBoundsById, { edges: [edgeFC] })
    ).not.toThrow();
  });
});
