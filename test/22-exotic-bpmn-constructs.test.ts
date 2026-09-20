import { describe, it, expect } from 'vitest';
import { BpmnBuilder } from '../src/bpmn-builder';
import { layoutProcess } from '../src/index';
import { scoreDiagram } from '../src/layout-metrics';
import { expectSnapshotMatch } from './helpers/snapshot-helper';

function configureLevel3(sub3: BpmnBuilder): void {
  sub3
    .addStartEvent('Sub3_Start', 'L3 Init')
    .addTask('Task_Core_1', 'Execute Kernel Task A')
    .addTask('Task_Core_2', 'Execute Kernel Task B')
    .addEndEvent('Sub3_End', 'L3 Complete')
    .addSequenceFlow('F3_1', 'Sub3_Start', 'Task_Core_1')
    .addSequenceFlow('F3_2', 'Task_Core_1', 'Task_Core_2')
    .addSequenceFlow('F3_3', 'Task_Core_2', 'Sub3_End');
}

function configureLevel2(sub2: BpmnBuilder): void {
  sub2
    .addStartEvent('Sub2_Start', 'L2 Ingest')
    .addTask('Task_L3_Pre', 'L2 Validate')
    .addSubProcess('Sub_Level3', 'Level 3 Micro-Kernel', configureLevel3)
    .addTask('Task_L3_Post', 'L2 Consolidate')
    .addEndEvent('Sub2_End', 'L2 Complete')
    .addSequenceFlow('F2_1', 'Sub2_Start', 'Task_L3_Pre')
    .addSequenceFlow('F2_2', 'Task_L3_Pre', 'Sub_Level3')
    .addSequenceFlow('F2_3', 'Sub_Level3', 'Task_L3_Post')
    .addSequenceFlow('F2_4', 'Task_L3_Post', 'Sub2_End');
}

function configureLevel1(sub1: BpmnBuilder): void {
  sub1
    .addStartEvent('Sub1_Start', 'L1 Ingest')
    .addTask('Task_L2_Pre', 'L1 Processing')
    .addSubProcess('Sub_Level2', 'Level 2 Module Engine', configureLevel2)
    .addTask('Task_L2_Post', 'L1 Verify')
    .addEndEvent('Sub1_End', 'L1 Complete')
    .addSequenceFlow('F1_1', 'Sub1_Start', 'Task_L2_Pre')
    .addSequenceFlow('F1_2', 'Task_L2_Pre', 'Sub_Level2')
    .addSequenceFlow('F1_3', 'Sub_Level2', 'Task_L2_Post')
    .addSequenceFlow('F1_4', 'Task_L2_Post', 'Sub1_End');
}

describe('Iteration 16: Exotic BPMN Constructs & Realistic Complexity', () => {
  it('layouts event-based gateway with timer, message, and signal catch events', async () => {
    const builder = new BpmnBuilder('Process_EventGateway');
    builder
      .addStartEvent('Start_1', 'RFP Dispatched')
      .addTask('Task_SendQuote', 'Publish Tender Document')
      .addEventBasedGateway('Gate_Event', 'Wait for Response')
      // Branch 1: Message catch event
      .addIntermediateCatchEvent('Catch_Accept', 'Proposal Accepted', 'bpmn:MessageEventDefinition')
      .addTask('Task_BookOrder', 'Execute Contract')
      .addEndEvent('End_Booked', 'Contract Finalized')
      // Branch 2: Timer catch event
      .addIntermediateCatchEvent(
        'Catch_Timer',
        '14 Days Window Elapsed',
        'bpmn:TimerEventDefinition'
      )
      .addTask('Task_SendReminder', 'Send Escalation Notice')
      .addEndEvent('End_Reminder', 'Reminder Logged')
      // Branch 3: Signal catch event
      .addIntermediateCatchEvent('Catch_Reject', 'Vendor Withdrew', 'bpmn:SignalEventDefinition')
      .addTask('Task_Archive', 'Archive RFP Record')
      .addEndEvent('End_Archived', 'Procurement Closed')
      // Flows
      .addSequenceFlow('Flow_1', 'Start_1', 'Task_SendQuote')
      .addSequenceFlow('Flow_2', 'Task_SendQuote', 'Gate_Event')
      // Event Gateway branches
      .addSequenceFlow('Flow_Branch_1', 'Gate_Event', 'Catch_Accept')
      .addSequenceFlow('Flow_Branch_2', 'Gate_Event', 'Catch_Timer')
      .addSequenceFlow('Flow_Branch_3', 'Gate_Event', 'Catch_Reject')
      // Branch continuations
      .addSequenceFlow('Flow_Acc_1', 'Catch_Accept', 'Task_BookOrder')
      .addSequenceFlow('Flow_Acc_2', 'Task_BookOrder', 'End_Booked')
      .addSequenceFlow('Flow_Tim_1', 'Catch_Timer', 'Task_SendReminder')
      .addSequenceFlow('Flow_Tim_2', 'Task_SendReminder', 'End_Reminder')
      .addSequenceFlow('Flow_Rej_1', 'Catch_Reject', 'Task_Archive')
      .addSequenceFlow('Flow_Rej_2', 'Task_Archive', 'End_Archived');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('Gate_Event');
    expect(resultXml).toContain('Catch_Accept');
    expect(resultXml).toContain('messageEventDefinition');
    expect(resultXml).toContain('timerEventDefinition');
    expect(resultXml).toContain('signalEventDefinition');

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);

    expectSnapshotMatch(resultXml, '16-event-based-gateway-with-timers');
  });

  it('layouts sub-process with both interrupting error and non-interrupting timer boundary events', async () => {
    const builder = new BpmnBuilder('Process_BoundaryEscalation');
    builder
      .addStartEvent('Start_1', 'Order Ingested')
      .addTask('Task_Init', 'Validate Cart')
      .addSubProcess('Sub_PaymentProcessing', 'Payment Processing Pipeline', (sub) => {
        sub
          .addStartEvent('Sub_Start', 'Begin Charge')
          .addTask('Sub_Auth', 'Authorize Card')
          .addTask('Sub_Capture', 'Capture Funds')
          .addEndEvent('Sub_End', 'Charge Success')
          .addSequenceFlow('SF_1', 'Sub_Start', 'Sub_Auth')
          .addSequenceFlow('SF_2', 'Sub_Auth', 'Sub_Capture')
          .addSequenceFlow('SF_3', 'Sub_Capture', 'Sub_End');
      })
      // Boundary Event 1: Interrupting error boundary event
      .addBoundaryEvent({
        id: 'Boundary_PaymentError',
        attachedToRef: 'Sub_PaymentProcessing',
        name: 'Payment Failed',
        eventDefinitionType: 'bpmn:ErrorEventDefinition',
        cancelActivity: true,
      })
      .addTask('Task_Rollback', 'Rollback Reserved Stock')
      .addEndEvent('End_Failed', 'Order Terminated', 'bpmn:ErrorEventDefinition')
      // Boundary Event 2: Non-interrupting timer escalation boundary event
      .addBoundaryEvent({
        id: 'Boundary_SlowTimer',
        attachedToRef: 'Sub_PaymentProcessing',
        name: 'Gateway Latency SLA',
        eventDefinitionType: 'bpmn:TimerEventDefinition',
        cancelActivity: false,
      })
      .addTask('Task_NotifyOps', 'Alert Operations Team')
      // Normal flow continues to merge gateway
      .addExclusiveGateway('Gate_MergeDownstream', 'Sync Point')
      .addTask('Task_Confirm', 'Send Order Confirmation')
      .addEndEvent('End_Success', 'Order Fulfilled')
      // Sequence flows
      .addSequenceFlow('Flow_1', 'Start_1', 'Task_Init')
      .addSequenceFlow('Flow_2', 'Task_Init', 'Sub_PaymentProcessing')
      .addSequenceFlow('Flow_Normal', 'Sub_PaymentProcessing', 'Gate_MergeDownstream')
      .addSequenceFlow('Flow_Merge', 'Gate_MergeDownstream', 'Task_Confirm')
      .addSequenceFlow('Flow_Done', 'Task_Confirm', 'End_Success')
      // Error boundary flow
      .addSequenceFlow('Flow_Err', 'Boundary_PaymentError', 'Task_Rollback')
      .addSequenceFlow('Flow_Err_End', 'Task_Rollback', 'End_Failed')
      // Non-interrupting timer boundary flow rejoining
      .addSequenceFlow('Flow_Slow', 'Boundary_SlowTimer', 'Task_NotifyOps')
      .addSequenceFlow('Flow_Slow_Rejoin', 'Task_NotifyOps', 'Gate_MergeDownstream');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('Boundary_PaymentError');
    expect(resultXml).toContain('Boundary_SlowTimer');
    expect(resultXml).toContain('cancelActivity="false"');
    expect(resultXml).toContain('errorEventDefinition');

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);

    expectSnapshotMatch(resultXml, '16-subprocess-with-boundary-error-escalation');
  });

  it('layouts deeply nested three-level hierarchical sub-processes', async () => {
    const builder = new BpmnBuilder('Process_DeepNesting');
    builder
      .addStartEvent('Start_Root', 'Start Root')
      .addTask('Task_L1_Pre', 'Root Setup')
      .addSubProcess('Sub_Level1', 'Level 1 Architecture', configureLevel1)
      .addTask('Task_L1_Post', 'Root Teardown')
      .addEndEvent('End_Root', 'Finish Root')
      .addSequenceFlow('FRoot_1', 'Start_Root', 'Task_L1_Pre')
      .addSequenceFlow('FRoot_2', 'Task_L1_Pre', 'Sub_Level1')
      .addSequenceFlow('FRoot_3', 'Sub_Level1', 'Task_L1_Post')
      .addSequenceFlow('FRoot_4', 'Task_L1_Post', 'End_Root');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('Sub_Level1');
    expect(resultXml).toContain('Sub_Level2');
    expect(resultXml).toContain('Sub_Level3');

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);

    expectSnapshotMatch(resultXml, '16-deeply-nested-three-level-subprocess');
  });

  it('layouts real-world insurance claim orchestration across pools and lanes', async () => {
    const builder = new BpmnBuilder('Proc_Policyholder');
    builder
      .addParticipant('Pool_Policyholder', 'Proc_Policyholder', 'Policyholder')
      .addStartEvent('Cust_Start', 'Accident Occurs')
      .addTask('Cust_Submit', 'Submit Claim Dossier')
      .addEventBasedGateway('Cust_AwaitOutcome', 'Await Insurer Decision')
      .addIntermediateCatchEvent('Cust_WaitNotice', 'Receive Ineligibility Notice')
      .addIntermediateCatchEvent('Cust_ReceiveFunds', 'Receive Indemnity Payout')
      .addEndEvent('Cust_End_Denied', 'Coverage Denied')
      .addEndEvent('Cust_End_Paid', 'Claim Settled')
      .addSequenceFlow('CF_1', 'Cust_Start', 'Cust_Submit')
      .addSequenceFlow('CF_2', 'Cust_Submit', 'Cust_AwaitOutcome')
      .addSequenceFlow('CF_3', 'Cust_AwaitOutcome', 'Cust_WaitNotice')
      .addSequenceFlow('CF_4', 'Cust_WaitNotice', 'Cust_End_Denied')
      .addSequenceFlow('CF_5', 'Cust_AwaitOutcome', 'Cust_ReceiveFunds')
      .addSequenceFlow('CF_6', 'Cust_ReceiveFunds', 'Cust_End_Paid');

    builder
      .addProcess('Proc_Insurer', 'Insurance Enterprise')
      .addParticipant('Pool_Insurer', 'Proc_Insurer', 'Insurance Corporation')
      // Lane 1: Intake
      .addStartEvent('Ins_Start', 'Claim Notice Received')
      .addTask('Task_ValidatePolicy', 'Verify Coverage Eligibility')
      .addExclusiveGateway('Gate_ValidPolicy', 'Policy Active & In-Force?')
      .addTask('Task_RejectClaim', 'Issue Rejection Letter')
      .addEndEvent('End_ClaimRejected', 'Claim Ineligible')
      .addLane(
        'Lane_Intake',
        [
          'Ins_Start',
          'Task_ValidatePolicy',
          'Gate_ValidPolicy',
          'Task_RejectClaim',
          'End_ClaimRejected',
        ],
        'Claims Intake & Triage'
      )
      // Lane 2: Assessment
      .addTask('Task_AssignAdjuster', 'Assign Field Adjuster')
      .addSubProcess('Sub_Appraisal', 'Damage Appraisal & Forensics', (sub) => {
        sub
          .addStartEvent('Sub_ApprStart', 'Begin Inspection')
          .addTask('Sub_Inspect', 'Physical Damage Inspection')
          .addExclusiveGateway('Gate_Fraud', 'Fraud Flags Raised?')
          .addTask('Sub_FraudCheck', 'Special Investigation Audit')
          .addTask('Sub_Estimate', 'Calculate Repair Estimate')
          .addExclusiveGateway('Gate_FraudMerge', 'Audit Complete')
          .addEndEvent('Sub_ApprEnd', 'Appraisal Ready')
          .addSequenceFlow('AF_1', 'Sub_ApprStart', 'Sub_Inspect')
          .addSequenceFlow('AF_2', 'Sub_Inspect', 'Gate_Fraud')
          .addSequenceFlow({
            id: 'AF_3',
            sourceRef: 'Gate_Fraud',
            targetRef: 'Sub_FraudCheck',
            name: 'Flagged',
          })
          .addSequenceFlow({
            id: 'AF_4',
            sourceRef: 'Gate_Fraud',
            targetRef: 'Sub_Estimate',
            name: 'Clear',
          })
          .addSequenceFlow('AF_5', 'Sub_FraudCheck', 'Gate_FraudMerge')
          .addSequenceFlow('AF_6', 'Sub_Estimate', 'Gate_FraudMerge')
          .addSequenceFlow('AF_7', 'Gate_FraudMerge', 'Sub_ApprEnd');
      })
      .addBoundaryEvent({
        id: 'Boundary_Timeout',
        attachedToRef: 'Sub_Appraisal',
        name: 'Inspection Overdue SLA',
        eventDefinitionType: 'bpmn:TimerEventDefinition',
      })
      .addTask('Task_ExpediteReview', 'Desk Adjuster Fast-Track')
      .addLane(
        'Lane_Assessment',
        ['Task_AssignAdjuster', 'Sub_Appraisal', 'Boundary_Timeout', 'Task_ExpediteReview'],
        'Assessment & Appraisal'
      )
      // Lane 3: Settlement
      .addExclusiveGateway('Gate_Approval', 'Settlement Approved?')
      .addTask('Task_Disburse', 'Execute Wire Transfer')
      .addEndEvent('End_Settled', 'Claim Indemnified')
      .addLane(
        'Lane_Settlement',
        ['Gate_Approval', 'Task_Disburse', 'End_Settled'],
        'Settlement & Finance'
      )
      // Process flows
      .addSequenceFlow('IF_1', 'Ins_Start', 'Task_ValidatePolicy')
      .addSequenceFlow('IF_2', 'Task_ValidatePolicy', 'Gate_ValidPolicy')
      .addSequenceFlow({
        id: 'IF_NoPolicy',
        sourceRef: 'Gate_ValidPolicy',
        targetRef: 'Task_RejectClaim',
        name: 'No',
      })
      .addSequenceFlow('IF_RejectDone', 'Task_RejectClaim', 'End_ClaimRejected')
      .addSequenceFlow({
        id: 'IF_YesPolicy',
        sourceRef: 'Gate_ValidPolicy',
        targetRef: 'Task_AssignAdjuster',
        name: 'Yes',
      })
      .addSequenceFlow('IF_ToAppraisal', 'Task_AssignAdjuster', 'Sub_Appraisal')
      .addSequenceFlow('IF_ToApproval', 'Sub_Appraisal', 'Gate_Approval')
      .addSequenceFlow('IF_Timeout', 'Boundary_Timeout', 'Task_ExpediteReview')
      .addSequenceFlow('IF_ExpediteJoin', 'Task_ExpediteReview', 'Gate_Approval')
      .addSequenceFlow({
        id: 'IF_Approved',
        sourceRef: 'Gate_Approval',
        targetRef: 'Task_Disburse',
        name: 'Authorized',
      })
      .addSequenceFlow('IF_Disbursed', 'Task_Disburse', 'End_Settled');

    // Message flows across pools
    builder
      .addMessageFlow({
        id: 'MF_ClaimDoc',
        sourceRef: 'Cust_Submit',
        targetRef: 'Ins_Start',
        name: 'Loss Notice & Proof',
      })
      .addMessageFlow({
        id: 'MF_Rejection',
        sourceRef: 'Task_RejectClaim',
        targetRef: 'Cust_WaitNotice',
        name: 'Coverage Denial',
      })
      .addMessageFlow({
        id: 'MF_Wire',
        sourceRef: 'Task_Disburse',
        targetRef: 'Cust_ReceiveFunds',
        name: 'Direct Deposit Receipt',
      });

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('Pool_Policyholder');
    expect(resultXml).toContain('Pool_Insurer');
    expect(resultXml).toContain('Lane_Intake');
    expect(resultXml).toContain('Lane_Assessment');
    expect(resultXml).toContain('Lane_Settlement');
    expect(resultXml).toContain('Sub_Appraisal');
    expect(resultXml).toContain('Boundary_Timeout');
    expect(resultXml).toContain('MF_ClaimDoc');
    expect(resultXml).toContain('MF_Rejection');
    expect(resultXml).toContain('MF_Wire');

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);

    expectSnapshotMatch(resultXml, '16-real-world-insurance-claim');
  });
});
