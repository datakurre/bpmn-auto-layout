import { describe, it, expect } from 'vitest';
import { BpmnBuilder } from '../src/bpmn-builder';
import { layoutProcess } from '../src/index';
import { scoreDiagram } from '../src/layout-metrics';
import { expectSnapshotMatch } from './helpers/snapshot-helper';

describe('Iteration 9: Complex Workflows & High-Density Architectures', () => {
  it('layouts complete e-commerce order fulfillment with parallel checks, retry loop, and subprocess', async () => {
    const builder = new BpmnBuilder('Proc_Order');
    builder
      .addStartEvent('Start_Order', 'Order Received')
      .addTask('Task_Validate', 'Validate Order Data')
      .addParallelGateway('Split_Parallel', 'Split Checks')
      // Branch 1: Payment Verification & Decision
      .addTask('Task_Auth_Payment', 'Authorize Payment')
      .addExclusiveGateway('Gateway_Payment', 'Payment OK?')
      .addTask('Task_Payment_Failed', 'Notify Payment Failed')
      .addEndEvent('End_Order_Cancelled', 'Order Cancelled')
      // Branch 2: Inventory Evaluation & Feedback Retry Loop
      .addExclusiveGateway('Gateway_Stock_Merge', 'Stock Evaluation')
      .addTask('Task_Check_Stock', 'Check Inventory')
      .addExclusiveGateway('Gateway_Stock', 'In Stock?')
      .addTask('Task_Backorder', 'Request Backorder')
      .addTask('Task_Reserve_Stock', 'Reserve Items')
      // Join Parallel Branches
      .addParallelGateway('Join_Parallel', 'Sync Checks')
      // Embedded Expanded SubProcess: Fulfillment & Packing
      .addSubProcess('Sub_Fulfillment', 'Fulfillment & Packing', (sub) => {
        sub
          .addStartEvent('Sub_Start', 'Fulfillment Start')
          .addTask('Sub_Pick', 'Pick Items from Warehouse')
          .addTask('Sub_Pack', 'Package Goods')
          .addTask('Sub_Label', 'Print Shipping Label')
          .addEndEvent('Sub_End', 'Ready to Ship')
          .addSequenceFlow('SF1', 'Sub_Start', 'Sub_Pick')
          .addSequenceFlow('SF2', 'Sub_Pick', 'Sub_Pack')
          .addSequenceFlow('SF3', 'Sub_Pack', 'Sub_Label')
          .addSequenceFlow('SF4', 'Sub_Label', 'Sub_End');
      })
      // Post-Fulfillment Pipeline
      .addTask('Task_Update_ERP', 'Update ERP & Tracking')
      .addTask('Task_Notify_Customer', 'Send Shipment Notice')
      .addEndEvent('End_Order_Fulfilled', 'Order Delivered')
      // Sequence flows
      .addSequenceFlow('F1', 'Start_Order', 'Task_Validate')
      .addSequenceFlow('F2', 'Task_Validate', 'Split_Parallel')
      // Payment branch flows
      .addSequenceFlow('F_Pay_1', 'Split_Parallel', 'Task_Auth_Payment')
      .addSequenceFlow('F_Pay_2', 'Task_Auth_Payment', 'Gateway_Payment')
      .addSequenceFlow('F_Pay_Fail', 'Gateway_Payment', 'Task_Payment_Failed')
      .addSequenceFlow('F_Pay_Cancel', 'Task_Payment_Failed', 'End_Order_Cancelled')
      .addSequenceFlow('F_Pay_OK', 'Gateway_Payment', 'Join_Parallel')
      // Stock branch flows
      .addSequenceFlow('F_Stock_1', 'Split_Parallel', 'Gateway_Stock_Merge')
      .addSequenceFlow('F_Stock_To_Check', 'Gateway_Stock_Merge', 'Task_Check_Stock')
      .addSequenceFlow('F_Stock_2', 'Task_Check_Stock', 'Gateway_Stock')
      .addSequenceFlow('F_Stock_Wait', 'Gateway_Stock', 'Task_Backorder')
      .addSequenceFlow('F_Stock_Retry', 'Task_Backorder', 'Gateway_Stock_Merge')
      .addSequenceFlow('F_Stock_OK', 'Gateway_Stock', 'Task_Reserve_Stock')
      .addSequenceFlow('F_Stock_Join', 'Task_Reserve_Stock', 'Join_Parallel')
      // Downstream flows
      .addSequenceFlow('F_Sync', 'Join_Parallel', 'Sub_Fulfillment')
      .addSequenceFlow('F_Post_Sub', 'Sub_Fulfillment', 'Task_Update_ERP')
      .addSequenceFlow('F_ERP', 'Task_Update_ERP', 'Task_Notify_Customer')
      .addSequenceFlow('F_Done', 'Task_Notify_Customer', 'End_Order_Fulfilled');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);

    expectSnapshotMatch(resultXml, '09-order-fulfillment');
  });

  it('layouts 3-lane incident management with multi-directional cross-lane flows and boundary timer', async () => {
    const builder = new BpmnBuilder('Proc_Incident');
    builder
      .addParticipant('Pool_Incident', 'Proc_Incident', 'IT Incident Management')
      // Support lane
      .addStartEvent('Start_Incident', 'Incident Reported')
      .addTask('Task_Log', 'Log Incident')
      .addExclusiveGateway('Gateway_Merge_Triage', 'Triage Intake')
      .addTask('Task_Triage', 'Initial Triage')
      .addExclusiveGateway('Gateway_Can_Resolve', 'Can Resolve?')
      .addTask('Task_Provide_Fix', 'Provide Self-Service Fix')
      .addEndEvent('End_Resolved_T1', 'Resolved at T1')
      .addTask('Task_Customer_Update', 'Notify Customer of Release')
      .addEndEvent('End_Incident_Closed', 'Incident Closed')
      // Tier 2 lane
      .addTask('Task_Investigate', 'Investigate Root Cause')
      .addBoundaryEvent('Timer_SLA', 'Task_Investigate', '4h SLA Warning')
      .addTask('Task_Escalate_Lead', 'Escalate to Engineering Lead')
      .addExclusiveGateway('Gateway_Need_Info', 'Need Info?')
      .addTask('Task_Request_Clarify', 'Request Info from Support')
      .addExclusiveGateway('Gateway_Merge_Dev', 'Development Queue')
      .addTask('Task_Develop_Patch', 'Develop Bugfix Patch')
      // QA lane
      .addTask('Task_Run_QA', 'Run Regression Tests')
      .addExclusiveGateway('Gateway_QA_Pass', 'QA Passed?')
      .addTask('Task_Deploy_Hotfix', 'Deploy to Production')
      // Lane distribution
      .addLane(
        'Lane_Support',
        [
          'Start_Incident',
          'Task_Log',
          'Gateway_Merge_Triage',
          'Task_Triage',
          'Gateway_Can_Resolve',
          'Task_Provide_Fix',
          'End_Resolved_T1',
          'Task_Customer_Update',
          'End_Incident_Closed',
        ],
        'Tier 1 Support'
      )
      .addLane(
        'Lane_Tier2',
        [
          'Task_Investigate',
          'Timer_SLA',
          'Task_Escalate_Lead',
          'Gateway_Need_Info',
          'Task_Request_Clarify',
          'Gateway_Merge_Dev',
          'Task_Develop_Patch',
        ],
        'Tier 2 Engineering'
      )
      .addLane(
        'Lane_QA',
        ['Task_Run_QA', 'Gateway_QA_Pass', 'Task_Deploy_Hotfix'],
        'QA & Release Management'
      )
      // Sequence flows inside Support
      .addSequenceFlow('F_Inc_1', 'Start_Incident', 'Task_Log')
      .addSequenceFlow('F_Inc_2', 'Task_Log', 'Gateway_Merge_Triage')
      .addSequenceFlow('F_To_Triage', 'Gateway_Merge_Triage', 'Task_Triage')
      .addSequenceFlow('F_Inc_3', 'Task_Triage', 'Gateway_Can_Resolve')
      .addSequenceFlow('F_Inc_Fix', 'Gateway_Can_Resolve', 'Task_Provide_Fix')
      .addSequenceFlow('F_Inc_End1', 'Task_Provide_Fix', 'End_Resolved_T1')
      // Forward cross-lane: Support -> Tier 2
      .addSequenceFlow('F_Escalate_T2', 'Gateway_Can_Resolve', 'Task_Investigate')
      // Inside Tier 2
      .addSequenceFlow('F_SLA_Esc', 'Timer_SLA', 'Task_Escalate_Lead')
      .addSequenceFlow('F_Inv_Done', 'Task_Investigate', 'Gateway_Need_Info')
      .addSequenceFlow('F_Need_Info', 'Gateway_Need_Info', 'Task_Request_Clarify')
      .addSequenceFlow('F_Ready_Dev', 'Gateway_Need_Info', 'Gateway_Merge_Dev')
      .addSequenceFlow('F_To_Dev', 'Gateway_Merge_Dev', 'Task_Develop_Patch')
      // Rework cross-lane: Tier 2 -> Support
      .addSequenceFlow('F_Clarify_T1', 'Task_Request_Clarify', 'Gateway_Merge_Triage')
      // Forward cross-lane: Tier 2 -> QA
      .addSequenceFlow('F_To_QA', 'Task_Develop_Patch', 'Task_Run_QA')
      // Inside QA
      .addSequenceFlow('F_QA_Check', 'Task_Run_QA', 'Gateway_QA_Pass')
      // Rework cross-lane: QA -> Tier 2
      .addSequenceFlow('F_QA_Fail', 'Gateway_QA_Pass', 'Gateway_Merge_Dev')
      .addSequenceFlow('F_QA_OK', 'Gateway_QA_Pass', 'Task_Deploy_Hotfix')
      // Multi-lane jump cross-lane: QA -> Support
      .addSequenceFlow('F_Deploy_Notify', 'Task_Deploy_Hotfix', 'Task_Customer_Update')
      .addSequenceFlow('F_Close', 'Task_Customer_Update', 'End_Incident_Closed');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('id="Pool_Incident_di"');
    expect(resultXml).toContain('id="Lane_Support_di"');
    expect(resultXml).toContain('id="Lane_Tier2_di"');
    expect(resultXml).toContain('id="Lane_QA_di"');

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);

    expectSnapshotMatch(resultXml, '09-incident-management');
  });

  it('layouts multi-pool B2B procurement collaboration with cross-pool message flows', async () => {
    const builder = new BpmnBuilder('Proc_Buyer');
    builder
      // Pool 1: Buyer Organization
      .addParticipant('Pool_Buyer', 'Proc_Buyer', 'Buyer Enterprise')
      // Buyer Purchasing Lane
      .addStartEvent('Buyer_Start', 'Material Needed')
      .addTask('Buyer_Draft_PO', 'Draft Purchase Order')
      .addTask('Buyer_Review_Quote', 'Review Quotation')
      .addExclusiveGateway('Buyer_Gateway_Terms', 'Terms OK?')
      .addEndEvent('Buyer_Cancel_End', 'Procurement Cancelled')
      .addTask('Buyer_Receive_Notice', 'Acknowledge Shipment')
      .addTask('Buyer_Inspect_Goods', 'Inspect Received Goods')
      .addEndEvent('Buyer_End_Success', 'Procurement Completed')
      // Buyer Finance Lane
      .addTask('Buyer_Issue_Guarantee', 'Issue Payment Guarantee')
      .addTask('Buyer_Process_Invoice', 'Reconcile & Pay Invoice')
      .addLane(
        'Lane_Purchasing',
        [
          'Buyer_Start',
          'Buyer_Draft_PO',
          'Buyer_Review_Quote',
          'Buyer_Gateway_Terms',
          'Buyer_Cancel_End',
          'Buyer_Receive_Notice',
          'Buyer_Inspect_Goods',
          'Buyer_End_Success',
        ],
        'Purchasing Department'
      )
      .addLane(
        'Lane_Finance',
        ['Buyer_Issue_Guarantee', 'Buyer_Process_Invoice'],
        'Finance Department'
      )
      // Buyer sequence flows
      .addSequenceFlow('BF1', 'Buyer_Start', 'Buyer_Draft_PO')
      .addSequenceFlow('BF2', 'Buyer_Draft_PO', 'Buyer_Review_Quote')
      .addSequenceFlow('BF3', 'Buyer_Review_Quote', 'Buyer_Gateway_Terms')
      .addSequenceFlow('BF_Reject', 'Buyer_Gateway_Terms', 'Buyer_Cancel_End')
      .addSequenceFlow('BF_Cross_Finance', 'Buyer_Gateway_Terms', 'Buyer_Issue_Guarantee')
      .addSequenceFlow('BF_Await_Shipment', 'Buyer_Issue_Guarantee', 'Buyer_Receive_Notice')
      .addSequenceFlow('BF_Inspect', 'Buyer_Receive_Notice', 'Buyer_Inspect_Goods')
      .addSequenceFlow('BF_Cross_Pay', 'Buyer_Inspect_Goods', 'Buyer_Process_Invoice')
      .addSequenceFlow('BF_Complete', 'Buyer_Process_Invoice', 'Buyer_End_Success');

    // Pool 2: Supplier Organization
    builder
      .addProcess('Proc_Supplier', 'Supplier Partner Process')
      .addParticipant('Pool_Supplier', 'Proc_Supplier', 'Supplier Partner')
      // Supplier Sales Lane
      .addTask('Supplier_Check_Capacity', 'Assess Stock & Pricing')
      .addExclusiveGateway('Supplier_Gateway_Price', 'Price Changed?')
      .addTask('Supplier_Draft_Quote', 'Prepare Revised Quotation')
      .addTask('Supplier_Confirm_Order', 'Confirm Standard Order')
      // Supplier Logistics Lane
      .addExclusiveGateway('Supplier_Gateway_Produce_Merge', 'Order Approved')
      .addTask('Supplier_Produce', 'Manufacture & Pack Goods')
      .addTask('Supplier_Dispatch', 'Ship Consignment')
      .addTask('Supplier_Send_Invoice', 'Issue Final Invoice')
      .addEndEvent('Supplier_End', 'Order Executed')
      .addLane(
        'Lane_Sales',
        [
          'Supplier_Check_Capacity',
          'Supplier_Gateway_Price',
          'Supplier_Draft_Quote',
          'Supplier_Confirm_Order',
        ],
        'Sales Operations'
      )
      .addLane(
        'Lane_Logistics',
        [
          'Supplier_Gateway_Produce_Merge',
          'Supplier_Produce',
          'Supplier_Dispatch',
          'Supplier_Send_Invoice',
          'Supplier_End',
        ],
        'Logistics & Billing'
      )
      // Supplier sequence flows
      .addSequenceFlow('SF1', 'Supplier_Check_Capacity', 'Supplier_Gateway_Price')
      .addSequenceFlow('SF_Quote', 'Supplier_Gateway_Price', 'Supplier_Draft_Quote')
      .addSequenceFlow('SF_Std', 'Supplier_Gateway_Price', 'Supplier_Confirm_Order')
      .addSequenceFlow('SF_To_Prod_1', 'Supplier_Draft_Quote', 'Supplier_Gateway_Produce_Merge')
      .addSequenceFlow('SF_To_Prod_2', 'Supplier_Confirm_Order', 'Supplier_Gateway_Produce_Merge')
      .addSequenceFlow('SF_To_Produce', 'Supplier_Gateway_Produce_Merge', 'Supplier_Produce')
      .addSequenceFlow('SF_Dispatch', 'Supplier_Produce', 'Supplier_Dispatch')
      .addSequenceFlow('SF_Invoice', 'Supplier_Dispatch', 'Supplier_Send_Invoice')
      .addSequenceFlow('SF_Done', 'Supplier_Send_Invoice', 'Supplier_End')
      // Inter-pool collaboration message flows
      .addMessageFlow('Msg_PO', 'Buyer_Draft_PO', 'Supplier_Check_Capacity')
      .addMessageFlow('Msg_Quote', 'Supplier_Draft_Quote', 'Buyer_Review_Quote')
      .addMessageFlow('Msg_Confirm', 'Supplier_Confirm_Order', 'Buyer_Review_Quote')
      .addMessageFlow('Msg_Guarantee', 'Buyer_Issue_Guarantee', 'Supplier_Produce')
      .addMessageFlow('Msg_Shipment', 'Supplier_Dispatch', 'Buyer_Receive_Notice')
      .addMessageFlow('Msg_Invoice', 'Supplier_Send_Invoice', 'Buyer_Process_Invoice');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('id="Pool_Buyer_di"');
    expect(resultXml).toContain('id="Pool_Supplier_di"');
    expect(resultXml).toContain('id="Msg_PO_di"');
    expect(resultXml).toContain('id="Msg_Invoice_di"');

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);

    expectSnapshotMatch(resultXml, '09-b2b-procurement');
  });

  it('layouts multi-stage loan approval decision matrix with 6 gateways and multiple end events', async () => {
    const builder = new BpmnBuilder('Proc_Loan');
    builder
      .addStartEvent('Start_App', 'Loan Application')
      .addTask('Task_Intake', 'Verify Intake Form')
      // Gateway 1: Parallel Split into checks
      .addParallelGateway('Fork_Checks', 'Parallel Checks')
      .addTask('Task_KYC', 'Identity & AML Check')
      .addTask('Task_Credit_Bureau', 'Credit Bureau Inquiry')
      .addTask('Task_Income', 'Income Verification')
      // Gateway 2: Parallel Join checks
      .addParallelGateway('Join_Checks', 'Checks Synced')
      // Gateway 3: Multi-tier Risk Classification
      .addExclusiveGateway('Gateway_Risk_Tier', 'Risk Tier?')
      .addTask('Task_Fast_Approve', 'Standard Automated Approval')
      .addExclusiveGateway('Join_Decline', 'Reject Path')
      .addTask('Task_Fast_Decline', 'Automated Decline Notice')
      .addEndEvent('End_Declined', 'Application Rejected')
      // Manual Underwriting with SLA Boundary Timer
      .addExclusiveGateway('Join_Review', 'Underwriting Intake')
      .addTask('Task_Manual_Review', 'Manual Underwriting Review')
      .addBoundaryEvent('Timer_Review_SLA', 'Task_Manual_Review', '24h SLA')
      .addTask('Task_Expedite', 'Expedite to Senior Team')
      // Gateway 4: Senior Underwriter Decision
      .addExclusiveGateway('Gateway_Underwriter', 'Underwriter Decision')
      .addTask('Task_Request_Collateral', 'Negotiate Collateral')
      // Gateway 5: Merge Approvals
      .addExclusiveGateway('Join_Approve', 'Approve Branch')
      .addTask('Task_Prepare_Contract', 'Prepare Loan Agreement')
      .addEndEvent('End_Approved', 'Loan Disbursed')
      // Sequence flows
      .addSequenceFlow('LF1', 'Start_App', 'Task_Intake')
      .addSequenceFlow('LF2', 'Task_Intake', 'Fork_Checks')
      // Parallel checks
      .addSequenceFlow('LF_Check_1', 'Fork_Checks', 'Task_KYC')
      .addSequenceFlow('LF_Check_2', 'Fork_Checks', 'Task_Credit_Bureau')
      .addSequenceFlow('LF_Check_3', 'Fork_Checks', 'Task_Income')
      .addSequenceFlow('LF_Join_1', 'Task_KYC', 'Join_Checks')
      .addSequenceFlow('LF_Join_2', 'Task_Credit_Bureau', 'Join_Checks')
      .addSequenceFlow('LF_Join_3', 'Task_Income', 'Join_Checks')
      // Risk classification
      .addSequenceFlow('LF_To_Risk', 'Join_Checks', 'Gateway_Risk_Tier')
      .addSequenceFlow('LF_Low_Risk', 'Gateway_Risk_Tier', 'Task_Fast_Approve')
      .addSequenceFlow('LF_High_Risk', 'Gateway_Risk_Tier', 'Join_Decline')
      .addSequenceFlow('LF_Med_Risk', 'Gateway_Risk_Tier', 'Join_Review')
      .addSequenceFlow('LF_To_Decline', 'Join_Decline', 'Task_Fast_Decline')
      .addSequenceFlow('LF_Decline_End', 'Task_Fast_Decline', 'End_Declined')
      // SLA timer flow
      .addSequenceFlow('LF_SLA_Flow', 'Timer_Review_SLA', 'Task_Expedite')
      // Underwriting review
      .addSequenceFlow('LF_To_Review', 'Join_Review', 'Task_Manual_Review')
      .addSequenceFlow('LF_To_UW', 'Task_Manual_Review', 'Gateway_Underwriter')
      .addSequenceFlow('LF_UW_Approve', 'Gateway_Underwriter', 'Join_Approve')
      .addSequenceFlow('LF_UW_Decline', 'Gateway_Underwriter', 'Join_Decline')
      .addSequenceFlow('LF_UW_Cond', 'Gateway_Underwriter', 'Task_Request_Collateral')
      // Feedback loop from collateral back to underwriting
      .addSequenceFlow('LF_Loop_UW', 'Task_Request_Collateral', 'Join_Review')
      // Final preparation and disbursement
      .addSequenceFlow('LF_Auto_Approve', 'Task_Fast_Approve', 'Join_Approve')
      .addSequenceFlow('LF_Contract', 'Join_Approve', 'Task_Prepare_Contract')
      .addSequenceFlow('LF_Success_End', 'Task_Prepare_Contract', 'End_Approved');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);

    expectSnapshotMatch(resultXml, '09-loan-approval-matrix');
  });
});
