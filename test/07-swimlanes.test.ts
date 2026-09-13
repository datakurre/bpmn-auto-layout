import { describe, it, expect } from 'vitest';
import { BpmnModdle } from 'bpmn-moddle';
import { BpmnBuilder } from '../src/bpmn-builder';
import { layoutProcess } from '../src/index';
import { scoreDiagram } from '../src/layout-metrics';
import { routeMessageFlow, layoutProcessLanes } from '../src/hierarchy/swimlane-layout';
import {
  findEnclosingPool,
  computeInterPoolChannelY,
  getEffectiveApproachX,
  computeTargetPortX,
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
});
