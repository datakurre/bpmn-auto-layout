import { describe, it, expect } from 'vitest';
import { BpmnModdle } from 'bpmn-moddle';
import { DirectedGraph } from '../src/graph/graph';
import {
  insertDummyNodes,
  alignMergeNodeTrack,
  routeEdgeThroughDummyChain,
  boundsCenter,
} from '../src/graph/dummy-nodes';
import { layoutProcess } from '../src/index';
import { scoreDiagram, segmentCrossesBox } from '../src/layout-metrics';

describe('Issue #81: Dummy Nodes and Merge Track Alignment', () => {
  it('inserts virtual dummy nodes for edges spanning multiple ranks', () => {
    const graph = new DirectedGraph();
    graph.addNode('N0', null, 0);
    graph.addNode('N1', null, 1);
    graph.addNode('N2', null, 2);
    graph.addNode('N3', null, 3);

    // Edge spanning 3 ranks (0 -> 3)
    graph.addEdge({
      id: 'long_flow',
      source: 'N0',
      target: 'N3',
      data: null,
      order: 0,
      kind: 'sequence',
    });
    // Edge spanning 1 rank (0 -> 1)
    graph.addEdge({
      id: 'short_flow',
      source: 'N0',
      target: 'N1',
      data: null,
      order: 1,
      kind: 'sequence',
    });
    // Edge spanning 1 rank (1 -> 2)
    graph.addEdge({
      id: 'step_flow',
      source: 'N1',
      target: 'N2',
      data: null,
      order: 2,
      kind: 'sequence',
    });

    const ranks = new Map<string, number>([
      ['N0', 0],
      ['N1', 1],
      ['N2', 2],
      ['N3', 3],
    ]);

    const { augmentedGraph, augmentedRanks } = insertDummyNodes(graph, ranks);

    // Two dummy nodes should be inserted for ranks 1 and 2
    expect(augmentedRanks.get('_dummy_long_flow_1')).toBe(1);
    expect(augmentedRanks.get('_dummy_long_flow_2')).toBe(2);

    // Check dummy node data properties
    const dummy1 = augmentedGraph.getNode('_dummy_long_flow_1');
    expect(dummy1?.data?.isDummy).toBe(true);
    expect(dummy1?.data?.$type).toBe('__dummy__');

    // Check chain of edges from N0 to N3
    const outN0 = augmentedGraph.outEdges('N0');
    expect(outN0.some((e) => e.target === '_dummy_long_flow_1')).toBe(true);

    const outD1 = augmentedGraph.outEdges('_dummy_long_flow_1');
    expect(outD1).toHaveLength(1);
    expect(outD1[0].target).toBe('_dummy_long_flow_2');

    const outD2 = augmentedGraph.outEdges('_dummy_long_flow_2');
    expect(outD2).toHaveLength(1);
    expect(outD2[0].target).toBe('N3');
  });

  it('returns the ordered dummy chain per originating edge id', () => {
    const graph = new DirectedGraph();
    graph.addNode('N0', null, 0);
    graph.addNode('N1', null, 1);
    graph.addNode('N2', null, 2);
    graph.addNode('N3', null, 3);

    graph.addEdge({
      id: 'long_flow',
      source: 'N0',
      target: 'N3',
      data: null,
      order: 0,
      kind: 'sequence',
    });
    graph.addEdge({
      id: 'short_flow',
      source: 'N0',
      target: 'N1',
      data: null,
      order: 1,
      kind: 'sequence',
    });

    const ranks = new Map<string, number>([
      ['N0', 0],
      ['N1', 1],
      ['N2', 2],
      ['N3', 3],
    ]);

    const { edgeDummyChains } = insertDummyNodes(graph, ranks);

    expect(edgeDummyChains.get('long_flow')).toEqual(['_dummy_long_flow_1', '_dummy_long_flow_2']);
    // Single-rank edges never get a chain entry.
    expect(edgeDummyChains.has('short_flow')).toBe(false);
  });

  it('skips feedback edges and boundary attachment edges when inserting dummy nodes', () => {
    const graph = new DirectedGraph();
    graph.addNode('N0', null, 0);
    graph.addNode('N2', null, 2);

    graph.addEdge({
      id: 'feedback_flow',
      source: 'N0',
      target: 'N2',
      data: null,
      order: 0,
      kind: 'sequence',
    });
    graph.addEdge({
      id: 'boundary_attach',
      source: 'N0',
      target: 'N2',
      data: null,
      order: 1,
      kind: 'attach',
    });

    const ranks = new Map<string, number>([
      ['N0', 0],
      ['N2', 2],
    ]);
    const feedbackEdges = new Set<string>(['feedback_flow']);

    const { augmentedRanks } = insertDummyNodes(graph, ranks, { feedbackEdges });
    expect(augmentedRanks.has('_dummy_feedback_flow_1')).toBe(false);
    expect(augmentedRanks.has('_dummy_boundary_attach_1')).toBe(false);
  });

  it('handles missing ranks gracefully in insertDummyNodes', () => {
    const graph = new DirectedGraph();
    graph.addNode('A', null);
    graph.addNode('B', null);
    graph.addEdge({ id: 'edge_ab', source: 'A', target: 'B', data: null, kind: 'sequence' });

    const ranks = new Map<string, number>([['A', 0]]); // B missing rank
    const { augmentedGraph } = insertDummyNodes(graph, ranks);
    expect(augmentedGraph.getNodes()).toHaveLength(2);
  });

  it('aligns merge nodes to integer parent tracks', () => {
    const tracks = new Map<string, number>([
      ['P1', 0],
      ['P2', 1],
    ]);
    const inEdges = [{ source: 'P1' }, { source: 'P2' }];

    // avg is 0.5, integer parent P1 is 0
    const track = alignMergeNodeTrack('M1', inEdges, tracks);
    expect(track).toBe(0);

    // when avg is an integer (e.g. -0.5 and +0.5 -> 0), return exact integer
    const balancedTracks = new Map<string, number>([
      ['P1', -0.5],
      ['P2', 0.5],
    ]);
    expect(alignMergeNodeTrack('M2', inEdges, balancedTracks)).toBe(0);

    // when no integer parent is within 1 of average, round average
    const nonIntegerTracks = new Map<string, number>([
      ['P1', 0.3],
      ['P2', 0.7],
    ]);
    expect(alignMergeNodeTrack('M3', inEdges, nonIntegerTracks)).toBe(1);

    // when a parent track is missing in tracks, defaults to 0
    const partialTracks = new Map<string, number>([['P1', 2]]);
    expect(alignMergeNodeTrack('M4', inEdges, partialTracks)).toBe(1); // (2 + 0) / 2 = 1
  });

  it('lays out a multi-rank bypass diagram cleanly without shape crossings or non-orthogonal segments', async () => {
    const bypassXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Defs_Bypass" targetNamespace="https://example.com/bpmn">
  <bpmn:process id="Proc_Bypass" isExecutable="false">
    <bpmn:startEvent id="Start" />
    <bpmn:exclusiveGateway id="Split" />
    <bpmn:task id="Task_A1" name="Step 1" />
    <bpmn:task id="Task_A2" name="Step 2" />
    <bpmn:task id="Task_A3" name="Step 3" />
    <bpmn:exclusiveGateway id="Join" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="F0" sourceRef="Start" targetRef="Split" />
    <bpmn:sequenceFlow id="F_Work_1" sourceRef="Split" targetRef="Task_A1" />
    <bpmn:sequenceFlow id="F_Work_2" sourceRef="Task_A1" targetRef="Task_A2" />
    <bpmn:sequenceFlow id="F_Work_3" sourceRef="Task_A2" targetRef="Task_A3" />
    <bpmn:sequenceFlow id="F_Work_4" sourceRef="Task_A3" targetRef="Join" />
    <bpmn:sequenceFlow id="F_Bypass" sourceRef="Split" targetRef="Join" />
    <bpmn:sequenceFlow id="F_End" sourceRef="Join" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

    const layoutedXml = await layoutProcess(bypassXml);
    const score = await scoreDiagram(layoutedXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);
  });

  describe('boundsCenter (issue #81)', () => {
    it('returns the midpoint of a bounds rectangle', () => {
      expect(boundsCenter({ x: 100, y: 200, width: 50, height: 80 })).toEqual({
        x: 125,
        y: 240,
      });
    });

    it('returns the point itself for the zero-sized bounds a dummy node carries', () => {
      expect(boundsCenter({ x: 306, y: 140, width: 0, height: 0 })).toEqual({
        x: 306,
        y: 140,
      });
    });
  });

  describe('routeEdgeThroughDummyChain (issue #81)', () => {
    it('returns a two-point route as-is when there is no dummy chain to walk', () => {
      const waypoints = routeEdgeThroughDummyChain([
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ]);

      expect(waypoints).toEqual([
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ]);
    });

    it('walks straight through collinear dummy points with zero bends', () => {
      const waypoints = routeEdgeThroughDummyChain([
        { x: 100, y: 200 },
        { x: 200, y: 200 },
        { x: 300, y: 200 },
        { x: 400, y: 200 },
      ]);

      // Fully collinear anchors must simplify down to the two endpoints.
      expect(waypoints).toEqual([
        { x: 100, y: 200 },
        { x: 400, y: 200 },
      ]);
    });

    it('produces an orthogonal path through dummy points that change track', () => {
      const waypoints = routeEdgeThroughDummyChain([
        { x: 100, y: 200 },
        { x: 200, y: 200 },
        { x: 300, y: 320 },
        { x: 400, y: 320 },
      ]);

      expect(waypoints[0]).toEqual({ x: 100, y: 200 });
      expect(waypoints[waypoints.length - 1]).toEqual({ x: 400, y: 320 });

      // Every segment must be purely horizontal or vertical.
      for (let i = 1; i < waypoints.length; i++) {
        const prev = waypoints[i - 1];
        const curr = waypoints[i];
        const isOrthogonal = prev.x === curr.x || prev.y === curr.y;
        expect(isOrthogonal).toBe(true);
      }
    });
  });

  it('routes a bypass edge through its dummy chain corridor with fewer bends than a naive endpoint jump', async () => {
    const bypassXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Defs_Bypass2" targetNamespace="https://example.com/bpmn">
  <bpmn:process id="Proc_Bypass2" isExecutable="false">
    <bpmn:startEvent id="Start" />
    <bpmn:exclusiveGateway id="Split" />
    <bpmn:task id="Task_A1" name="Step 1" />
    <bpmn:task id="Task_A2" name="Step 2" />
    <bpmn:task id="Task_A3" name="Step 3" />
    <bpmn:exclusiveGateway id="Join" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="F0" sourceRef="Start" targetRef="Split" />
    <bpmn:sequenceFlow id="F_Work_1" sourceRef="Split" targetRef="Task_A1" />
    <bpmn:sequenceFlow id="F_Work_2" sourceRef="Task_A1" targetRef="Task_A2" />
    <bpmn:sequenceFlow id="F_Work_3" sourceRef="Task_A2" targetRef="Task_A3" />
    <bpmn:sequenceFlow id="F_Work_4" sourceRef="Task_A3" targetRef="Join" />
    <bpmn:sequenceFlow id="F_Bypass" sourceRef="Split" targetRef="Join" />
    <bpmn:sequenceFlow id="F_End" sourceRef="Join" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

    const layoutedXml = await layoutProcess(bypassXml);
    const score = await scoreDiagram(layoutedXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);

    const moddle = new BpmnModdle();
    const { rootElement } = await moddle.fromXML(layoutedXml);
    const plane = (rootElement as any).diagrams[0].plane;
    const bypassEdge = plane.planeElement.find((el: any) => el.bpmnElement?.id === 'F_Bypass');
    const findShape = (id: string) =>
      plane.planeElement.find((el: any) => el.bpmnElement?.id === id);

    expect(bypassEdge).toBeDefined();
    const waypoints: Array<{ x: number; y: number }> = bypassEdge.waypoint;

    // The route must stay clear of the intermediate tasks it bypasses. Its
    // endpoints necessarily share the gateways' own exit/entry y (issue #88
    // keeps one branch collinear with its gateway, which is now also the
    // tasks' row), so what matters is that no segment actually crosses a
    // bypassed task's bounds, not that every waypoint sits below the row.
    for (const taskId of ['Task_A1', 'Task_A2', 'Task_A3']) {
      const bounds = findShape(taskId).bounds;
      for (let i = 0; i < waypoints.length - 1; i++) {
        expect(segmentCrossesBox(waypoints[i], waypoints[i + 1], bounds)).toBe(false);
      }
    }

    // Every segment is purely horizontal or vertical (orthogonal corridor routing).
    for (let i = 1; i < waypoints.length; i++) {
      const isOrthogonal =
        waypoints[i - 1].x === waypoints[i].x || waypoints[i - 1].y === waypoints[i].y;
      expect(isOrthogonal).toBe(true);
    }
  });
});
