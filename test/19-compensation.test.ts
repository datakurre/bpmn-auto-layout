import { describe, it, expect } from 'vitest';
import { BpmnBuilder } from '../src/bpmn-builder';
import { layoutProcess } from '../src/index';
import { scoreDiagram } from '../src/layout-metrics';
import { layoutScope } from '../src/hierarchy/subprocess-layout';
import { expectSnapshotMatch } from './helpers/snapshot-helper';

describe('Iteration 13: Compensation Handlers', () => {
  it('layouts a task with a compensation boundary event and a single handler task', async () => {
    const builder = new BpmnBuilder('Process_SingleCompensation');
    builder
      .addStartEvent('Start_1', 'Start')
      .addTask('Task_Book', 'Book Room')
      .addTask('Task_Pay', 'Charge Payment')
      .addEndEvent('End_1', 'Done')
      .addBoundaryEvent({
        id: 'Boundary_CompBook',
        attachedToRef: 'Task_Book',
        eventDefinitionType: 'bpmn:CompensateEventDefinition',
      })
      .addCompensationTask('Handler_CancelBooking', 'Cancel Booking')
      .addAssociation('Assoc_1', 'Boundary_CompBook', 'Handler_CancelBooking')
      .addSequenceFlow('Flow_1', 'Start_1', 'Task_Book')
      .addSequenceFlow('Flow_2', 'Task_Book', 'Task_Pay')
      .addSequenceFlow('Flow_3', 'Task_Pay', 'End_1');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('compensateEventDefinition');
    expect(resultXml).toContain('isForCompensation="true"');
    expect(resultXml).toContain('Handler_CancelBooking');

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);

    expectSnapshotMatch(resultXml, '13-single-compensation-handler');
  });

  it('layouts a compensation handler that is itself an expanded sub-process', async () => {
    const builder = new BpmnBuilder('Process_SubProcessCompensation');
    builder
      .addStartEvent('Start_1', 'Start')
      .addTask('Task_Charge', 'Charge Card')
      .addEndEvent('End_1', 'Done')
      .addBoundaryEvent({
        id: 'Boundary_CompCharge',
        attachedToRef: 'Task_Charge',
        eventDefinitionType: 'bpmn:CompensateEventDefinition',
      })
      .addCompensationSubProcess('Handler_RefundProcess', 'Refund Process', (sub) => {
        sub
          .addStartEvent('Sub_Start', 'Start')
          .addTask('Sub_ValidateRefund', 'Validate Refund')
          .addTask('Sub_IssueRefund', 'Issue Refund')
          .addEndEvent('Sub_End', 'Done')
          .addSequenceFlow('SubFlow_1', 'Sub_Start', 'Sub_ValidateRefund')
          .addSequenceFlow('SubFlow_2', 'Sub_ValidateRefund', 'Sub_IssueRefund')
          .addSequenceFlow('SubFlow_3', 'Sub_IssueRefund', 'Sub_End');
      })
      .addAssociation('Assoc_1', 'Boundary_CompCharge', 'Handler_RefundProcess')
      .addSequenceFlow('Flow_1', 'Start_1', 'Task_Charge')
      .addSequenceFlow('Flow_2', 'Task_Charge', 'End_1');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('isForCompensation="true"');
    expect(resultXml).toContain('isExpanded="true"');
    expect(resultXml).toContain('Sub_ValidateRefund');
    expect(resultXml).toContain('Sub_IssueRefund');

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);

    expectSnapshotMatch(resultXml, '13-compensation-subprocess-handler');
  });

  it('layouts a mid-flow intermediate throw event that triggers compensation', async () => {
    const builder = new BpmnBuilder('Process_ThrowCompensation');
    builder
      .addStartEvent('Start_1', 'Start')
      .addTask('Task_Process', 'Process Order')
      .addIntermediateThrowEvent(
        'Throw_Compensate',
        'Trigger Compensation',
        'bpmn:CompensateEventDefinition'
      )
      .addEndEvent('End_1', 'Cancelled')
      .addSequenceFlow('Flow_1', 'Start_1', 'Task_Process')
      .addSequenceFlow('Flow_2', 'Task_Process', 'Throw_Compensate')
      .addSequenceFlow('Flow_3', 'Throw_Compensate', 'End_1');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('compensateEventDefinition');
    expect(resultXml).toContain('Throw_Compensate');

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);

    expectSnapshotMatch(resultXml, '13-intermediate-throw-compensate');
  });

  it('layouts multiple simultaneous compensation handlers along one flow', async () => {
    const builder = new BpmnBuilder('Process_MultipleCompensation');
    builder
      .addStartEvent('Start_1', 'Start')
      .addTask('Task_Reserve', 'Reserve Inventory')
      .addTask('Task_Charge', 'Charge Payment')
      .addTask('Task_Ship', 'Ship Order')
      .addEndEvent('End_1', 'Done')
      .addBoundaryEvent({
        id: 'Boundary_CompReserve',
        attachedToRef: 'Task_Reserve',
        eventDefinitionType: 'bpmn:CompensateEventDefinition',
      })
      .addBoundaryEvent({
        id: 'Boundary_CompCharge',
        attachedToRef: 'Task_Charge',
        eventDefinitionType: 'bpmn:CompensateEventDefinition',
      })
      .addBoundaryEvent({
        id: 'Boundary_CompShip',
        attachedToRef: 'Task_Ship',
        eventDefinitionType: 'bpmn:CompensateEventDefinition',
      })
      .addCompensationTask('Handler_ReleaseInventory', 'Release Inventory')
      .addCompensationTask('Handler_RefundPayment', 'Refund Payment')
      .addCompensationTask('Handler_RecallShipment', 'Recall Shipment')
      .addAssociation('Assoc_1', 'Boundary_CompReserve', 'Handler_ReleaseInventory')
      .addAssociation('Assoc_2', 'Boundary_CompCharge', 'Handler_RefundPayment')
      .addAssociation('Assoc_3', 'Boundary_CompShip', 'Handler_RecallShipment')
      .addSequenceFlow('Flow_1', 'Start_1', 'Task_Reserve')
      .addSequenceFlow('Flow_2', 'Task_Reserve', 'Task_Charge')
      .addSequenceFlow('Flow_3', 'Task_Charge', 'Task_Ship')
      .addSequenceFlow('Flow_4', 'Task_Ship', 'End_1');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('Handler_ReleaseInventory');
    expect(resultXml).toContain('Handler_RefundPayment');
    expect(resultXml).toContain('Handler_RecallShipment');
    expect(resultXml.match(/compensateEventDefinition/g)?.length).toBe(3);

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);

    expectSnapshotMatch(resultXml, '13-multiple-compensation-handlers');
  });

  it('does not drop a scope containing only a compensation handler', () => {
    const result = layoutScope({
      flowElements: [{ $type: 'bpmn:Task', id: 'CompTask_Solo', isForCompensation: true }],
    });
    expect(result.shapes.length).toBe(1);
    expect(result.shapes[0].element.id).toBe('CompTask_Solo');
  });
});
