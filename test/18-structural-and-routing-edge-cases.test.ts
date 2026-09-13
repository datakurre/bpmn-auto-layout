import { describe, it, expect } from 'vitest';
import { BpmnBuilder } from '../src/bpmn-builder';
import { layoutProcess } from '../src/index';
import { scoreDiagram } from '../src/layout-metrics';
import { expectSnapshotMatch } from './helpers/snapshot-helper';

describe('Iteration 12: Structural & Routing Edge Cases', () => {
  it('layouts an ad-hoc sub-process with unordered tasks', async () => {
    const builder = new BpmnBuilder('Process_AdHoc');
    builder
      .addStartEvent('Start_1', 'Start')
      .addAdHocSubProcess('AdHoc_Review', 'Review Checks', (sub) => {
        sub
          .addTask('Task_A', 'Check Inventory')
          .addTask('Task_B', 'Check Pricing')
          .addTask('Task_C', 'Check Availability');
      })
      .addEndEvent('End_1', 'Done')
      .addSequenceFlow('Flow_1', 'Start_1', 'AdHoc_Review')
      .addSequenceFlow('Flow_2', 'AdHoc_Review', 'End_1');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('adHocSubProcess');
    expect(resultXml).toContain('isExpanded="true"');
    expect(resultXml).toContain('Task_A');
    expect(resultXml).toContain('Task_B');
    expect(resultXml).toContain('Task_C');

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);

    expectSnapshotMatch(resultXml, '12-adhoc-subprocess');
  });

  it('layouts a non-interrupting boundary event inside a feedback/retry loop', async () => {
    const builder = new BpmnBuilder('Process_BoundaryFeedback');
    builder
      .addStartEvent('Start_1', 'Start')
      .addExclusiveGateway('Gate_Merge_Retry', 'Retry Point')
      .addTask('Task_Review', 'Review Document')
      .addExclusiveGateway('Gate_Approved', 'Approved?')
      .addExclusiveGateway('Gate_Merge_Downstream', 'Continue')
      .addEndEvent('End_1', 'Completed')
      .addBoundaryEvent({
        id: 'Boundary_Escalation',
        attachedToRef: 'Task_Review',
        name: 'Escalation Timer',
        eventDefinitionType: 'bpmn:TimerEventDefinition',
        cancelActivity: false,
      })
      .addTask('Task_Escalate', 'Notify Manager')
      .addSequenceFlow('Flow_1', 'Start_1', 'Gate_Merge_Retry')
      .addSequenceFlow('Flow_2', 'Gate_Merge_Retry', 'Task_Review')
      .addSequenceFlow('Flow_3', 'Task_Review', 'Gate_Approved')
      .addSequenceFlow({
        id: 'Flow_Rework',
        sourceRef: 'Gate_Approved',
        targetRef: 'Gate_Merge_Retry',
        name: 'Needs Rework',
      })
      .addSequenceFlow({
        id: 'Flow_Approved',
        sourceRef: 'Gate_Approved',
        targetRef: 'Gate_Merge_Downstream',
        name: 'Approved',
      })
      .addSequenceFlow('Flow_Escalate', 'Boundary_Escalation', 'Task_Escalate')
      .addSequenceFlow('Flow_Rejoin', 'Task_Escalate', 'Gate_Merge_Downstream')
      .addSequenceFlow('Flow_End', 'Gate_Merge_Downstream', 'End_1');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('cancelActivity="false"');
    expect(resultXml).toContain('timerEventDefinition');

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);

    expectSnapshotMatch(resultXml, '12-noninterrupting-boundary-feedback-loop');
  });

  it('layouts a mixed exclusive/parallel/inclusive gateway matrix nested three levels deep', async () => {
    const builder = new BpmnBuilder('Process_MixedGateways');
    builder
      .addStartEvent('Start_1', 'Start')
      .addInclusiveGateway('Gate_Incl_Split', 'Route')
      .addParallelGateway('Gate_Par_Split', 'Fork')
      .addTask('Task_P1', 'Parallel Task 1')
      .addTask('Task_P2', 'Parallel Task 2')
      .addParallelGateway('Gate_Par_Join', 'Join')
      .addExclusiveGateway('Gate_Excl_Inner', 'Inner Choice')
      .addTask('Task_X1', 'Handle Yes')
      .addTask('Task_X2', 'Handle No')
      .addExclusiveGateway('Gate_Excl_Join', 'Merge Choice')
      .addTask('Task_Direct', 'Direct Path')
      .addInclusiveGateway('Gate_Incl_Join', 'Converge')
      .addEndEvent('End_1', 'Done')
      .addSequenceFlow('Flow_1', 'Start_1', 'Gate_Incl_Split')
      .addSequenceFlow({
        id: 'Flow_PathA',
        sourceRef: 'Gate_Incl_Split',
        targetRef: 'Gate_Par_Split',
        name: 'Path A',
      })
      .addSequenceFlow({
        id: 'Flow_PathB',
        sourceRef: 'Gate_Incl_Split',
        targetRef: 'Task_Direct',
        name: 'Path B',
      })
      .addSequenceFlow('Flow_P1', 'Gate_Par_Split', 'Task_P1')
      .addSequenceFlow('Flow_P2', 'Gate_Par_Split', 'Task_P2')
      .addSequenceFlow('Flow_P1_Join', 'Task_P1', 'Gate_Par_Join')
      .addSequenceFlow('Flow_P2_Join', 'Task_P2', 'Gate_Par_Join')
      .addSequenceFlow('Flow_ToInner', 'Gate_Par_Join', 'Gate_Excl_Inner')
      .addSequenceFlow({
        id: 'Flow_Yes',
        sourceRef: 'Gate_Excl_Inner',
        targetRef: 'Task_X1',
        name: 'Yes',
      })
      .addSequenceFlow({
        id: 'Flow_No',
        sourceRef: 'Gate_Excl_Inner',
        targetRef: 'Task_X2',
        name: 'No',
      })
      .addSequenceFlow('Flow_X1_Join', 'Task_X1', 'Gate_Excl_Join')
      .addSequenceFlow('Flow_X2_Join', 'Task_X2', 'Gate_Excl_Join')
      .addSequenceFlow('Flow_ToConverge', 'Gate_Excl_Join', 'Gate_Incl_Join')
      .addSequenceFlow('Flow_Direct_Join', 'Task_Direct', 'Gate_Incl_Join')
      .addSequenceFlow('Flow_End', 'Gate_Incl_Join', 'End_1');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('inclusiveGateway');
    expect(resultXml).toContain('parallelGateway');
    expect(resultXml).toContain('exclusiveGateway');

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);

    expectSnapshotMatch(resultXml, '12-mixed-gateway-matrix');
  });

  it('lays out a deep collinear bypass chain cleanly', async () => {
    const builder = new BpmnBuilder('Process_DeepBypass');
    builder
      .addStartEvent('Start_1', 'Start')
      .addExclusiveGateway('Split', 'Route')
      .addTask('Task_A1', 'Step 1')
      .addTask('Task_A2', 'Step 2')
      .addTask('Task_A3', 'Step 3')
      .addTask('Task_A4', 'Step 4')
      .addExclusiveGateway('Join', 'Merge')
      .addEndEvent('End_1', 'Done')
      .addSequenceFlow('F0', 'Start_1', 'Split')
      .addSequenceFlow('F_Work_1', 'Split', 'Task_A1')
      .addSequenceFlow('F_Work_2', 'Task_A1', 'Task_A2')
      .addSequenceFlow('F_Work_3', 'Task_A2', 'Task_A3')
      .addSequenceFlow('F_Work_4', 'Task_A3', 'Task_A4')
      .addSequenceFlow('F_Work_5', 'Task_A4', 'Join')
      .addSequenceFlow('F_Bypass', 'Split', 'Join')
      .addSequenceFlow('F_End', 'Join', 'End_1');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);

    expectSnapshotMatch(resultXml, '12-deep-collinear-bypass');
  });

  it('layouts an event sub-process with internal branching alongside disconnected artifacts', async () => {
    const builder = new BpmnBuilder('Process_EventSubBranching');
    builder
      .addStartEvent('Start_Main', 'Order Placed')
      .addTask('Task_ProcessOrder', 'Process Order')
      .addEndEvent('End_Main', 'Order Completed')
      .addSequenceFlow('Flow_1', 'Start_Main', 'Task_ProcessOrder')
      .addSequenceFlow('Flow_2', 'Task_ProcessOrder', 'End_Main')
      .addEventSubProcess('EventSub_Error', 'Error Handling', (sub) => {
        sub
          .addStartEvent('Start_Err', 'Error Caught', 'bpmn:ErrorEventDefinition')
          .addExclusiveGateway('Gate_Severity', 'Severity?')
          .addTask('Task_AutoRetry', 'Auto Retry')
          .addTask('Task_Escalate', 'Escalate to Ops')
          .addExclusiveGateway('Gate_Err_Merge', 'Merge')
          .addEndEvent('End_Err', 'Order Cancelled')
          .addSequenceFlow('SubFlow_1', 'Start_Err', 'Gate_Severity')
          .addSequenceFlow({
            id: 'SubFlow_Low',
            sourceRef: 'Gate_Severity',
            targetRef: 'Task_AutoRetry',
            name: 'Low',
          })
          .addSequenceFlow({
            id: 'SubFlow_High',
            sourceRef: 'Gate_Severity',
            targetRef: 'Task_Escalate',
            name: 'High',
          })
          .addSequenceFlow('SubFlow_2', 'Task_AutoRetry', 'Gate_Err_Merge')
          .addSequenceFlow('SubFlow_3', 'Task_Escalate', 'Gate_Err_Merge')
          .addSequenceFlow('SubFlow_4', 'Gate_Err_Merge', 'End_Err');
      })
      .addTextAnnotation('Note_SLA', 'SLA: resolve within 4 hours')
      .addDataStoreReference('Store_Audit', 'Audit Log');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('triggeredByEvent="true"');
    expect(resultXml).toContain('isExpanded="true"');
    expect(resultXml).toContain('Gate_Severity');

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);

    expectSnapshotMatch(resultXml, '12-event-subprocess-internal-branching');
  });
});
