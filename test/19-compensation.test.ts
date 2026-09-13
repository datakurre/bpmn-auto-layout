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

  it('layouts a complex trip-booking workflow combining parallel bookings, a subprocess handler, and an explicit compensation trigger', async () => {
    const builder = new BpmnBuilder('Process_TripBooking');
    builder
      .addStartEvent('Start_1', 'Booking Started')
      .addTask('Task_ReserveFlight', 'Reserve Flight')
      .addParallelGateway('Gate_Fork', 'Fork')
      .addTask('Task_ReserveHotel', 'Reserve Hotel')
      .addTask('Task_ReserveCar', 'Reserve Car')
      .addParallelGateway('Gate_Join', 'Join')
      .addTask('Task_ChargePayment', 'Charge Payment')
      .addExclusiveGateway('Gate_Confirm', 'Confirmed?')
      .addIntermediateThrowEvent(
        'Throw_CompensateAll',
        'Trigger Compensation',
        'bpmn:CompensateEventDefinition'
      )
      .addTask('Task_NotifyCancellation', 'Notify Customer')
      .addEndEvent('End_Cancelled', 'Booking Cancelled')
      .addEndEvent('End_Confirmed', 'Booking Confirmed')
      .addBoundaryEvent({
        id: 'Boundary_CompFlight',
        attachedToRef: 'Task_ReserveFlight',
        eventDefinitionType: 'bpmn:CompensateEventDefinition',
      })
      .addBoundaryEvent({
        id: 'Boundary_CompHotel',
        attachedToRef: 'Task_ReserveHotel',
        eventDefinitionType: 'bpmn:CompensateEventDefinition',
      })
      .addBoundaryEvent({
        id: 'Boundary_CompCar',
        attachedToRef: 'Task_ReserveCar',
        eventDefinitionType: 'bpmn:CompensateEventDefinition',
      })
      .addBoundaryEvent({
        id: 'Boundary_CompPayment',
        attachedToRef: 'Task_ChargePayment',
        eventDefinitionType: 'bpmn:CompensateEventDefinition',
      })
      .addCompensationTask('Handler_CancelFlight', 'Cancel Flight')
      .addCompensationTask('Handler_CancelHotel', 'Cancel Hotel')
      .addCompensationTask('Handler_CancelCar', 'Cancel Car')
      .addCompensationSubProcess('Handler_RefundPayment', 'Refund Process', (sub) => {
        sub
          .addStartEvent('Sub_Start', 'Start')
          .addTask('Sub_ValidateRefund', 'Validate Refund')
          .addTask('Sub_IssueRefund', 'Issue Refund')
          .addEndEvent('Sub_End', 'Done')
          .addSequenceFlow('SubFlow_1', 'Sub_Start', 'Sub_ValidateRefund')
          .addSequenceFlow('SubFlow_2', 'Sub_ValidateRefund', 'Sub_IssueRefund')
          .addSequenceFlow('SubFlow_3', 'Sub_IssueRefund', 'Sub_End');
      })
      .addAssociation('Assoc_Flight', 'Boundary_CompFlight', 'Handler_CancelFlight')
      .addAssociation('Assoc_Hotel', 'Boundary_CompHotel', 'Handler_CancelHotel')
      .addAssociation('Assoc_Car', 'Boundary_CompCar', 'Handler_CancelCar')
      .addAssociation('Assoc_Payment', 'Boundary_CompPayment', 'Handler_RefundPayment')
      .addSequenceFlow('Flow_1', 'Start_1', 'Task_ReserveFlight')
      .addSequenceFlow('Flow_2', 'Task_ReserveFlight', 'Gate_Fork')
      .addSequenceFlow('Flow_3', 'Gate_Fork', 'Task_ReserveHotel')
      .addSequenceFlow('Flow_4', 'Gate_Fork', 'Task_ReserveCar')
      .addSequenceFlow('Flow_5', 'Task_ReserveHotel', 'Gate_Join')
      .addSequenceFlow('Flow_6', 'Task_ReserveCar', 'Gate_Join')
      .addSequenceFlow('Flow_7', 'Gate_Join', 'Task_ChargePayment')
      .addSequenceFlow('Flow_8', 'Task_ChargePayment', 'Gate_Confirm')
      .addSequenceFlow({
        id: 'Flow_Cancel',
        sourceRef: 'Gate_Confirm',
        targetRef: 'Throw_CompensateAll',
        name: 'Cancelled',
      })
      .addSequenceFlow('Flow_9', 'Throw_CompensateAll', 'Task_NotifyCancellation')
      .addSequenceFlow('Flow_10', 'Task_NotifyCancellation', 'End_Cancelled')
      .addSequenceFlow({
        id: 'Flow_Confirm',
        sourceRef: 'Gate_Confirm',
        targetRef: 'End_Confirmed',
        name: 'Confirmed',
      });

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('Handler_CancelFlight');
    expect(resultXml).toContain('Handler_CancelHotel');
    expect(resultXml).toContain('Handler_CancelCar');
    expect(resultXml).toContain('Handler_RefundPayment');
    expect(resultXml).toContain('Sub_ValidateRefund');
    expect(resultXml).toContain('Sub_IssueRefund');
    expect(resultXml).toContain('isExpanded="true"');
    expect(resultXml.match(/compensateEventDefinition/g)?.length).toBe(5);

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);

    expectSnapshotMatch(resultXml, '13-trip-booking-with-compensation');
  });

  it('does not drop a scope containing only a compensation handler', () => {
    const result = layoutScope({
      flowElements: [{ $type: 'bpmn:Task', id: 'CompTask_Solo', isForCompensation: true }],
    });
    expect(result.shapes.length).toBe(1);
    expect(result.shapes[0].element.id).toBe('CompTask_Solo');
  });
});
