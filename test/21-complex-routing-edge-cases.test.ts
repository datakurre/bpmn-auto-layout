import { describe, it, expect } from 'vitest';
import { BpmnBuilder } from '../src/bpmn-builder';
import { layoutProcess } from '../src/index';
import { scoreDiagram } from '../src/layout-metrics';
import { expectSnapshotMatch } from './helpers/snapshot-helper';

describe('Iteration 15: Complex Routing & Edge Cases', () => {
  it('layouts diamond-of-diamonds with nested split-join gateway hierarchy', async () => {
    const builder = new BpmnBuilder('Process_DiamondOfDiamonds');
    builder
      .addStartEvent('Start_1', 'Inbound Case')
      .addExclusiveGateway('Gate_Outer_Split', 'Triage Category')
      // Branch High Priority
      .addExclusiveGateway('Gate_High_Split', 'High Priority Track')
      .addTask('Task_High_Expedited', 'Expedited Processing')
      .addTask('Task_High_VIP', 'VIP Concierge Review')
      .addExclusiveGateway('Gate_High_Join', 'High Priority Merged')
      // Branch Standard Priority
      .addExclusiveGateway('Gate_Std_Split', 'Standard Track')
      .addTask('Task_Std_Auto', 'Automated Validation')
      .addTask('Task_Std_Manual', 'Manual Spot Check')
      .addExclusiveGateway('Gate_Std_Join', 'Standard Merged')
      // Outer Join
      .addExclusiveGateway('Gate_Outer_Join', 'All Tracks Merged')
      .addEndEvent('End_1', 'Triage Complete')
      // Connectors
      .addSequenceFlow('Flow_Start', 'Start_1', 'Gate_Outer_Split')
      .addSequenceFlow({
        id: 'Flow_To_High',
        sourceRef: 'Gate_Outer_Split',
        targetRef: 'Gate_High_Split',
        name: 'High',
      })
      .addSequenceFlow({
        id: 'Flow_To_Std',
        sourceRef: 'Gate_Outer_Split',
        targetRef: 'Gate_Std_Split',
        name: 'Standard',
      })
      // High branch flows
      .addSequenceFlow({
        id: 'Flow_High_Exp',
        sourceRef: 'Gate_High_Split',
        targetRef: 'Task_High_Expedited',
        name: 'Urgent',
      })
      .addSequenceFlow({
        id: 'Flow_High_Vip',
        sourceRef: 'Gate_High_Split',
        targetRef: 'Task_High_VIP',
        name: 'VIP',
      })
      .addSequenceFlow('Flow_High_Exp_Join', 'Task_High_Expedited', 'Gate_High_Join')
      .addSequenceFlow('Flow_High_Vip_Join', 'Task_High_VIP', 'Gate_High_Join')
      .addSequenceFlow('Flow_High_Out', 'Gate_High_Join', 'Gate_Outer_Join')
      // Std branch flows
      .addSequenceFlow({
        id: 'Flow_Std_Auto',
        sourceRef: 'Gate_Std_Split',
        targetRef: 'Task_Std_Auto',
        name: 'Low Risk',
      })
      .addSequenceFlow({
        id: 'Flow_Std_Manual',
        sourceRef: 'Gate_Std_Split',
        targetRef: 'Task_Std_Manual',
        name: 'Medium Risk',
      })
      .addSequenceFlow('Flow_Std_Auto_Join', 'Task_Std_Auto', 'Gate_Std_Join')
      .addSequenceFlow('Flow_Std_Manual_Join', 'Task_Std_Manual', 'Gate_Std_Join')
      .addSequenceFlow('Flow_Std_Out', 'Gate_Std_Join', 'Gate_Outer_Join')
      // Final flow
      .addSequenceFlow('Flow_End', 'Gate_Outer_Join', 'End_1');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('Gate_Outer_Split');
    expect(resultXml).toContain('Gate_Outer_Join');

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);

    expectSnapshotMatch(resultXml, '15-diamond-of-diamonds');
  });

  it('layouts parallel gateway with unequal branch depths including nested sub-process', async () => {
    const builder = new BpmnBuilder('Process_UnequalParallelBranches');
    builder
      .addStartEvent('Start_1', 'Trigger CI/CD')
      .addParallelGateway('Fork_Parallel', 'Fork Pipelines')
      // Branch 1: Single short task
      .addTask('Task_QuickCheck', 'Quick Smoke Test')
      // Branch 2: 4 sequential tasks
      .addTask('Task_Deep_1', 'Security Scan')
      .addTask('Task_Deep_2', 'Static Analysis')
      .addTask('Task_Deep_3', 'Performance Profiling')
      .addTask('Task_Deep_4', 'Compliance Audit')
      // Branch 3: Task + SubProcess + Task
      .addTask('Task_PrepData', 'Prepare Test Data')
      .addSubProcess('Sub_IntegrationTests', 'Integration Test Suite', (sub) => {
        sub
          .addStartEvent('Sub_Start', 'Suite Start')
          .addTask('Sub_Auth', 'Test Authentication')
          .addTask('Sub_Api', 'Test API Endpoints')
          .addTask('Sub_Db', 'Test Database Migrations')
          .addEndEvent('Sub_End', 'Suite Done')
          .addSequenceFlow('SF_1', 'Sub_Start', 'Sub_Auth')
          .addSequenceFlow('SF_2', 'Sub_Auth', 'Sub_Api')
          .addSequenceFlow('SF_3', 'Sub_Api', 'Sub_Db')
          .addSequenceFlow('SF_4', 'Sub_Db', 'Sub_End');
      })
      .addTask('Task_Teardown', 'Clean Up Resources')
      // Join
      .addParallelGateway('Join_Parallel', 'Sync Verification')
      .addEndEvent('End_AllDone', 'Deployment Approved')
      // Sequence flows
      .addSequenceFlow('Flow_Start', 'Start_1', 'Fork_Parallel')
      // Branch 1 flows
      .addSequenceFlow('Flow_B1_In', 'Fork_Parallel', 'Task_QuickCheck')
      .addSequenceFlow('Flow_B1_Out', 'Task_QuickCheck', 'Join_Parallel')
      // Branch 2 flows
      .addSequenceFlow('Flow_B2_1', 'Fork_Parallel', 'Task_Deep_1')
      .addSequenceFlow('Flow_B2_2', 'Task_Deep_1', 'Task_Deep_2')
      .addSequenceFlow('Flow_B2_3', 'Task_Deep_2', 'Task_Deep_3')
      .addSequenceFlow('Flow_B2_4', 'Task_Deep_3', 'Task_Deep_4')
      .addSequenceFlow('Flow_B2_Out', 'Task_Deep_4', 'Join_Parallel')
      // Branch 3 flows
      .addSequenceFlow('Flow_B3_1', 'Fork_Parallel', 'Task_PrepData')
      .addSequenceFlow('Flow_B3_2', 'Task_PrepData', 'Sub_IntegrationTests')
      .addSequenceFlow('Flow_B3_3', 'Sub_IntegrationTests', 'Task_Teardown')
      .addSequenceFlow('Flow_B3_Out', 'Task_Teardown', 'Join_Parallel')
      // Final flow
      .addSequenceFlow('Flow_Done', 'Join_Parallel', 'End_AllDone');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('Fork_Parallel');
    expect(resultXml).toContain('Join_Parallel');
    expect(resultXml).toContain('Sub_IntegrationTests');
    expect(resultXml).toContain('isExpanded="true"');

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);
    // #99: the dummy sweep used to shove this deep branch one track down, so
    // Task_Teardown's edge to the join crossed Task_Deep_3 -> Task_Deep_4.
    expect(score.metrics.edgeCrossings).toBe(0);
    const centerY = (id: string): number => {
      const m = new RegExp(
        `bpmnElement="${id}"[^>]*>\\s*<dc:Bounds x="[\\d.-]+" y="([\\d.-]+)" width="[\\d.-]+" height="([\\d.-]+)"`
      ).exec(resultXml)!;
      return Number(m[1]) + Number(m[2]) / 2;
    };
    const deepRow = centerY('Task_Deep_1');
    for (const id of ['Task_Deep_2', 'Task_Deep_3', 'Task_Deep_4']) {
      expect(centerY(id)).toBe(deepRow);
    }

    expectSnapshotMatch(resultXml, '15-parallel-with-unequal-branch-depth');
  });

  it('layouts backward loop edge spanning across an expanded sub-process', async () => {
    const builder = new BpmnBuilder('Process_BackwardEdgeOverSubProcess');
    builder
      .addStartEvent('Start_1', 'Job Requested')
      .addTask('Task_InitBatch', 'Initialize Batch Run')
      .addExclusiveGateway('Gate_LoopEntry', 'Batch Ready')
      .addSubProcess('Sub_BatchExecution', 'Batch Processing Pipeline', (sub) => {
        sub
          .addStartEvent('Sub_Start', 'Begin Batch')
          .addTask('Sub_Fetch', 'Fetch Records')
          .addTask('Sub_Transform', 'Transform Data')
          .addTask('Sub_Load', 'Load to Warehouse')
          .addEndEvent('Sub_End', 'Batch Complete')
          .addSequenceFlow('BF_1', 'Sub_Start', 'Sub_Fetch')
          .addSequenceFlow('BF_2', 'Sub_Fetch', 'Sub_Transform')
          .addSequenceFlow('BF_3', 'Sub_Transform', 'Sub_Load')
          .addSequenceFlow('BF_4', 'Sub_Load', 'Sub_End');
      })
      .addTask('Task_VerifyQuality', 'Verify Output Quality')
      .addExclusiveGateway('Gate_QualityCheck', 'Quality Passed?')
      .addEndEvent('End_Success', 'Batch Accepted')
      // Flows
      .addSequenceFlow('Flow_1', 'Start_1', 'Task_InitBatch')
      .addSequenceFlow('Flow_2', 'Task_InitBatch', 'Gate_LoopEntry')
      .addSequenceFlow('Flow_3', 'Gate_LoopEntry', 'Sub_BatchExecution')
      .addSequenceFlow('Flow_4', 'Sub_BatchExecution', 'Task_VerifyQuality')
      .addSequenceFlow('Flow_5', 'Task_VerifyQuality', 'Gate_QualityCheck')
      .addSequenceFlow({
        id: 'Flow_Pass',
        sourceRef: 'Gate_QualityCheck',
        targetRef: 'End_Success',
        name: 'Pass',
      })
      .addSequenceFlow({
        id: 'Flow_RetryLoop',
        sourceRef: 'Gate_QualityCheck',
        targetRef: 'Gate_LoopEntry',
        name: 'Retry Batch',
      });

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('Sub_BatchExecution');
    expect(resultXml).toContain('Flow_RetryLoop');

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);

    expectSnapshotMatch(resultXml, '15-backward-edge-over-subprocess');
  });

  it('layouts multiple end events with divergent paths from a shared prefix', async () => {
    const builder = new BpmnBuilder('Process_SharedPrefixMultipleEnds');
    builder
      .addStartEvent('Start_1', 'Onboarding Started')
      .addExclusiveGateway('Gate_Intake', 'Quick Screen')
      // Fast path abort
      .addEndEvent('End_ImmediateAbort', 'Immediate Abort', 'bpmn:TerminateEventDefinition')
      // Shared prefix tasks
      .addTask('Task_ValidateId', 'Validate Identity')
      .addTask('Task_AssessRisk', 'Assess Risk Score')
      .addExclusiveGateway('Gate_RiskOutcome', 'Risk Level?')
      // Success branch
      .addTask('Task_Activate', 'Activate Account')
      .addEndEvent('End_Success', 'Onboarding Complete')
      // Error / fraud branch
      .addTask('Task_FlagFraud', 'Flag For Financial Crimes')
      .addEndEvent('End_FraudError', 'Suspicious Activity Terminated', 'bpmn:ErrorEventDefinition')
      // Flows
      .addSequenceFlow('Flow_1', 'Start_1', 'Gate_Intake')
      .addSequenceFlow({
        id: 'Flow_Abort',
        sourceRef: 'Gate_Intake',
        targetRef: 'End_ImmediateAbort',
        name: 'Sanction Hit',
      })
      .addSequenceFlow({
        id: 'Flow_Proceed',
        sourceRef: 'Gate_Intake',
        targetRef: 'Task_ValidateId',
        name: 'Clear',
      })
      .addSequenceFlow('Flow_Prefix_1', 'Task_ValidateId', 'Task_AssessRisk')
      .addSequenceFlow('Flow_Prefix_2', 'Task_AssessRisk', 'Gate_RiskOutcome')
      .addSequenceFlow({
        id: 'Flow_Approved',
        sourceRef: 'Gate_RiskOutcome',
        targetRef: 'Task_Activate',
        name: 'Acceptable',
      })
      .addSequenceFlow({
        id: 'Flow_Rejected',
        sourceRef: 'Gate_RiskOutcome',
        targetRef: 'Task_FlagFraud',
        name: 'High Risk',
      })
      .addSequenceFlow('Flow_Act_End', 'Task_Activate', 'End_Success')
      .addSequenceFlow('Flow_Fraud_End', 'Task_FlagFraud', 'End_FraudError');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('terminateEventDefinition');
    expect(resultXml).toContain('errorEventDefinition');
    expect(resultXml).toContain('End_ImmediateAbort');
    expect(resultXml).toContain('End_Success');
    expect(resultXml).toContain('End_FraudError');

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);

    expectSnapshotMatch(resultXml, '15-multiple-end-events-with-shared-prefix');
  });
});
