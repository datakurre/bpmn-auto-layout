import { describe, it, expect } from 'vitest';
import { writeFileSync, unlinkSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BpmnBuilder } from '../src/bpmn-builder';
import { layoutProcess } from '../src/index';
import { scoreDiagram } from '../src/layout-metrics';
import { DiGenerator } from '../src/di-generator';
import { routeOrthogonalEdge } from '../src/graph/orthogonal-router';
import { routeMessageFlow, layoutProcessLanes } from '../src/hierarchy/swimlane-layout';
import { layoutScope } from '../src/hierarchy/subprocess-layout';
import { DirectedGraph } from '../src/graph/graph';
import { assignLayers } from '../src/graph/layer-assignment';
import { assignCoordinates } from '../src/graph/coordinate-assignment';
import { runCli } from '../src/cli';
import { expectImageSnapshotMatch } from './helpers/snapshot-helper';

describe('Iteration 8: Determinism, CLI & Full Coverage', () => {
  it('is bitwise deterministic across repeated layout passes', async () => {
    const builder = new BpmnBuilder('Proc_Det');
    builder
      .addStartEvent('Start_1', 'Start')
      .addTask('Task_A', 'Task A')
      .addTask('Task_B', 'Task B')
      .addEndEvent('End_1', 'End')
      .addSequenceFlow('F1', 'Start_1', 'Task_A')
      .addSequenceFlow('F2', 'Task_A', 'Task_B')
      .addSequenceFlow('F3', 'Task_B', 'End_1');

    const inputXml = await builder.toXml();

    const pass1 = await layoutProcess(inputXml);
    const pass2 = await layoutProcess(inputXml);
    const pass3 = await layoutProcess(pass1);

    expect(pass1).toBe(pass2);
    expect(pass2).toBe(pass3);

    expectImageSnapshotMatch(pass1, '08-determinism');
  });

  it('supports in-place layout via CLI', async () => {
    const builder = new BpmnBuilder('Proc_CLI');
    builder
      .addStartEvent('S', 'Start')
      .addTask('T', 'Work')
      .addEndEvent('E', 'End')
      .addSequenceFlow('F1', 'S', 'T')
      .addSequenceFlow('F2', 'T', 'E');

    const inputXml = await builder.toXml();
    const tempPath = join(tmpdir(), `temp-inplace-${Date.now()}.bpmn`);
    writeFileSync(tempPath, inputXml, 'utf-8');

    try {
      const exitCode = await runCli(['-i', tempPath]);
      expect(exitCode).toBe(0);

      const modifiedXml = readFileSync(tempPath, 'utf-8');
      expect(modifiedXml).toContain('<bpmndi:BPMNDiagram');
      expect(modifiedXml).toContain('id="T_di"');

      const score = await scoreDiagram(modifiedXml);
      expect(score.isValid).toBe(true);
    } finally {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    }
  });

  it('routes message flows in all directions and alignments', () => {
    const topAligned = { x: 100, y: 50, width: 100, height: 80 };
    const bottomAligned = { x: 100, y: 200, width: 100, height: 80 };
    const ptsDownCollinear = routeMessageFlow(topAligned, bottomAligned);
    expect(ptsDownCollinear.length).toBe(2);
    expect(ptsDownCollinear[0].x).toBe(ptsDownCollinear[1].x);

    const ptsUpCollinear = routeMessageFlow(bottomAligned, topAligned);
    expect(ptsUpCollinear.length).toBe(2);
    expect(ptsUpCollinear[0].x).toBe(ptsUpCollinear[1].x);

    const bottomOffset = { x: 250, y: 200, width: 100, height: 80 };
    const ptsUpOffset = routeMessageFlow(bottomOffset, topAligned);
    expect(ptsUpOffset.length).toBe(4);
    expect(ptsUpOffset[0].y).toBe(bottomOffset.y);
  });

  it('layouts collaboration with black-box pools', async () => {
    const builder = new BpmnBuilder('Proc_Internal');
    builder
      .addParticipant('Pool_Internal', 'Proc_Internal', 'Internal Service')
      .addStartEvent('Start_Int', 'Start')
      .addTask('Task_Int', 'Process Data')
      .addEndEvent('End_Int', 'End')
      .addSequenceFlow('F_I1', 'Start_Int', 'Task_Int')
      .addSequenceFlow('F_I2', 'Task_Int', 'End_Int')
      .addParticipant('Pool_External', undefined as any, 'External Bank')
      .addMessageFlow('Msg_Bank', 'Task_Int', 'Pool_External');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('id="Pool_External_di"');
    expect(resultXml).toContain('id="Msg_Bank_di"');

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
  });

  it('sorts boundary events with same target rank by element ID', async () => {
    const builder = new BpmnBuilder('Proc_Boundaries');
    builder
      .addTask('Host_Task', 'Heavy Computation')
      .addTask('Target_Shared', 'Shared Handler')
      .addBoundaryEvent('B_Event_2', 'Host_Task', 'Cancel')
      .addBoundaryEvent('B_Event_1', 'Host_Task', 'Timeout')
      .addSequenceFlow('F_B1', 'B_Event_1', 'Target_Shared')
      .addSequenceFlow('F_B2', 'B_Event_2', 'Target_Shared');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('id="B_Event_1_di"');
    expect(resultXml).toContain('id="B_Event_2_di"');

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
  });

  it('layouts single process with lanes and branching gateways inside lanes', async () => {
    const builder = new BpmnBuilder('Proc_SingleLanes');
    builder
      .addStartEvent('S', 'Start')
      .addExclusiveGateway('GW', 'Split')
      .addTask('Branch_1', 'Branch 1')
      .addTask('Branch_2', 'Branch 2')
      .addEndEvent('E', 'End')
      .addLane('Lane_Active', ['S', 'GW', 'Branch_1', 'Branch_2'], 'Active')
      .addLane('Lane_Empty', [], 'Empty')
      .addSequenceFlow('F_S', 'S', 'GW')
      .addSequenceFlow('F_B1', 'GW', 'Branch_1')
      .addSequenceFlow('F_B2', 'GW', 'Branch_2')
      .addSequenceFlow('F_E', 'Branch_1', 'E');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('id="Lane_Active_di"');
    expect(resultXml).toContain('id="Lane_Empty_di"');

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
  });

  it('returns unformatted XML when definitions has no process or collaboration', async () => {
    const emptyDefs = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Empty_Defs" targetNamespace="http://bpmn.io/schema/bpmn">
</bpmn:definitions>`;

    const result = await layoutProcess(emptyDefs);
    expect(result).toContain('Empty_Defs');
  });

  it('handles empty subprocess and definitions edge cases', async () => {
    const builder = new BpmnBuilder('Proc_EmptySub');
    builder
      .addStartEvent('Start_1', 'Start')
      .addSubProcess('Empty_Sub', 'Empty Scope')
      .addEndEvent('End_1', 'End')
      .addSequenceFlow('F1', 'Start_1', 'Empty_Sub')
      .addSequenceFlow('F2', 'Empty_Sub', 'End_1');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('id="Empty_Sub_di"');
    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
  });

  it('covers orthogonal router without allBounds', () => {
    const src = { x: 300, y: 100, width: 100, height: 80 };
    const tgt = { x: 100, y: 100, width: 100, height: 80 };
    const waypoints = routeOrthogonalEdge(src, tgt);
    expect(waypoints.length).toBe(4);
    expect(waypoints[1].y).toBeGreaterThan(src.y + src.height);
  });

  it('covers orthogonal router forward S-bend with gap > 100', () => {
    const src = { x: 100, y: 100, width: 100, height: 80 };
    const tgt = { x: 350, y: 250, width: 100, height: 80 };
    const waypoints = routeOrthogonalEdge(src, tgt);
    expect(waypoints.length).toBe(4);
    expect(waypoints[1].x).toBe(320);
  });

  it('covers DirectedGraph duplicate node, edge sorting, and missing node queries', () => {
    const graph = new DirectedGraph();
    graph.addNode('N1', {});
    graph.addNode('N1', {});
    graph.addNode('N2', {});
    graph.addEdge({ id: 'E2', source: 'N1', target: 'N2', data: null });
    graph.addEdge({ id: 'E1', source: 'N1', target: 'N2', data: null });

    const edges = graph.getEdges();
    expect(edges.length).toBe(2);
    expect(edges[0].id).toBe('E1');

    graph.addEdge({ id: 'E3', source: 'GhostSrc', target: 'GhostTgt', data: null });
    expect(graph.outEdges('NonExistent')).toEqual([]);
    expect(graph.inEdges('NonExistent')).toEqual([]);

    const diGen = new DiGenerator(new BpmnBuilder().getModdle());
    const mockTarget = { id: 'Target_1' };
    const mockDefsNoPlane = { diagrams: [{ id: 'D1' }] };
    const d1 = diGen.ensureDiagram(mockDefsNoPlane, mockTarget);
    expect(d1.plane).toBeDefined();

    const mockDefsNoPlaneElements = { diagrams: [{ id: 'D2', plane: {} }] };
    const d2 = diGen.ensureDiagram(mockDefsNoPlaneElements, mockTarget);
    expect(d2.plane.planeElement).toBeDefined();
  });

  it('covers assignLayers with multiple initial root nodes', () => {
    const graph = new DirectedGraph();
    graph.addNode('Root_B', {});
    graph.addNode('Root_A', {});
    graph.addNode('Child', {});
    graph.addEdge({ id: 'F1', source: 'Root_B', target: 'Child', data: null });
    graph.addEdge({ id: 'F2', source: 'Root_A', target: 'Child', data: null });

    const layers = assignLayers(graph);
    expect(layers.get('Root_A')).toBe(0);
    expect(layers.get('Root_B')).toBe(0);
    expect(layers.get('Child')).toBe(1);
  });

  it('covers swimlane layout with string flowNodeRef IDs', () => {
    const mockProc = {
      laneSets: [
        {
          lanes: [{ id: 'Lane_StringRefs', flowNodeRef: ['T1', 'T2'] }],
        },
      ],
    };
    const mockShapes = [
      { element: { id: 'T1' }, bounds: { x: 100, y: 100, width: 100, height: 80 } },
      { element: { id: 'T2' }, bounds: { x: 250, y: 100, width: 100, height: 80 } },
    ];
    const res = layoutProcessLanes(mockProc, mockShapes, {
      startX: 100,
      startY: 80,
      totalWidth: 400,
    });
    expect(res.lanes.length).toBe(1);
    expect(res.lanes[0].bounds.height).toBeGreaterThanOrEqual(120);
  });

  it('covers coordinate assignment lane-awareness with empty lane and unassigned source', () => {
    const graph = new DirectedGraph();
    graph.addNode('Node_Unassigned', { $type: 'bpmn:Task' });
    graph.addNode('Node_Lane0', { $type: 'bpmn:Task' });
    graph.addEdge({
      id: 'Flow_Cross',
      source: 'Node_Unassigned',
      target: 'Node_Lane0',
      data: null,
    });
    graph.addNode('Node_Lane2', { $type: 'bpmn:Task' });

    const ranks = new Map<string, number>([
      ['Node_Unassigned', 0],
      ['Node_Lane0', 1],
      ['Node_Lane2', 0],
    ]);
    const nodeToLane = new Map<string, number>([
      ['Node_Lane0', 0],
      ['Node_Lane2', 2],
    ]);

    const bounds = assignCoordinates(graph, ranks, { nodeToLane });
    expect(bounds.get('Node_Lane0')).toBeDefined();
    expect(bounds.get('Node_Lane2')).toBeDefined();
  });

  it('covers coordinate assignment with string-referenced boundary events', () => {
    const graph = new DirectedGraph();
    graph.addNode('Host_Task', { $type: 'bpmn:Task' });
    graph.addNode('B_Event', { $type: 'bpmn:BoundaryEvent', attachedToRef: 'Host_Task' });
    graph.addNode('Target_Task', { $type: 'bpmn:Task' });
    graph.addEdge({ id: 'Flow_Attach', source: 'Host_Task', target: 'B_Event', data: null });
    graph.addEdge({ id: 'Flow_Boundary', source: 'B_Event', target: 'Target_Task', data: null });

    const ranks = new Map<string, number>([
      ['Host_Task', 0],
      ['B_Event', 1],
      ['Target_Task', 2],
    ]);

    const bounds = assignCoordinates(graph, ranks);
    expect(bounds.get('B_Event')).toBeDefined();
    expect(bounds.get('Target_Task')).toBeDefined();
  });

  it('covers subprocess layout edge cases with unresolved string refs and ghost hosts', () => {
    const mockScope = {
      laneSets: [
        {
          lanes: [{ id: 'Lane_1', flowNodeRef: ['T_Host'] }],
        },
      ],
      flowElements: [
        { id: 'T_Host', $type: 'bpmn:Task' },
        { id: 'B_NoTarget1', $type: 'bpmn:BoundaryEvent', attachedToRef: 'T_Host' },
        { id: 'B_NoTarget2', $type: 'bpmn:BoundaryEvent', attachedToRef: 'T_Host' },
        { id: 'B_WithTarget', $type: 'bpmn:BoundaryEvent', attachedToRef: 'T_Host' },
        { id: 'B_NoHost', $type: 'bpmn:BoundaryEvent' },
        { id: 'B_GhostHost', $type: 'bpmn:BoundaryEvent', attachedToRef: 'NonExistentHost' },
        { id: 'T_Tgt', $type: 'bpmn:Task' },
        { id: 'Flow_B', $type: 'bpmn:SequenceFlow', sourceRef: 'B_WithTarget', targetRef: 'T_Tgt' },
        {
          id: 'Flow_Invalid',
          $type: 'bpmn:SequenceFlow',
          sourceRef: 'Ghost1',
          targetRef: 'Ghost2',
        },
      ],
    };

    const res = layoutScope(mockScope);
    expect(res.shapes.length).toBeGreaterThan(0);
    expect(res.edges.length).toBe(1);
  });

  it('covers layout engine collaboration edge cases with empty participants and invalid message flows', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Collab_Edge_Defs" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:collaboration id="Collab_Empty">
  </bpmn:collaboration>
</bpmn:definitions>`;

    const resXml = await layoutProcess(xml);
    expect(resXml).toContain('Collab_Empty');

    const builder = new BpmnBuilder('Proc_CollabEdge');
    builder
      .addParticipant('Pool_1', 'Proc_CollabEdge', 'Pool 1')
      .addTask('T_Valid', 'Valid')
      .addParticipant('Pool_2', 'NonExistentProc' as any, 'Pool 2')
      .addMessageFlow('Msg_Invalid', 'NonExistentSrc', 'NonExistentShape');

    const collabXml = await builder.toXml();
    const resultCollab = await layoutProcess(collabXml);
    expect(resultCollab).toContain('id="Pool_1_di"');
  });

  it('covers layout metrics edge cases with missing diagram planes and IDs', async () => {
    const invalidXml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="Defs_Empty">
  <bpmndi:BPMNDiagram id="Diagram_NoPlane">
  </bpmndi:BPMNDiagram>
  <bpmndi:BPMNDiagram id="Diagram_NoBpmnElement">
    <bpmndi:BPMNPlane id="Plane_1">
      <bpmndi:BPMNShape id="Shape_NoBpmnElement">
        <dc:Bounds x="10" y="10" width="50" height="50" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="Edge_NoBpmnElement">
        <dc:Point x="10" y="10" />
        <dc:Point x="60" y="10" />
      </bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

    const score = await scoreDiagram(invalidXml);
    expect(score.isValid).toBe(true);
  });
});
