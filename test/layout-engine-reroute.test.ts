import { describe, it, expect } from 'vitest';
import { routeScope, type ScopeAnalysis } from '../src/hierarchy/subprocess-layout';
import type { Point } from '../src/types';

interface RoutedEdge {
  element: { id: string };
  waypoints: Point[];
  isFeedback?: boolean;
}

function findEdge(edges: RoutedEdge[], id: string): RoutedEdge | undefined {
  return edges.find((e) => e.element.id === id);
}

describe('routeScope (#100/#103: route once, over final positions)', () => {
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

    const boundsMap = new Map([
      ['B1', { x: 300, y: 300, width: 100, height: 80 }],
      ['B2', { x: 250, y: 300, width: 100, height: 80 }],
    ]);

    // FB is a plain forward flow (no cycle), so recomputing feedback edges
    // from scratch would find nothing here. Supply an analysis that marks it
    // as feedback anyway -- as a return-path pass inside layoutScope would
    // have -- and check the route honors it rather than an empty recomputed
    // set.
    const analysisMap = new Map<string, ScopeAnalysis>([
      [
        'Proc2',
        { feedbackEdges: new Set(['FB']), returnNodes: new Set(), returnGateways: new Map() },
      ],
    ]);

    const edges = routeScope(process, { boundsMap, analysisMap });

    expect(findEdge(edges, 'FB')?.isFeedback).toBe(true);
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

    // boundsMap spans an entire collaboration; B1 belongs to a different
    // process and must not affect Proc1's own routing (it would sit directly
    // between A1 and A2 if it were treated as an obstacle).
    const boundsMap = new Map([
      ['A1', { x: 100, y: 100, width: 100, height: 80 }],
      ['A2', { x: 300, y: 100, width: 100, height: 80 }],
      ['B1', { x: 150, y: 130, width: 20, height: 20 }],
    ]);

    const edges = routeScope(process, { boundsMap, analysisMap: new Map() });

    expect(findEdge(edges, 'FA')?.waypoints[0]).toEqual({ x: 200, y: 140 });
    expect(findEdge(edges, 'FA')?.isFeedback).toBeUndefined();
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

    // C2 hasn't been placed yet, so it has no entry in boundsMap.
    const boundsMap = new Map([['C1', { x: 100, y: 100, width: 100, height: 80 }]]);

    expect(() => routeScope(process, { boundsMap, analysisMap: new Map() })).not.toThrow();
    const edges = routeScope(process, { boundsMap, analysisMap: new Map() });
    expect(findEdge(edges, 'FC')).toBeUndefined();
  });

  it('skips an artifact with no bounds yet when routing its association', () => {
    const process = {
      $type: 'bpmn:Process',
      id: 'Proc1',
      flowElements: [
        { id: 'D1', $type: 'bpmn:Task' },
        { id: 'Note_1', $type: 'bpmn:TextAnnotation' },
        {
          $type: 'bpmn:Association',
          id: 'Assoc_1',
          sourceRef: 'D1',
          targetRef: 'Note_1',
        },
      ],
    };

    // Note_1 hasn't been placed yet, so it has no entry in boundsMap.
    const boundsMap = new Map([['D1', { x: 100, y: 100, width: 100, height: 80 }]]);

    const edges = routeScope(process, { boundsMap, analysisMap: new Map() });
    expect(findEdge(edges, 'Assoc_1')).toBeUndefined();
  });
});
