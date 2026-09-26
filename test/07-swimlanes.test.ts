import { describe, it, expect } from 'vitest';
import { BpmnModdle } from 'bpmn-moddle';
import { BpmnBuilder } from '../src/bpmn-builder';
import { layoutProcess } from '../src/index';
import { scoreDiagram } from '../src/layout-metrics';
import {
  routeMessageFlow,
  layoutProcessLanes,
  isMessageCorridorBlocked,
} from '../src/hierarchy/swimlane-layout';
import {
  findEnclosingPool,
  computeInterPoolChannelY,
  getEffectiveApproachX,
  computeTargetPortX,
  computeScopeContentYExtents,
  layoutPoolConnectionPorts,
  collectPoolPortEntries,
  resolveAllPoolPorts,
} from '../src/layout-engine';
import { expectImageSnapshotMatch } from './helpers/snapshot-helper';

describe('Iteration 7: Swimlanes (Pools & Lanes)', () => {
  it('layouts a 2-lane pool with cross-lane sequence flows', async () => {
    const builder = new BpmnBuilder('Process_Order');
    builder
      .addParticipant('Pool_Order', 'Process_Order', 'Order Department')
      .addStartEvent('Start_1', 'Order Needed')
      .addTask('Task_Submit', 'Submit Order')
      .addTask('Task_Approve', 'Approve Order')
      .addEndEvent('End_1', 'Order Completed')
      .addLane('Lane_Buyer', ['Start_1', 'Task_Submit', 'End_1'], 'Buyer Lane')
      .addLane('Lane_Approver', ['Task_Approve'], 'Approver Lane')
      .addSequenceFlow('Flow_1', 'Start_1', 'Task_Submit')
      .addSequenceFlow('Flow_Cross_1', 'Task_Submit', 'Task_Approve')
      .addSequenceFlow('Flow_Cross_2', 'Task_Approve', 'End_1');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('id="Lane_Buyer_di"');
    expect(resultXml).toContain('id="Lane_Approver_di"');
    expect(resultXml).toContain('id="Pool_Order_di"');

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);

    expectImageSnapshotMatch(resultXml, '07-two-lanes-pool');
  });

  it('layouts a same-lane 3-way split whose first branch gets a negative local track', async () => {
    // Within a single lane, calculateSingleParentTrack centers a 3-way split
    // on its parent's track (offsets -1, 0, +1), so the first branch's local
    // track goes negative before normalizeLaneTracks shifts the whole lane
    // back to a non-negative baseline.
    const builder = new BpmnBuilder('Proc_Triage');
    builder
      .addParticipant('Pool_Triage', 'Proc_Triage', 'Triage')
      .addStartEvent('Start_1', 'Start')
      .addExclusiveGateway('Split_1', 'Split')
      .addTask('Task_A', 'Branch A')
      .addTask('Task_B', 'Branch B')
      .addTask('Task_C', 'Branch C')
      .addExclusiveGateway('Join_1', 'Join')
      .addEndEvent('End_1', 'End')
      .addLane(
        'Lane_1',
        ['Start_1', 'Split_1', 'Task_A', 'Task_B', 'Task_C', 'Join_1', 'End_1'],
        'Lane 1'
      )
      .addSequenceFlow('Flow_1', 'Start_1', 'Split_1')
      .addSequenceFlow('Flow_2', 'Split_1', 'Task_A')
      .addSequenceFlow('Flow_3', 'Split_1', 'Task_B')
      .addSequenceFlow('Flow_4', 'Split_1', 'Task_C')
      .addSequenceFlow('Flow_5', 'Task_A', 'Join_1')
      .addSequenceFlow('Flow_6', 'Task_B', 'Join_1')
      .addSequenceFlow('Flow_7', 'Task_C', 'Join_1')
      .addSequenceFlow('Flow_8', 'Join_1', 'End_1');

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
      plane.planeElement.find((el: any) => el.bpmnElement?.id === id);

    // All shapes must land within the lane's bounds, confirming the
    // negative local track was normalized rather than escaping upward.
    const laneShape = findShape('Lane_1');
    for (const id of ['Task_A', 'Task_B', 'Task_C']) {
      const bounds = findShape(id).bounds;
      expect(bounds.y).toBeGreaterThanOrEqual(laneShape.bounds.y);
    }
  });

  it('layouts collaboration with multiple pools and inter-pool message flows', async () => {
    const builder = new BpmnBuilder('Proc_Customer');
    builder
      .addParticipant('Pool_Customer', 'Proc_Customer', 'Customer')
      .addStartEvent('Cust_Start', 'Browse')
      .addTask('Cust_Order', 'Place Order')
      .addEndEvent('Cust_End', 'Receive Goods')
      .addSequenceFlow('Cust_F1', 'Cust_Start', 'Cust_Order')
      .addSequenceFlow('Cust_F2', 'Cust_Order', 'Cust_End');

    // Add second pool with its own process and task
    builder
      .addProcess('Proc_Merchant', 'Merchant Process')
      .addParticipant('Pool_Merchant', 'Proc_Merchant', 'Merchant')
      .addTask('Merch_Process', 'Fulfill Order')
      .addMessageFlow('Msg_Order', 'Cust_Order', 'Merch_Process');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('id="Pool_Customer_di"');
    expect(resultXml).toContain('id="Pool_Merchant_di"');
    expect(resultXml).toContain('id="Msg_Order_di"');

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);

    expectImageSnapshotMatch(resultXml, '07-collaboration-message-flows');
  });

  it('routes message flow around intermediate obstacle when source is above target', () => {
    const src = { x: 100, y: 100, width: 100, height: 80 };
    const tgt = { x: 300, y: 500, width: 100, height: 80 };
    const obstacle = { x: 100, y: 200, width: 100, height: 80 };
    const waypoints = routeMessageFlow(src, tgt, [src, tgt, obstacle]);
    expect(waypoints).toHaveLength(5);
    expect(waypoints[0]).toEqual({ x: 200, y: 140 });
    expect(waypoints[1].x).toBe(220);

    const defaultWaypoints = routeMessageFlow(src, tgt);
    expect(defaultWaypoints).toHaveLength(4);
  });

  it('detects enclosing pools and calculates inter-pool channels', () => {
    const poolA = { x: 100, y: 80, width: 500, height: 200 };
    const poolB = { x: 100, y: 340, width: 500, height: 200 };
    const nodeA = { x: 200, y: 100, width: 100, height: 80 };
    const nodeB = { x: 200, y: 360, width: 100, height: 80 };
    const orphan = { x: 9999, y: 9999, width: 100, height: 80 };

    expect(findEnclosingPool(poolA, [poolA, poolB])).toBe(poolA);
    expect(findEnclosingPool(nodeA, [poolA, poolB])).toBe(poolA);
    expect(findEnclosingPool(orphan, [poolA, poolB])).toBeUndefined();

    // Valid inter-pool channels in both directions
    expect(computeInterPoolChannelY(nodeA, nodeB, [poolA, poolB])).toBe(310);
    expect(computeInterPoolChannelY(nodeB, nodeA, [poolA, poolB])).toBe(310);

    // Undefined when orphan or same pool
    expect(computeInterPoolChannelY(orphan, nodeB, [poolA, poolB])).toBeUndefined();
    expect(computeInterPoolChannelY(nodeA, orphan, [poolA, poolB])).toBeUndefined();
    expect(computeInterPoolChannelY(nodeA, poolA, [poolA, poolB])).toBeUndefined();
  });

  it('determines effective approach X and target ports for message flows', () => {
    const target = { x: 400, y: 100, width: 100, height: 80 };
    const obstacle = { x: 400, y: 250, width: 100, height: 80 };
    const sourceBlockedDown = { x: 400, y: 50, width: 100, height: 80 };
    const sourceClearDown = { x: 600, y: 50, width: 100, height: 80 };
    const sourceBlockedUp = { x: 400, y: 400, width: 100, height: 80 };
    const sourceClearUp = { x: 600, y: 400, width: 100, height: 80 };

    const approachCtx = {
      targetBounds: target,
      obstacles: [obstacle],
      channelY: 260,
    };

    expect(getEffectiveApproachX(sourceClearDown, approachCtx)).toBe(650);
    expect(getEffectiveApproachX(sourceBlockedDown, approachCtx)).toBe(520);
    expect(getEffectiveApproachX(sourceClearUp, approachCtx)).toBe(650);
    expect(getEffectiveApproachX(sourceBlockedUp, approachCtx)).toBe(520);

    const f1 = { id: 'Msg_1', sourceRef: 'S1' };
    const f2 = { id: 'Msg_2', sourceRef: 'S2' };
    const f3 = { sourceRef: 'S3' };
    const allShapes = new Map([
      ['S1', sourceClearUp],
      ['S2', sourceBlockedUp],
    ]);

    // Single flow returns undefined
    expect(
      computeTargetPortX({
        flow: f1,
        flowsForTarget: [f1],
        tgtBounds: target,
        allShapesMap: allShapes,
        obstacles: [obstacle],
      })
    ).toBeUndefined();

    // Multiple flows sorted by approach X (blocked at 520, clear at 650)
    const portBlocked = computeTargetPortX({
      flow: f2,
      flowsForTarget: [f1, f2],
      tgtBounds: target,
      allShapesMap: allShapes,
      obstacles: [obstacle],
    });
    const portClear = computeTargetPortX({
      flow: f1,
      flowsForTarget: [f1, f2],
      tgtBounds: target,
      allShapesMap: allShapes,
      obstacles: [obstacle],
    });
    expect(portBlocked).toBe(433);
    expect(portClear).toBe(467);

    // Identical approach X falls back to ID sort or empty id fallback
    const allShapesSame = new Map([
      ['S1', sourceClearUp],
      ['S2', sourceClearUp],
    ]);
    const portId1 = computeTargetPortX({
      flow: f1,
      flowsForTarget: [f2, f1],
      tgtBounds: target,
      allShapesMap: allShapesSame,
      obstacles: [],
    });
    const portId2 = computeTargetPortX({
      flow: f2,
      flowsForTarget: [f2, f1],
      tgtBounds: target,
      allShapesMap: allShapesSame,
      obstacles: [],
    });
    expect(portId1).toBe(433);
    expect(portId2).toBe(467);

    // Missing source bounds fallback and empty ID fallback
    const portMissingSrc = computeTargetPortX({
      flow: f3,
      flowsForTarget: [f3, f1],
      tgtBounds: target,
      allShapesMap: allShapes,
      obstacles: [],
    });
    expect(portMissingSrc).toBe(433);

    const fNoIdA = { sourceRef: 'Unknown_A' };
    const fNoIdB = { sourceRef: 'Unknown_B' };
    const portNoIds = computeTargetPortX({
      flow: fNoIdA,
      flowsForTarget: [fNoIdA, fNoIdB],
      tgtBounds: target,
      allShapesMap: new Map(),
      obstacles: [],
    });
    expect(portNoIds).toBe(433);
  });

  it('handles pool connection port layout and spacing', () => {
    const poolBounds = { x: 100, y: 500, width: 400, height: 80 };

    // Empty entries
    expect(layoutPoolConnectionPorts(poolBounds, []).size).toBe(0);

    // Single entry
    const single = layoutPoolConnectionPorts(poolBounds, [{ flowId: 'F1', idealX: 250 }]);
    expect(single.get('F1')).toBe(250);

    // Multiple entries requiring spacing
    const spaced = layoutPoolConnectionPorts(poolBounds, [
      { flowId: 'F1', idealX: 200 },
      { flowId: 'F2', idealX: 205 },
    ]);
    expect(spaced.get('F1')).toBe(200);
    expect(spaced.get('F2')).toBe(230);

    // Entries overflowing pool right edge shift left
    const overflowEntries = [
      { flowId: 'F1', idealX: 450 },
      { flowId: 'F2', idealX: 470 },
      { flowId: 'F3', idealX: 475 },
    ];
    const shifted = layoutPoolConnectionPorts(poolBounds, overflowEntries);
    expect(shifted.get('F3')).toBeLessThanOrEqual(480);
    expect(shifted.get('F1')).toBeGreaterThanOrEqual(120);

    // computeTargetPortX with isTargetPool: true
    const flow1 = { id: 'F1', sourceRef: 'S1' };
    const flow2 = { id: 'F2', sourceRef: 'S2' };
    const allShapes = new Map([
      ['S1', { x: 150, y: 100, width: 100, height: 80 }],
      ['S2', { x: 300, y: 100, width: 100, height: 80 }],
    ]);
    const port1 = computeTargetPortX({
      flow: flow1,
      flowsForTarget: [flow1, flow2],
      tgtBounds: poolBounds,
      allShapesMap: allShapes,
      obstacles: [],
      isTargetPool: true,
    });
    const port2 = computeTargetPortX({
      flow: flow2,
      flowsForTarget: [flow1, flow2],
      tgtBounds: poolBounds,
      allShapesMap: allShapes,
      obstacles: [],
      isTargetPool: true,
    });
    expect(port1).toBe(200);
    expect(port2).toBe(350);

    // Flow with object sourceRef
    const flowObj = { id: 'F3', sourceRef: { id: 'S1' } };
    const portObj = computeTargetPortX({
      flow: flowObj,
      flowsForTarget: [flowObj],
      tgtBounds: poolBounds,
      allShapesMap: allShapes,
      obstacles: [],
      isTargetPool: true,
    });
    expect(portObj).toBe(200);

    // Fallback when source not in allShapesMap
    const flowUnknown = { id: 'FU', sourceRef: 'Unknown' };
    const portUnknown = computeTargetPortX({
      flow: flowUnknown,
      flowsForTarget: [flowUnknown],
      tgtBounds: poolBounds,
      allShapesMap: new Map(),
      obstacles: [],
      isTargetPool: true,
    });
    expect(portUnknown).toBe(300);
  });

  it('collects and resolves pool ports for collaboration participants', () => {
    const poolBounds = { x: 100, y: 500, width: 400, height: 80 };
    const shapes = new Map([
      ['Pool_Ext', poolBounds],
      ['Task_A', { x: 200, y: 100, width: 100, height: 80 }],
      ['Task_B', { x: 250, y: 700, width: 100, height: 80 }],
    ]);
    const flows = [
      { id: 'MF_In', sourceRef: 'Task_A', targetRef: 'Pool_Ext' },
      { id: 'MF_Out', sourceRef: 'Pool_Ext', targetRef: 'Task_B' },
      { id: 'MF_Missing', sourceRef: 'Unknown_Src', targetRef: 'Pool_Ext' },
      { id: 'MF_Out_Missing', sourceRef: 'Pool_Ext', targetRef: 'Unknown_Tgt' },
      { id: 'MF_Obj_In', sourceRef: { id: 'Task_A' }, targetRef: { id: 'Pool_Ext' } },
      { id: 'MF_Obj_Out', sourceRef: { id: 'Pool_Ext' }, targetRef: { id: 'Task_B' } },
    ];

    const entries = collectPoolPortEntries({
      poolId: 'Pool_Ext',
      poolBounds,
      messageFlows: flows,
      allShapesMap: shapes,
    });
    expect(entries.length).toBe(6);

    const participants = [{ id: 'Pool_Ext' }, { id: 'Pool_No_Bounds' }];
    const resolved = resolveAllPoolPorts(participants, flows, shapes);
    expect(resolved.targetPorts.get('MF_In')).toBeDefined();
    expect(resolved.sourcePorts.get('MF_Out')).toBeDefined();
    expect(resolved.targetPorts.get('MF_Obj_In')).toBeDefined();
    expect(resolved.sourcePorts.get('MF_Obj_Out')).toBeDefined();
  });

  it('handles enclosing containers and obstacles in routeMessageFlow and isMessageCorridorBlocked', () => {
    const parentContainer = { x: 50, y: 50, width: 300, height: 300 };
    const innerNode = { x: 100, y: 100, width: 100, height: 80 };
    const blocked = isMessageCorridorBlocked(150, [180, 250], {
      ignore: [innerNode],
      obstacles: [parentContainer],
    });
    expect(blocked).toBe(false);

    // Collinear obstacle detection in routeMessageFlow (source above target)
    const src = { x: 100, y: 50, width: 100, height: 80 };
    const tgt = { x: 100, y: 400, width: 100, height: 80 };
    const obstacle = { x: 100, y: 200, width: 100, height: 80 };
    const blockedDownRoute = routeMessageFlow(src, tgt, { obstacles: [obstacle] });
    expect(blockedDownRoute.length).toBe(5);

    // Collinear obstacle detection in routeMessageFlow (source below target)
    const blockedUpRoute = routeMessageFlow(tgt, src, { obstacles: [obstacle] });
    expect(blockedUpRoute.length).toBe(5);

    // sourcePortX support when source is below target
    const srcPool = { x: 100, y: 500, width: 600, height: 100 };
    const tgtNode = { x: 300, y: 100, width: 100, height: 80 };
    const waypointsUp = routeMessageFlow(srcPool, tgtNode, {
      sourcePortX: 350,
      targetPortX: 350,
    });
    expect(waypointsUp.length).toBe(2);
    expect(waypointsUp[0].x).toBe(350);
    expect(waypointsUp[1].x).toBe(350);

    // sourcePortX support when source is above target
    const topPool = { x: 100, y: 50, width: 600, height: 100 };
    const bottomNode = { x: 300, y: 300, width: 100, height: 80 };
    const waypointsDown = routeMessageFlow(topPool, bottomNode, {
      sourcePortX: 350,
      targetPortX: 350,
    });
    expect(waypointsDown.length).toBe(2);
    expect(waypointsDown[0].x).toBe(350);
    expect(waypointsDown[1].x).toBe(350);
  });

  describe('message flows between horizontally overlapping shapes run straight, not via the source center', () => {
    const upper = { x: 500, y: 100, width: 100, height: 80 };
    const lower = { x: 500, y: 400, width: 100, height: 80 };

    it('slides the source exit to a spread target port instead of jogging (09-b2b Msg_Quote)', () => {
      const waypoints = routeMessageFlow(lower, upper, { targetPortX: 533 });
      expect(waypoints).toEqual([
        { x: 533, y: 400 },
        { x: 533, y: 180 },
      ]);
    });

    it('slides the target entry to a fixed source port', () => {
      const waypoints = routeMessageFlow(upper, lower, { sourcePortX: 570 });
      expect(waypoints).toEqual([
        { x: 570, y: 180 },
        { x: 570, y: 400 },
      ]);
    });

    it('uses the point of the overlap nearest the source center when neither port is fixed', () => {
      const shiftedTarget = { x: 560, y: 400, width: 100, height: 80 };
      const waypoints = routeMessageFlow(upper, shiftedTarget);
      // Overlap is x 560..600 inset by 10 on each side -> 570..590; source center 550 clamps to 570.
      expect(waypoints).toEqual([
        { x: 570, y: 180 },
        { x: 570, y: 400 },
      ]);
    });

    it('keeps the target port and jogs when the fixed port lies outside the overlap', () => {
      const waypoints = routeMessageFlow(lower, upper, { targetPortX: 505 });
      expect(waypoints.length).toBeGreaterThan(2);
      expect(waypoints[waypoints.length - 1].x).toBe(505);
    });

    it('leaves two fixed ports alone', () => {
      const waypoints = routeMessageFlow(lower, upper, { sourcePortX: 520, targetPortX: 580 });
      expect(waypoints[0].x).toBe(520);
      expect(waypoints[waypoints.length - 1].x).toBe(580);
      expect(waypoints.length).toBeGreaterThan(2);
    });

    it('does not slide when the shapes do not overlap enough to keep off the corners', () => {
      const barelyOverlapping = { x: 595, y: 400, width: 100, height: 80 };
      const waypoints = routeMessageFlow(upper, barelyOverlapping);
      expect(waypoints.length).toBeGreaterThan(2);
    });

    it('falls back to the routed path when the straight corridor is blocked', () => {
      const blocker = { x: 500, y: 250, width: 100, height: 60 };
      const waypoints = routeMessageFlow(lower, upper, {
        targetPortX: 533,
        obstacles: [blocker],
      });
      expect(waypoints.length).toBeGreaterThan(2);
    });
  });

  it('layouts collaboration with lanes and external pool with straight vertical message flows', async () => {
    const builder = new BpmnBuilder('Proc_Lanes');
    builder
      .addParticipant('Pool_Main', 'Proc_Lanes', 'Main Service')
      .addStartEvent('Start_1', 'Start')
      .addTask('Task_Lane1', 'Draft Message')
      .addTask('Task_Lane2', 'Process Reply')
      .addEndEvent('End_1', 'Done')
      .addLane('Lane_1', ['Start_1', 'Task_Lane1'], 'Drafting')
      .addLane('Lane_2', ['Task_Lane2', 'End_1'], 'Processing')
      .addSequenceFlow('F1', 'Start_1', 'Task_Lane1')
      .addSequenceFlow('F2', 'Task_Lane1', 'Task_Lane2')
      .addSequenceFlow('F3', 'Task_Lane2', 'End_1')
      .addParticipant('Pool_External', undefined as any, 'External Partner')
      .addMessageFlow('MF_To_Partner', 'Task_Lane1', 'Pool_External')
      .addMessageFlow('MF_From_Partner', 'Pool_External', 'Task_Lane2');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('id="Pool_Main_di"');
    expect(resultXml).toContain('id="Pool_External_di"');
    expect(resultXml).toContain('id="MF_To_Partner_di"');
    expect(resultXml).toContain('id="MF_From_Partner_di"');

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);
  });

  it('handles edges with string sourceRef in layoutProcessLanes', () => {
    const process = {
      laneSets: [
        {
          lanes: [{ id: 'Lane_1', flowNodeRef: [{ id: 'Task_1' }] }],
        },
      ],
    };
    const shapes = [
      { element: { id: 'Task_1' }, bounds: { x: 100, y: 100, width: 100, height: 80 } },
    ];
    const edges = [
      {
        element: { sourceRef: 'Task_1' },
        waypoints: [
          { x: 150, y: 180 },
          { x: 150, y: 220 },
        ],
        isFeedback: true,
      },
    ];
    const result = layoutProcessLanes(process, shapes, {
      startX: 100,
      startY: 80,
      totalWidth: 500,
      edges,
    });
    expect(result.lanes.length).toBe(1);
    expect(result.lanes[0].bounds.height).toBeGreaterThanOrEqual(120);
  });

  it('handles boundary events not explicitly listed in flowNodeRef in layoutProcessLanes', () => {
    const process = {
      laneSets: [
        {
          lanes: [{ id: 'Lane_1', flowNodeRef: [{ id: 'Task_1' }] }],
        },
      ],
    };
    const shapes = [
      { element: { id: 'Task_1' }, bounds: { x: 100, y: 100, width: 100, height: 80 } },
      {
        element: { $type: 'bpmn:BoundaryEvent', id: 'Boundary_1', attachedToRef: { id: 'Task_1' } },
        bounds: { x: 130, y: 162, width: 36, height: 36 },
      },
    ];
    const result = layoutProcessLanes(process, shapes, {
      startX: 100,
      startY: 80,
      totalWidth: 500,
    });
    expect(result.lanes.length).toBe(1);
    expect(result.lanes[0].bounds.height).toBeGreaterThanOrEqual(120);
  });

  it('computes fallback content Y extents when shapes and edges are empty', () => {
    const extents = computeScopeContentYExtents({ shapes: [], edges: [] });
    expect(extents).toEqual({ minContentY: 80, maxContentY: 160 });
  });

  it('handles multi-lane processes with empty first and last lanes and boundary event ref variants', () => {
    const process = {
      laneSets: [
        {
          lanes: [
            { id: 'Lane_Empty_First', flowNodeRef: [] },
            { id: 'Lane_Content', flowNodeRef: [{ id: 'Task_In_Lane' }] },
            { id: 'Lane_Empty_Last', flowNodeRef: [] },
          ],
        },
      ],
    };
    const shapes = [
      { element: { id: 'Task_In_Lane' }, bounds: { x: 100, y: 220, width: 100, height: 80 } },
      {
        element: {
          $type: 'bpmn:BoundaryEvent',
          id: 'Boundary_String_Ref',
          attachedToRef: 'Task_In_Lane',
        },
        bounds: { x: 130, y: 282, width: 36, height: 36 },
      },
      {
        element: {
          $type: 'bpmn:BoundaryEvent',
          id: 'Boundary_Orphan',
          attachedToRef: 'NonExistentTask',
        },
        bounds: { x: 200, y: 200, width: 36, height: 36 },
      },
      {
        element: {
          $type: 'bpmn:BoundaryEvent',
          id: 'Boundary_No_Ref',
        },
        bounds: { x: 250, y: 200, width: 36, height: 36 },
      },
    ];
    const result = layoutProcessLanes(process, shapes, {
      startX: 100,
      startY: 80,
      totalWidth: 500,
    });
    expect(result.lanes.length).toBe(3);
    expect(result.lanes[0].bounds.height).toBe(120);
    expect(result.lanes[1].bounds.height).toBeGreaterThanOrEqual(120);
    expect(result.lanes[2].bounds.height).toBe(120);
  });
});
