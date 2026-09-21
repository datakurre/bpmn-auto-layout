import { describe, it, expect } from 'vitest';
import { DirectedGraph } from '../src/graph/graph';
import {
  alignReturnPathLayers,
  canReachEndEvent,
  detectReturnPathElements,
  isReturnGateway,
  isReturnNode,
  resolveReturnTargetId,
} from '../src/graph/return-path-layout';

function build(
  nodes: Array<[string, string]>,
  edges: Array<[string, string, string]>
): DirectedGraph {
  const g = new DirectedGraph();
  for (const [id, type] of nodes) {
    g.addNode(id, { $type: type });
  }
  for (const [id, source, target] of edges) {
    g.addEdge({ id, source, target, data: {} });
  }
  return g;
}

const TASK = 'bpmn:Task';
const GW = 'bpmn:ExclusiveGateway';

function loopGraph(withEnd: boolean): DirectedGraph {
  return build(
    [
      ['S', 'bpmn:StartEvent'],
      ['T', TASK],
      ['D', GW],
      ...(withEnd ? ([['E', 'bpmn:EndEvent']] as Array<[string, string]>) : []),
      ['R1', TASK],
      ['R1b', TASK],
      ['R2', TASK],
      ['RG', GW],
    ],
    [
      ['s-t', 'S', 'T'],
      ['t-d', 'T', 'D'],
      ...(withEnd ? ([['d-e', 'D', 'E']] as Array<[string, string, string]>) : []),
      ['d-r1', 'D', 'R1'],
      ['d-r1b', 'D', 'R1b'],
      ['r1-r2', 'R1', 'R2'],
      ['r1b-r2', 'R1b', 'R2'],
      ['r2-rg', 'R2', 'RG'],
      ['fb', 'RG', 'T'],
      ['_attach_x', 'R2', 'R1'],
    ]
  );
}

describe('return-path-layout', () => {
  it('detects return gateways and the nodes that cannot reach an end event', () => {
    const { returnGateways, returnNodes } = detectReturnPathElements(
      loopGraph(true),
      new Set(['fb'])
    );
    expect(returnGateways.get('RG')).toBe('T');
    expect([...returnNodes].sort()).toEqual(['D', 'R1', 'R1b', 'R2'].filter((n) => n !== 'D'));
  });

  it('does not treat forward nodes as return nodes when the scope has no end event', () => {
    const { returnGateways, returnNodes } = detectReturnPathElements(
      loopGraph(false),
      new Set(['fb'])
    );
    expect(returnGateways.has('RG')).toBe(true);
    expect(returnNodes.size).toBe(0);
  });

  it('ranks return nodes after their return-node predecessors', () => {
    const ranks = new Map([
      ['S', 0],
      ['T', 1],
      ['D', 5],
      ['E', 6],
      ['R1', 6],
      ['R1b', 6],
      ['R2', 7],
      ['RG', 8],
    ]);
    const feedbackEdges = new Set(['fb']);
    const lanes = new Map([
      ['RG', 1],
      ['T', 0],
    ]);
    const analysis = alignReturnPathLayers(loopGraph(true), ranks, {
      feedbackEdges,
      nodeToLane: lanes,
    });
    expect(analysis.returnNodes.size).toBe(3);
    expect(ranks.get('RG')).toBe(ranks.get('T'));
    expect(feedbackEdges.has('r2-rg')).toBe(true);
    expect(ranks.get('R1')!).toBeGreaterThan(ranks.get('R2')!);
    expect(ranks.get('R2')!).toBeGreaterThan(ranks.get('T')!);
  });

  it('skips return nodes without inputs or without ranked sources', () => {
    const g = build(
      [
        ['T', TASK],
        ['O', TASK],
        ['U', TASK],
        ['RG', GW],
        ['E', 'bpmn:EndEvent'],
        ['X', TASK],
      ],
      [
        ['t-x', 'T', 'X'],
        ['x-e', 'X', 'E'],
        ['o-rg', 'O', 'RG'],
        ['u-o', 'U', 'O'],
        ['fb', 'RG', 'T'],
      ]
    );
    const ranks = new Map([
      ['T', 0],
      ['O', 2],
      ['RG', 3],
      ['E', 2],
      ['X', 1],
    ]);
    const analysis = alignReturnPathLayers(g, ranks, { feedbackEdges: new Set(['fb']) });
    expect(analysis.returnNodes.has('O')).toBe(true);
    expect(analysis.returnNodes.has('U')).toBe(true);
    expect(ranks.has('U')).toBe(false);
    // The target has no rank, so the gateway keeps its own.
    const noTarget = new Map([['RG', 3]]);
    alignReturnPathLayers(g, noTarget, { feedbackEdges: new Set(['fb']) });
    expect(noTarget.get('RG')).toBe(3);
  });

  it('returns early when there is no return gateway', () => {
    const g = build(
      [
        ['A', TASK],
        ['B', TASK],
      ],
      [['a-b', 'A', 'B']]
    );
    const analysis = alignReturnPathLayers(g, new Map(), { feedbackEdges: new Set() });
    expect(analysis.returnGateways.size).toBe(0);
  });

  it('answers membership helpers with and without data', () => {
    expect(isReturnNode('a', new Set(['a']))).toBe(true);
    expect(isReturnNode('a')).toBe(false);
    expect(isReturnGateway('g', new Map([['g', 't']]))).toBe(true);
    expect(isReturnGateway('g')).toBe(false);
  });

  it('falls back to sourceRank - 1 when no candidate ranks are available', () => {
    const g = build(
      [
        ['T', TASK],
        ['D', GW],
        ['E', 'bpmn:EndEvent'],
        ['R', TASK],
        ['RG', GW],
      ],
      [
        ['t-d', 'T', 'D'],
        ['d-e', 'D', 'E'],
        ['d-r', 'D', 'R'],
        ['r-rg', 'R', 'RG'],
        ['fb', 'RG', 'T'],
      ]
    );
    const ranks = new Map([
      ['T', 1],
      ['D', 2],
      ['E', 3],
      ['R', 2],
      ['RG', 3],
    ]);
    const lanes = new Map([
      ['RG', 1],
      ['T', 0],
    ]);
    alignReturnPathLayers(g, ranks, { feedbackEdges: new Set(['fb']), nodeToLane: lanes });
    expect(ranks.get('R')).toBe(1);
  });

  it('handles return node targeting element without gateway in map or target rank', () => {
    const g = build(
      [
        ['T', TASK],
        ['D', GW],
        ['E', 'bpmn:EndEvent'],
        ['R', TASK],
        ['RG', GW],
      ],
      [
        ['d-e', 'D', 'E'],
        ['d-r', 'D', 'R'],
        ['r-rg', 'R', 'RG'],
        ['fb', 'RG', 'T'],
      ]
    );
    expect(
      resolveReturnTargetId('R', g, { returnNodes: new Set(), returnGateways: new Map() })
    ).toBe('RG');

    const ranks = new Map([
      ['D', 3],
      ['E', 3],
      ['R', 2],
    ]);
    alignReturnPathLayers(g, ranks, { feedbackEdges: new Set(['fb']) });
    expect(ranks.get('R')).toBe(1);
  });

  it('skips already visited nodes in canReachEndEvent diamond search', () => {
    const g = build(
      [
        ['S', TASK],
        ['A', TASK],
        ['B', TASK],
        ['C', TASK],
      ],
      [
        ['s-a', 'S', 'A'],
        ['s-b', 'S', 'B'],
        ['a-c', 'A', 'C'],
        ['b-c', 'B', 'C'],
      ]
    );
    expect(canReachEndEvent('S', g, new Set())).toBe(false);
  });
});
