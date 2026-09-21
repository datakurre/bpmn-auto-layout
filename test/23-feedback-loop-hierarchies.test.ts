import { describe, it, expect } from 'vitest';
import { BpmnBuilder } from '../src/bpmn-builder';
import { layoutProcess } from '../src/index';
import { scoreDiagram } from '../src/layout-metrics';
import { expectSnapshotMatch } from './helpers/snapshot-helper';
import { DirectedGraph } from '../src/graph/graph';
import {
  alignReturnPathLayers,
  canReachEndEvent,
  detectReturnPathElements,
  isReturnGateway,
  isReturnNode,
} from '../src/graph/return-path-layout';
import { routeOrthogonalEdge } from '../src/graph/orthogonal-router';
import { routeGatewayIncomingEdges, routeGatewayOutgoingEdges } from '../src/graph/gateway-router';
import { routeBoundaryExit } from '../src/hierarchy/boundary-events';
import { assignMergeIncomingPorts, routeScopeEdges } from '../src/hierarchy/subprocess-layout';
import { extractExistingParticipantY, orderCollaborationParticipants } from '../src/layout-engine';
import { assignCoordinates } from '../src/graph/coordinate-assignment';
import { BpmnModdle } from 'bpmn-moddle';

describe('Iteration 23: Feedback Loop Hierarchies & Return-Path Flow Alignment', () => {
  it('layouts multi-lane approval workflow with rejection and boundary retraction events', async () => {
    const builder = new BpmnBuilder('Process_Approval');
    builder
      .addParticipant('Pool_Approval', 'Process_Approval', 'Publication Approval Process')
      // Lane Author elements
      .addStartEvent('Start_Draft', 'Start Draft')
      .addExclusiveGateway('Gateway_MergeDraft', 'Merge Revisions')
      .addTask('Task_CreateDraft', 'Create Content')
      .addIntermediateThrowEvent('Event_Submit', 'Submit for Review', 'bpmn:MessageEventDefinition')
      // Lane Editor elements
      .addTask('Task_Review', 'Review Content')
      .addBoundaryEvent('Boundary_Retract', 'Task_Review', 'Retract Request')
      .addExclusiveGateway('Gateway_Decision', 'Approved?')
      .addEndEvent('End_Published', 'Published')
      // Return path elements
      .addIntermediateThrowEvent('Event_Reject', 'Reject', 'bpmn:MessageEventDefinition')
      .addExclusiveGateway('Gateway_ReturnJoin', 'Join Return Flows')
      // Lanes
      .addLane(
        'Lane_Author',
        ['Start_Draft', 'Gateway_MergeDraft', 'Task_CreateDraft', 'Event_Submit'],
        'Author'
      )
      .addLane(
        'Lane_Editor',
        [
          'Task_Review',
          'Boundary_Retract',
          'Gateway_Decision',
          'End_Published',
          'Event_Reject',
          'Gateway_ReturnJoin',
        ],
        'Editor'
      )
      // Forward flows
      .addSequenceFlow('Flow_Start', 'Start_Draft', 'Gateway_MergeDraft')
      .addSequenceFlow('Flow_Merged', 'Gateway_MergeDraft', 'Task_CreateDraft')
      .addSequenceFlow('Flow_DraftToSubmit', 'Task_CreateDraft', 'Event_Submit')
      .addSequenceFlow('Flow_SubmitToReview', 'Event_Submit', 'Task_Review')
      .addSequenceFlow('Flow_ReviewToDecide', 'Task_Review', 'Gateway_Decision')
      .addSequenceFlow({
        id: 'Flow_Approved',
        sourceRef: 'Gateway_Decision',
        targetRef: 'End_Published',
        name: 'Yes',
      })
      // Return flows
      .addSequenceFlow({
        id: 'Flow_Rejected',
        sourceRef: 'Gateway_Decision',
        targetRef: 'Event_Reject',
        name: 'No',
      })
      .addSequenceFlow('Flow_RejectToJoin', 'Event_Reject', 'Gateway_ReturnJoin')
      .addSequenceFlow('Flow_RetractToJoin', 'Boundary_Retract', 'Gateway_ReturnJoin')
      .addSequenceFlow('Flow_ReturnToMerge', 'Gateway_ReturnJoin', 'Gateway_MergeDraft');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);

    const moddle = new BpmnModdle();
    const { rootElement } = await moddle.fromXML(resultXml);
    const plane = (rootElement as any).diagrams[0].plane;
    const findShape = (id: string) =>
      plane.planeElement.find((pe: any) => pe.bpmnElement?.id === id);
    const findEdge = (id: string) =>
      plane.planeElement.find((pe: any) => pe.bpmnElement?.id === id);

    const mergeShape = findShape('Gateway_MergeDraft');
    const returnJoinShape = findShape('Gateway_ReturnJoin');
    expect(mergeShape).toBeDefined();
    expect(returnJoinShape).toBeDefined();

    // The return join gateway should be aligned vertically with the draft merge gateway
    const mergeCenterX = mergeShape.bounds.x + mergeShape.bounds.width / 2;
    const returnJoinCenterX = returnJoinShape.bounds.x + returnJoinShape.bounds.width / 2;
    expect(Math.abs(mergeCenterX - returnJoinCenterX)).toBeLessThanOrEqual(20);

    // The cross-lane return flow should be straight vertical (2 waypoints, 0 bends)
    const returnEdge = findEdge('Flow_ReturnToMerge');
    expect(returnEdge).toBeDefined();
    expect(returnEdge.waypoint).toHaveLength(2);
    expect(returnEdge.waypoint[0].x).toBe(returnEdge.waypoint[1].x);

    // "No" flow from Approved? should go downwards first, then left
    const rejectedEdge = findEdge('Flow_Rejected');
    expect(rejectedEdge).toBeDefined();
    expect(rejectedEdge.waypoint).toHaveLength(3);
    expect(rejectedEdge.waypoint[0].x).toBe(rejectedEdge.waypoint[1].x);
    expect(rejectedEdge.waypoint[0].y).toBeLessThan(rejectedEdge.waypoint[1].y);
    expect(rejectedEdge.waypoint[1].y).toBe(rejectedEdge.waypoint[2].y);
    expect(rejectedEdge.waypoint[2].x).toBeLessThan(rejectedEdge.waypoint[1].x);

    // Reject intermediate event has incoming on right, outgoing on left entering Join Return Flows from bottom
    const rejectToJoinEdge = findEdge('Flow_RejectToJoin');
    expect(rejectToJoinEdge).toBeDefined();
    expect(rejectToJoinEdge.waypoint).toHaveLength(3);
    expect(rejectToJoinEdge.waypoint[0].y).toBe(rejectToJoinEdge.waypoint[1].y);
    expect(rejectToJoinEdge.waypoint[1].x).toBe(rejectToJoinEdge.waypoint[2].x);
    expect(rejectToJoinEdge.waypoint[2].y).toBeLessThan(rejectToJoinEdge.waypoint[1].y);

    // Retract Request boundary flow turns toward Join Return Flows before Approved exit, entering east dock
    const retractToJoinEdge = findEdge('Flow_RetractToJoin');
    expect(retractToJoinEdge).toBeDefined();
    expect(retractToJoinEdge.waypoint).toHaveLength(3);
    expect(retractToJoinEdge.waypoint[0].x).toBe(retractToJoinEdge.waypoint[1].x);
    expect(retractToJoinEdge.waypoint[1].y).toBe(retractToJoinEdge.waypoint[2].y);
    expect(retractToJoinEdge.waypoint[0].x).toBeLessThan(rejectedEdge.waypoint[0].x);

    // Approved? decision gateway label should be on top
    const decisionShape = findShape('Gateway_Decision');
    expect(decisionShape.label.bounds.y).toBeLessThan(decisionShape.bounds.y);

    expectSnapshotMatch(resultXml, '23-multi-lane-approval-workflow');
  });

  it('layouts same-lane rework loop with return gateway', async () => {
    const builder = new BpmnBuilder('Process_Rework');
    builder
      .addStartEvent('Start_1', 'Start')
      .addExclusiveGateway('GW_Merge', 'Merge')
      .addTask('Task_Work', 'Perform Work')
      .addExclusiveGateway('GW_Eval', 'Evaluate')
      .addExclusiveGateway('GW_Return', 'Return Gateway')
      .addEndEvent('End_1', 'Done')
      .addSequenceFlow('F_Start', 'Start_1', 'GW_Merge')
      .addSequenceFlow('F_ToWork', 'GW_Merge', 'Task_Work')
      .addSequenceFlow('F_ToEval', 'Task_Work', 'GW_Eval')
      .addSequenceFlow('F_Done', 'GW_Eval', 'End_1')
      .addSequenceFlow('F_Rework', 'GW_Eval', 'GW_Return')
      .addSequenceFlow('F_LoopBack', 'GW_Return', 'GW_Merge');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
  });

  it('preserves collaboration participant ordering from input DI bounds.y', async () => {
    const inputXmlWithDi = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
                  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
                  id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:collaboration id="Collab_1">
    <bpmn:participant id="Pool_Main" processRef="Process_Main" name="Main Process" />
    <bpmn:participant id="Pool_CMS" name="External CMS" />
  </bpmn:collaboration>
  <bpmn:process id="Process_Main" isExecutable="false">
    <bpmn:startEvent id="Start_1" />
    <bpmn:endEvent id="End_1" />
    <bpmn:sequenceFlow id="Flow_1" sourceRef="Start_1" targetRef="End_1" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Collab_1">
      <bpmndi:BPMNShape id="Pool_CMS_di" bpmnElement="Pool_CMS">
        <dc:Bounds x="100" y="80" width="600" height="60" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Pool_Main_di" bpmnElement="Pool_Main">
        <dc:Bounds x="100" y="220" width="600" height="200" />
      </bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

    const resultXml = await layoutProcess(inputXmlWithDi);

    const moddle = new BpmnModdle();
    const { rootElement } = await moddle.fromXML(resultXml);
    const plane = (rootElement as any).diagrams[0].plane;
    const cmsShape = plane.planeElement.find((pe: any) => pe.bpmnElement?.id === 'Pool_CMS');
    const mainShape = plane.planeElement.find((pe: any) => pe.bpmnElement?.id === 'Pool_Main');
    expect(cmsShape).toBeDefined();
    expect(mainShape).toBeDefined();
    expect(cmsShape.bounds.y).toBeLessThan(mainShape.bounds.y);
    expect(cmsShape.bounds.height).toBe(60);
  });

  it('exercises orderCollaborationParticipants edge cases', () => {
    expect(orderCollaborationParticipants(undefined as any)).toEqual([]);
    expect(orderCollaborationParticipants([])).toEqual([]);
    const single = [{ id: 'P1' }];
    expect(orderCollaborationParticipants(single)).toBe(single);

    const parts = [{ id: 'P1' }, { id: 'P2' }];
    expect(orderCollaborationParticipants(parts, new Map())).toBe(parts);

    // existingY exists but none match
    expect(orderCollaborationParticipants(parts, new Map([['Unknown', 50]]))).toBe(parts);

    const existingY = new Map<string, number>([
      ['P2', 100],
      ['P1', 200],
    ]);
    const sorted = orderCollaborationParticipants(parts, existingY);
    expect(sorted[0].id).toBe('P2');
    expect(sorted[1].id).toBe('P1');

    // Partial Y coverage
    const parts3 = [{ id: 'P1' }, { id: 'P2' }, { id: 'P3' }];
    const partialY = new Map<string, number>([['P2', 50]]);
    const sortedPartial = orderCollaborationParticipants(parts3, partialY);
    expect(sortedPartial[0].id).toBe('P2');

    const partialY2 = new Map<string, number>([['P3', 50]]);
    const sortedPartial2 = orderCollaborationParticipants(parts3, partialY2);
    expect(sortedPartial2[0].id).toBe('P3');

    // Neither in existingY returns 0 in sort comparison
    const parts4 = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
    const partialY3 = new Map<string, number>([['A', 100]]);
    const sortedPartial3 = orderCollaborationParticipants(parts4, partialY3);
    expect(sortedPartial3).toHaveLength(3);
  });

  it('exercises return-path graph analysis functions directly', () => {
    const graph = new DirectedGraph();
    graph.addNode('Start', { $type: 'bpmn:StartEvent' });
    graph.addNode('MergeGW', { $type: 'bpmn:ExclusiveGateway' });
    graph.addNode('TaskA', { $type: 'bpmn:Task' });
    graph.addNode('SplitGW', { $type: 'bpmn:ExclusiveGateway' });
    graph.addNode('End', { $type: 'bpmn:EndEvent' });
    graph.addNode('ReturnGW', { $type: 'bpmn:ExclusiveGateway' });
    graph.addNode('ReturnEvent', { $type: 'bpmn:IntermediateThrowEvent' });
    graph.addNode('NoInEvent', { $type: 'bpmn:IntermediateThrowEvent' });

    graph.addEdge({ id: 'e1', source: 'Start', target: 'MergeGW', data: {} });
    graph.addEdge({ id: 'e2', source: 'MergeGW', target: 'TaskA', data: {} });
    graph.addEdge({ id: 'e3', source: 'TaskA', target: 'SplitGW', data: {} });
    graph.addEdge({ id: 'e4', source: 'SplitGW', target: 'End', data: {} });
    graph.addEdge({ id: 'e5', source: 'SplitGW', target: 'ReturnEvent', data: {} });
    graph.addEdge({ id: 'e6', source: 'ReturnEvent', target: 'ReturnGW', data: {} });
    graph.addEdge({ id: 'e7', source: 'ReturnGW', target: 'MergeGW', data: {} });
    graph.addEdge({ id: 'e8', source: 'NoInEvent', target: 'ReturnGW', data: {} });

    const feedback = new Set<string>(['e7']);

    expect(canReachEndEvent('Start', graph, feedback)).toBe(true);
    expect(canReachEndEvent('ReturnGW', graph, feedback)).toBe(false);

    const analysis = detectReturnPathElements(graph, feedback);
    expect(analysis.returnGateways.get('ReturnGW')).toBe('MergeGW');
    expect(analysis.returnNodes.has('ReturnEvent')).toBe(true);

    const ranks = new Map<string, number>([
      ['Start', 0],
      ['MergeGW', 1],
      ['TaskA', 2],
      ['SplitGW', 3],
      ['End', 4],
      ['ReturnEvent', 5],
      ['ReturnGW', 6],
    ]);
    const nodeToLane = new Map<string, number>([
      ['Start', 0],
      ['MergeGW', 0],
      ['TaskA', 0],
      ['SplitGW', 1],
      ['End', 1],
      ['ReturnEvent', 1],
      ['ReturnGW', 1],
    ]);

    alignReturnPathLayers(graph, ranks, { feedbackEdges: feedback, nodeToLane });
    expect(ranks.get('ReturnGW')).toBe(1);

    // Test same lane gateway alignment and missing ranks
    const ranks2 = new Map<string, number>([
      ['GW1', 5],
      ['GW2', 5],
      ['SameLaneTarget', 2],
    ]);
    const lanes2 = new Map<string, number>([
      ['GW2', 0],
      ['SameLaneTarget', 0],
    ]);
    alignReturnPathLayers(graph, ranks2, { feedbackEdges: feedback, nodeToLane: lanes2 });

    // Test findAvailableReturnRank fallback when no candidates
    const graphTight = new DirectedGraph();
    graphTight.addNode('M', { $type: 'bpmn:ExclusiveGateway' });
    graphTight.addNode('R', { $type: 'bpmn:IntermediateThrowEvent' });
    graphTight.addNode('G', { $type: 'bpmn:ExclusiveGateway' });
    graphTight.addEdge({ id: 'f1', source: 'M', target: 'R', data: {} });
    graphTight.addEdge({ id: 'f2', source: 'R', target: 'G', data: {} });
    graphTight.addEdge({ id: 'f3', source: 'G', target: 'M', data: {} });
    const ranksTight = new Map<string, number>([
      ['M', 1],
      ['R', 2],
      ['G', 2],
    ]);
    const feedbackTight = new Set<string>(['f3']);
    alignReturnPathLayers(graphTight, ranksTight, { feedbackEdges: feedbackTight });

    // Test intermediate node without inEdges or without source rank
    const graphOrphan = new DirectedGraph();
    graphOrphan.addNode('O_M', { $type: 'bpmn:ExclusiveGateway' });
    graphOrphan.addNode('O_R', { $type: 'bpmn:IntermediateThrowEvent' });
    graphOrphan.addNode('O_G', { $type: 'bpmn:ExclusiveGateway' });
    graphOrphan.addEdge({ id: 'o2', source: 'O_R', target: 'O_G', data: {} });
    graphOrphan.addEdge({ id: 'o3', source: 'O_G', target: 'O_M', data: {} });
    const ranksOrphan = new Map<string, number>([
      ['O_M', 1],
      ['O_G', 2],
    ]);
    alignReturnPathLayers(graphOrphan, ranksOrphan, { feedbackEdges: new Set<string>(['o3']) });
  });

  it('handles empty return gateways in alignReturnPathLayers', () => {
    const graph = new DirectedGraph();
    graph.addNode('A', { $type: 'bpmn:Task' });
    const ranks = new Map<string, number>([['A', 0]]);
    const feedback = new Set<string>();
    const analysis = alignReturnPathLayers(graph, ranks, { feedbackEdges: feedback });
    expect(analysis.returnGateways.size).toBe(0);
  });

  it('routes vertical collinear edges upward and downward cleanly', () => {
    // Upward collinear without obstacles passed (hitting obstacles === undefined)
    const srcLower = { x: 200, y: 500, width: 50, height: 50 };
    const tgtUpper = { x: 200, y: 200, width: 50, height: 50 };
    const waypointsUp = routeOrthogonalEdge(srcLower, tgtUpper);
    expect(waypointsUp).toHaveLength(2);
    expect(waypointsUp[0]).toEqual({ x: 225, y: 500 });
    expect(waypointsUp[1]).toEqual({ x: 225, y: 250 });

    // Upward collinear with offset
    const srcOffset = { x: 205, y: 500, width: 50, height: 50 };
    const waypointsUpOffset = routeOrthogonalEdge(srcOffset, tgtUpper, []);
    expect(waypointsUpOffset).toHaveLength(4);

    // Downward collinear
    const srcUpper = { x: 200, y: 100, width: 50, height: 50 };
    const tgtLower = { x: 200, y: 400, width: 50, height: 50 };
    const waypointsDown = routeOrthogonalEdge(srcUpper, tgtLower, []);
    expect(waypointsDown).toHaveLength(2);
    expect(waypointsDown[0]).toEqual({ x: 225, y: 150 });
    expect(waypointsDown[1]).toEqual({ x: 225, y: 400 });

    // Downward collinear with offset
    const srcUpperOffset = { x: 205, y: 100, width: 50, height: 50 };
    const waypointsDownOffset = routeOrthogonalEdge(srcUpperOffset, tgtLower, []);
    expect(waypointsDownOffset).toHaveLength(4);

    // Blocked vertical collinear drops to standard routing
    const obstacle = { x: 180, y: 280, width: 100, height: 50 };
    const waypointsBlocked = routeOrthogonalEdge(srcUpper, tgtLower, [
      srcUpper,
      tgtLower,
      obstacle,
    ]);
    expect(waypointsBlocked.length).toBeGreaterThan(2);

    // Blocked upward vertical collinear drops to standard routing
    const obstacleUp = { x: 180, y: 350, width: 100, height: 50 };
    const waypointsUpBlocked = routeOrthogonalEdge(srcLower, tgtUpper, [
      srcLower,
      tgtUpper,
      obstacleUp,
    ]);
    expect(waypointsUpBlocked.length).toBeGreaterThan(2);
  });

  it('routes backward boundary exit directly to target east port when clear and falls back when not behind', () => {
    const srcBoundary = { x: 400, y: 100, width: 36, height: 36 };
    const tgtWest = { x: 200, y: 200, width: 50, height: 50 };
    const route = routeBoundaryExit(srcBoundary, tgtWest, []);
    expect(route).toHaveLength(3);
    // Directly enters east port of tgtWest
    expect(route[2]).toEqual({ x: 250, y: 225 });

    // Target not fully behind source and not vertically collinear
    const tgtOverlapX = { x: 250, y: 200, width: 200, height: 50 };
    const routeOverlap = routeBoundaryExit(srcBoundary, tgtOverlapX, []);
    expect(routeOverlap.length).toBeGreaterThanOrEqual(4);
  });

  it('exercises extractExistingParticipantY and diamond visited queue branches', () => {
    expect(extractExistingParticipantY(undefined)).toEqual(new Map());
    expect(extractExistingParticipantY({})).toEqual(new Map());

    const plane = {
      planeElement: [
        { bpmnElement: 'StrId', bounds: { y: 50 } },
        { bpmnElement: { id: 'ObjId' }, bounds: { y: 100 } },
        { bpmnElement: { id: 'NoY' }, bounds: {} },
        { bpmnElement: null, bounds: { y: 150 } },
      ],
    };
    const extracted = extractExistingParticipantY(plane);
    expect(extracted.get('StrId')).toBe(50);
    expect(extracted.get('ObjId')).toBe(100);
    expect(extracted.has('NoY')).toBe(false);

    // Diamond graph to hit visited.has(curr) continue
    const graphDiamond = new DirectedGraph();
    graphDiamond.addNode('D_Start', { $type: 'bpmn:StartEvent' });
    graphDiamond.addNode('D_B', { $type: 'bpmn:Task' });
    graphDiamond.addNode('D_C', { $type: 'bpmn:Task' });
    graphDiamond.addNode('D_Merge', { $type: 'bpmn:Task' });
    graphDiamond.addEdge({ id: 'd1', source: 'D_Start', target: 'D_B', data: {} });
    graphDiamond.addEdge({ id: 'd2', source: 'D_Start', target: 'D_C', data: {} });
    graphDiamond.addEdge({ id: 'd3', source: 'D_B', target: 'D_Merge', data: {} });
    graphDiamond.addEdge({ id: 'd4', source: 'D_C', target: 'D_Merge', data: {} });
    expect(canReachEndEvent('D_Start', graphDiamond, new Set())).toBe(false);

    // Missing target rank branch in alignReturnGatewayRanks
    const graphMissing = new DirectedGraph();
    graphMissing.addNode('GW_Miss', { $type: 'bpmn:ExclusiveGateway' });
    graphMissing.addNode('Target_NoRank', { $type: 'bpmn:Task' });
    graphMissing.addEdge({ id: 'f_miss', source: 'GW_Miss', target: 'Target_NoRank', data: {} });
    const ranksMiss = new Map<string, number>([['GW_Miss', 5]]);
    alignReturnPathLayers(graphMissing, ranksMiss, { feedbackEdges: new Set(['f_miss']) });

    // Missing source rank branch in alignIntermediateReturnNodeRanks
    const graphSourceMiss = new DirectedGraph();
    graphSourceMiss.addNode('GW_Ret', { $type: 'bpmn:ExclusiveGateway' });
    graphSourceMiss.addNode('Ret_Node', { $type: 'bpmn:IntermediateThrowEvent' });
    graphSourceMiss.addNode('Split_NoRank', { $type: 'bpmn:ExclusiveGateway' });
    graphSourceMiss.addNode('Tgt', { $type: 'bpmn:Task' });
    graphSourceMiss.addEdge({ id: 'sm1', source: 'Split_NoRank', target: 'Ret_Node', data: {} });
    graphSourceMiss.addEdge({ id: 'sm2', source: 'Ret_Node', target: 'GW_Ret', data: {} });
    graphSourceMiss.addEdge({ id: 'sm3', source: 'GW_Ret', target: 'Tgt', data: {} });
    const ranksSourceMiss = new Map<string, number>([
      ['GW_Ret', 5],
      ['Ret_Node', 4],
    ]);
    alignReturnPathLayers(graphSourceMiss, ranksSourceMiss, { feedbackEdges: new Set(['sm3']) });

    // Missing target rank branch (?? 0) in alignIntermediateReturnNodeRanks
    const graphMissingTargetRank = new DirectedGraph();
    graphMissingTargetRank.addNode('GW_RetTgt', { $type: 'bpmn:ExclusiveGateway' });
    graphMissingTargetRank.addNode('Ret_NodeTgt', { $type: 'bpmn:IntermediateThrowEvent' });
    graphMissingTargetRank.addNode('Split_HasRank', { $type: 'bpmn:ExclusiveGateway' });
    graphMissingTargetRank.addNode('SomeLoopTarget', { $type: 'bpmn:Task' });
    graphMissingTargetRank.addEdge({
      id: 'st1',
      source: 'Split_HasRank',
      target: 'Ret_NodeTgt',
      data: {},
    });
    graphMissingTargetRank.addEdge({
      id: 'st2',
      source: 'Ret_NodeTgt',
      target: 'GW_RetTgt',
      data: {},
    });
    graphMissingTargetRank.addEdge({
      id: 'st3',
      source: 'GW_RetTgt',
      target: 'SomeLoopTarget',
      data: {},
    });
    const ranksMissingTgt = new Map<string, number>([
      ['Split_HasRank', 5],
      ['SomeLoopTarget', 1],
    ]);
    alignReturnPathLayers(graphMissingTargetRank, ranksMissingTgt, {
      feedbackEdges: new Set(['st3']),
    });
  });

  it('handles return path edge routing edge cases and helpers', () => {
    // isReturnNode and isReturnGateway
    expect(isReturnNode('node1', new Set(['node1']))).toBe(true);
    expect(isReturnNode('node2', new Set(['node1']))).toBe(false);
    expect(isReturnNode('node3', undefined)).toBe(false);
    expect(isReturnGateway('gw1', new Map([['gw1', 'tgt']]))).toBe(true);
    expect(isReturnGateway('gw2', new Map([['gw1', 'tgt']]))).toBe(false);
    expect(isReturnGateway('gw3', undefined)).toBe(false);

    // Non-collinear return path gateway incoming edge
    const nonCollinearIn = routeGatewayIncomingEdges(
      [
        {
          flow: { id: 'F_ReturnIn' },
          sourceBounds: { x: 300, y: 150, width: 50, height: 50 },
          targetPort: 'right',
        },
      ],
      {
        gatewayBounds: { x: 100, y: 100, width: 50, height: 50 },
      }
    );
    expect(nonCollinearIn.routes.get('F_ReturnIn')).toHaveLength(4);

    // Outgoing return path edge where target is above gateway
    const aboveRoutes = routeGatewayOutgoingEdges(
      [
        {
          flow: { id: 'F_Above' },
          targetBounds: { x: 100, y: 50, width: 50, height: 50 },
          isReturnPathTarget: true,
        },
      ],
      {
        gatewayBounds: { x: 300, y: 200, width: 50, height: 50 },
        usedPorts: new Set(),
      }
    );
    expect(aboveRoutes.get('F_Above')).toBeDefined();
    expect(aboveRoutes.get('F_Above')![0].y).toBe(200);

    // routeScopeEdges intermediate return flows (both collinear and non-collinear)
    const intermediateEdges = routeScopeEdges(
      [
        { id: 'f_other1', sourceRef: 'ret1', targetRef: 'ret2' },
        { id: 'f_other2', sourceRef: 'ret2', targetRef: 'ret3' },
      ],
      {
        regularNodes: [
          { id: 'ret1', $type: 'bpmn:Task' },
          { id: 'ret2', $type: 'bpmn:Task' },
          { id: 'ret3', $type: 'bpmn:Task' },
        ],
        boundaryEvents: [],
        boundsMap: new Map([
          ['ret1', { x: 400, y: 100, width: 100, height: 80 }],
          ['ret2', { x: 250, y: 100, width: 100, height: 80 }],
          ['ret3', { x: 100, y: 220, width: 100, height: 80 }],
        ]),
        returnNodes: new Set(['ret1', 'ret2']),
      }
    );
    expect(intermediateEdges).toHaveLength(2);
    expect(intermediateEdges[0].waypoints).toHaveLength(2);
    expect(intermediateEdges[1].waypoints).toHaveLength(4);

    // Return node without outgoing edge in alignReturnPathLayers
    const graphNoOut = new DirectedGraph();
    graphNoOut.addNode('GW_End', { $type: 'bpmn:ExclusiveGateway' });
    graphNoOut.addNode('Ret_NoOut', { $type: 'bpmn:IntermediateThrowEvent' });
    graphNoOut.addNode('Split_1', { $type: 'bpmn:ExclusiveGateway' });
    graphNoOut.addNode('Tgt_1', { $type: 'bpmn:Task' });
    graphNoOut.addEdge({ id: 'no1', source: 'Split_1', target: 'Ret_NoOut', data: {} });
    graphNoOut.addEdge({ id: 'no2', source: 'GW_End', target: 'Tgt_1', data: {} });
    const ranksNoOut = new Map<string, number>([
      ['Split_1', 4],
      ['GW_End', 5],
      ['Tgt_1', 1],
    ]);
    alignReturnPathLayers(graphNoOut, ranksNoOut, { feedbackEdges: new Set(['no2']) });

    // assignMergeIncomingPorts return gateway right port branch
    const gwBounds = { x: 100, y: 100, width: 50, height: 50 };
    const portsRetGw = assignMergeIncomingPorts(
      [
        {
          flow: { id: 'f_right' },
          sourceBounds: { x: 200, y: 100, width: 50, height: 50 },
          isReturnGateway: true,
        },
        {
          flow: { id: 'f_left_ret' },
          sourceBounds: { x: 120, y: 100, width: 50, height: 50 },
          isReturnGateway: true,
        },
      ],
      gwBounds
    );
    expect(portsRetGw.get('f_right')).toBe('right');
    expect(portsRetGw.get('f_left_ret')).toBe('left');

    // Collinear return flow entry into gateway east dock
    const collinearEntry = routeGatewayIncomingEdges(
      [
        {
          flow: { id: 'f_collinear' },
          sourceBounds: { x: 300, y: 100, width: 50, height: 50 },
          isReturnSource: true,
        },
      ],
      {
        gatewayBounds: { x: 100, y: 100, width: 50, height: 50 },
      }
    );
    expect(collinearEntry.routes.get('f_collinear')).toEqual([
      { x: 300, y: 125 },
      { x: 150, y: 125 },
    ]);
    expect(collinearEntry.usedPorts.has('right')).toBe(true);

    // Return node without outgoing edges gets track 1
    const graphNoOutEdge = new DirectedGraph();
    graphNoOutEdge.addNode('Ret_Isolated', { $type: 'bpmn:IntermediateThrowEvent' });
    graphNoOutEdge.addNode('GW_Pred', { $type: 'bpmn:ExclusiveGateway' });
    graphNoOutEdge.addEdge({ id: 'f_fb', source: 'GW_Pred', target: 'Ret_Isolated', data: {} });
    const coords = assignCoordinates(
      graphNoOutEdge,
      new Map([
        ['GW_Pred', 2],
        ['Ret_Isolated', 1],
      ]),
      { feedbackEdges: new Set(['f_fb']) }
    );
    expect(coords.get('Ret_Isolated')?.y).toBeGreaterThan(coords.get('GW_Pred')?.y ?? 0);
  });
});
