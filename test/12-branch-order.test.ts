import { describe, it, expect } from 'vitest';
import { BpmnModdle } from 'bpmn-moddle';
import { layoutProcess } from '../src/index';
import { scoreDiagram } from '../src/layout-metrics';

describe('Issue #78: Gateway Branch Ordering by Document Order', () => {
  it('preserves declared outgoing order when flow IDs are in reverse alphabetical order', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Defs" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:startEvent id="Start_1" />
    <bpmn:exclusiveGateway id="Split_1">
      <bpmn:incoming>Flow_0</bpmn:incoming>
      <bpmn:outgoing>zzz_first</bpmn:outgoing>
      <bpmn:outgoing>mmm_second</bpmn:outgoing>
      <bpmn:outgoing>aaa_third</bpmn:outgoing>
    </bpmn:exclusiveGateway>
    <bpmn:task id="Task_1" name="First Branch" />
    <bpmn:task id="Task_2" name="Second Branch" />
    <bpmn:task id="Task_3" name="Third Branch" />
    <bpmn:exclusiveGateway id="Join_1" />
    <bpmn:endEvent id="End_1" />
    <bpmn:sequenceFlow id="Flow_0" sourceRef="Start_1" targetRef="Split_1" />
    <bpmn:sequenceFlow id="zzz_first" sourceRef="Split_1" targetRef="Task_1" />
    <bpmn:sequenceFlow id="mmm_second" sourceRef="Split_1" targetRef="Task_2" />
    <bpmn:sequenceFlow id="aaa_third" sourceRef="Split_1" targetRef="Task_3" />
    <bpmn:sequenceFlow id="Flow_4" sourceRef="Task_1" targetRef="Join_1" />
    <bpmn:sequenceFlow id="Flow_5" sourceRef="Task_2" targetRef="Join_1" />
    <bpmn:sequenceFlow id="Flow_6" sourceRef="Task_3" targetRef="Join_1" />
    <bpmn:sequenceFlow id="Flow_7" sourceRef="Join_1" targetRef="End_1" />
  </bpmn:process>
</bpmn:definitions>`;

    const layoutedXml = await layoutProcess(xml);
    const score = await scoreDiagram(layoutedXml);
    expect(score.isValid).toBe(true);

    const moddle = new BpmnModdle();
    const { rootElement } = await moddle.fromXML(layoutedXml);
    const plane = (rootElement as any).diagrams[0].plane;

    const findShape = (id: string) =>
      plane.planeElement.find((el: any) => el.bpmnElement?.id === id);

    const task1Shape = findShape('Task_1');
    const task2Shape = findShape('Task_2');
    const task3Shape = findShape('Task_3');

    expect(task1Shape).toBeDefined();
    expect(task2Shape).toBeDefined();
    expect(task3Shape).toBeDefined();

    // In top-to-bottom layout, smaller Y is above larger Y
    // zzz_first (Task_1) must be placed higher than mmm_second (Task_2)
    // mmm_second (Task_2) must be placed higher than aaa_third (Task_3)
    expect(task1Shape.bounds.y).toBeLessThan(task2Shape.bounds.y);
    expect(task2Shape.bounds.y).toBeLessThan(task3Shape.bounds.y);
  });

  it('tiebreaks edges by element ID when order is identical or undefined', async () => {
    const { DirectedGraph } = await import('../src/graph/graph');
    const graph = new DirectedGraph();
    graph.addNode('N1', null);
    graph.addNode('N2', null);
    graph.addNode('N3', null);
    graph.addNode('N4', null);

    graph.addEdge({
      id: 'z_edge',
      source: 'N1',
      target: 'N2',
      data: null,
      order: 0,
      kind: 'sequence',
    });
    graph.addEdge({
      id: 'a_edge',
      source: 'N1',
      target: 'N3',
      data: null,
      order: 0,
      kind: 'sequence',
    });
    graph.addEdge({ id: 'm_edge', source: 'N1', target: 'N4', data: null, kind: 'sequence' }); // order undefined

    const out = graph.outEdges('N1');
    expect(out).toHaveLength(3);
    expect(out[0].id).toBe('a_edge');
    expect(out[1].id).toBe('m_edge');
    expect(out[2].id).toBe('z_edge');

    const inN2 = graph.inEdges('N2');
    expect(inN2).toHaveLength(1);

    expect(graph.outEdges('unknown_id')).toEqual([]);
    expect(graph.inEdges('unknown_id')).toEqual([]);
  });

  it('falls back to index order when flow is not present in source outgoing list', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Defs" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:task id="T1">
      <bpmn:outgoing>other_flow</bpmn:outgoing>
    </bpmn:task>
    <bpmn:task id="T2" />
    <bpmn:sequenceFlow id="actual_flow" sourceRef="T1" targetRef="T2" />
  </bpmn:process>
</bpmn:definitions>`;

    const layouted = await layoutProcess(xml, { lenientFlowValidation: true });
    expect(layouted).toBeDefined();
  });

  it('preserves document order for independent disjoint chains regardless of element ID (issue #78 residual)', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Defs" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:startEvent id="StartZ" />
    <bpmn:task id="ZebraTask" />
    <bpmn:startEvent id="StartA" />
    <bpmn:task id="AlphaTask" />
    <bpmn:sequenceFlow id="Flow_Z" sourceRef="StartZ" targetRef="ZebraTask" />
    <bpmn:sequenceFlow id="Flow_A" sourceRef="StartA" targetRef="AlphaTask" />
  </bpmn:process>
</bpmn:definitions>`;

    const layoutedXml = await layoutProcess(xml);
    const score = await scoreDiagram(layoutedXml);
    expect(score.isValid).toBe(true);

    const moddle = new BpmnModdle();
    const { rootElement } = await moddle.fromXML(layoutedXml);
    const plane = (rootElement as any).diagrams[0].plane;

    const findShape = (id: string) =>
      plane.planeElement.find((el: any) => el.bpmnElement?.id === id);

    const startZShape = findShape('StartZ');
    const startAShape = findShape('StartA');

    expect(startZShape).toBeDefined();
    expect(startAShape).toBeDefined();

    // StartZ is declared first in the document, so it must render above
    // StartA even though 'StartA' sorts before 'StartZ' alphabetically.
    expect(startZShape.bounds.y).toBeLessThan(startAShape.bounds.y);
  });

  it('falls back to id comparison when both track and order are tied', async () => {
    const { DirectedGraph } = await import('../src/graph/graph');
    const { assignCoordinates } = await import('../src/graph/coordinate-assignment');
    const graph = new DirectedGraph();
    // Two disconnected roots with identical order collide on the same track (0);
    // resolveRankCollisions must still deterministically separate them by id.
    graph.addNode('NodeB', { $type: 'bpmn:Task' }, 0);
    graph.addNode('NodeA', { $type: 'bpmn:Task' }, 0);

    const ranks = new Map<string, number>([
      ['NodeB', 0],
      ['NodeA', 0],
    ]);

    const bounds = assignCoordinates(graph, ranks);
    expect(bounds.get('NodeA')!.y).toBeLessThan(bounds.get('NodeB')!.y);
  });

  it('falls back to id comparison when order is undefined on both colliding nodes', async () => {
    const { DirectedGraph } = await import('../src/graph/graph');
    const { assignCoordinates } = await import('../src/graph/coordinate-assignment');
    const graph = new DirectedGraph();
    graph.addNode('NodeB', { $type: 'bpmn:Task' });
    graph.addNode('NodeA', { $type: 'bpmn:Task' });

    const ranks = new Map<string, number>([
      ['NodeB', 0],
      ['NodeA', 0],
    ]);

    const bounds = assignCoordinates(graph, ranks);
    expect(bounds.get('NodeA')!.y).toBeLessThan(bounds.get('NodeB')!.y);
  });

  it('handles all order comparison permutations', async () => {
    const { DirectedGraph } = await import('../src/graph/graph');
    const graph = new DirectedGraph();
    graph.addNode('N1', null);
    graph.addNode('N2', null);

    graph.addEdge({ id: 'e1', source: 'N1', target: 'N2', data: null, order: 2, kind: 'sequence' });
    graph.addEdge({ id: 'e2', source: 'N1', target: 'N2', data: null, order: 1, kind: 'sequence' });
    graph.addEdge({ id: 'e3', source: 'N1', target: 'N2', data: null, order: 0, kind: 'sequence' });
    graph.addEdge({ id: 'e4', source: 'N1', target: 'N2', data: null, kind: 'sequence' });

    const out = graph.outEdges('N1');
    expect(out).toHaveLength(4);
    expect(out[0].id).toBe('e3');
    expect(out[1].id).toBe('e4');
    expect(out[2].id).toBe('e2');
    expect(out[3].id).toBe('e1');
  });
});
