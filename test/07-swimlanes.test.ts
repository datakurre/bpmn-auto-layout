import { describe, it, expect } from 'vitest';
import { BpmnBuilder } from '../src/bpmn-builder';
import { layoutProcess } from '../src/index';
import { scoreDiagram } from '../src/layout-metrics';
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
});
