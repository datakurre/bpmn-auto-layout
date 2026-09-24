import { describe, it, expect } from 'vitest';
import { DirectedGraph, isAttachEdge } from '../src/graph/graph';

describe('DirectedGraph', () => {
  it('throws when adding an edge whose id already exists', () => {
    const graph = new DirectedGraph();
    graph.addNode('A', null);
    graph.addNode('B', null);
    graph.addNode('C', null);
    graph.addEdge({ id: 'e1', source: 'A', target: 'B', data: null, kind: 'sequence' });

    expect(() =>
      graph.addEdge({ id: 'e1', source: 'A', target: 'C', data: null, kind: 'sequence' })
    ).toThrow('Duplicate edge id: e1');
  });
});

describe('isAttachEdge', () => {
  it('is true only for edges whose kind is attach', () => {
    expect(isAttachEdge({ kind: 'attach' })).toBe(true);
    expect(isAttachEdge({ kind: 'sequence' })).toBe(false);
    expect(isAttachEdge({ kind: 'dummy' })).toBe(false);
  });
});
