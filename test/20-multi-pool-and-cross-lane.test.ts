import { describe, it, expect } from 'vitest';
import { BpmnBuilder } from '../src/bpmn-builder';
import { layoutProcess } from '../src/index';
import { scoreDiagram } from '../src/layout-metrics';
import { expectSnapshotMatch } from './helpers/snapshot-helper';

describe('Iteration 14: Multi-Pool & Cross-Lane Stress', () => {
  it('layouts 3-pool message choreography with cross-pool message flows', async () => {
    const builder = new BpmnBuilder('Proc_Customer');
    builder
      .addParticipant('Pool_Customer', 'Proc_Customer', 'Customer')
      .addStartEvent('Cust_Start', 'Browse Catalog')
      .addTask('Cust_Order', 'Place Order')
      .addIntermediateCatchEvent('Cust_Wait', 'Order Confirmation')
      .addTask('Cust_Pay', 'Authorize Payment')
      .addEndEvent('Cust_Done', 'Order Complete')
      .addSequenceFlow('CF_1', 'Cust_Start', 'Cust_Order')
      .addSequenceFlow('CF_2', 'Cust_Order', 'Cust_Wait')
      .addSequenceFlow('CF_3', 'Cust_Wait', 'Cust_Pay')
      .addSequenceFlow('CF_4', 'Cust_Pay', 'Cust_Done');

    builder
      .addProcess('Proc_Order', 'Order Fulfillment')
      .addParticipant('Pool_Order', 'Proc_Order', 'Order Fulfillment')
      .addStartEvent('Order_Start', 'Receive Request')
      .addTask('Order_Verify', 'Check Inventory')
      .addExclusiveGateway('Order_Split', 'In Stock?')
      .addTask('Order_Reserve', 'Reserve Stock')
      .addTask('Order_Procure', 'Trigger Backorder')
      .addExclusiveGateway('Order_Join', 'Stock Ready')
      .addTask('Order_Invoice', 'Issue Invoice')
      .addTask('Order_Ship', 'Dispatch Goods')
      .addEndEvent('Order_End', 'Fulfillment Complete')
      .addSequenceFlow('OF_1', 'Order_Start', 'Order_Verify')
      .addSequenceFlow('OF_2', 'Order_Verify', 'Order_Split')
      .addSequenceFlow({
        id: 'OF_3',
        sourceRef: 'Order_Split',
        targetRef: 'Order_Reserve',
        name: 'Yes',
      })
      .addSequenceFlow({
        id: 'OF_4',
        sourceRef: 'Order_Split',
        targetRef: 'Order_Procure',
        name: 'No',
      })
      .addSequenceFlow('OF_5', 'Order_Reserve', 'Order_Join')
      .addSequenceFlow('OF_6', 'Order_Procure', 'Order_Join')
      .addSequenceFlow('OF_7', 'Order_Join', 'Order_Invoice')
      .addSequenceFlow('OF_8', 'Order_Invoice', 'Order_Ship')
      .addSequenceFlow('OF_9', 'Order_Ship', 'Order_End');

    builder
      .addProcess('Proc_Payment', 'Payment Gateway')
      .addParticipant('Pool_Payment', 'Proc_Payment', 'Payment Gateway')
      .addStartEvent('Pay_Start', 'Payment Request')
      .addTask('Pay_Process', 'Charge Account')
      .addExclusiveGateway('Pay_Gate', 'Authorized?')
      .addTask('Pay_Receipt', 'Generate Receipt')
      .addTask('Pay_Decline', 'Record Decline')
      .addExclusiveGateway('Pay_Merge', 'Outcome Logged')
      .addEndEvent('Pay_End', 'Payment Finalized')
      .addSequenceFlow('PF_1', 'Pay_Start', 'Pay_Process')
      .addSequenceFlow('PF_2', 'Pay_Process', 'Pay_Gate')
      .addSequenceFlow({
        id: 'PF_3',
        sourceRef: 'Pay_Gate',
        targetRef: 'Pay_Receipt',
        name: 'Approved',
      })
      .addSequenceFlow({
        id: 'PF_4',
        sourceRef: 'Pay_Gate',
        targetRef: 'Pay_Decline',
        name: 'Declined',
      })
      .addSequenceFlow('PF_5', 'Pay_Receipt', 'Pay_Merge')
      .addSequenceFlow('PF_6', 'Pay_Decline', 'Pay_Merge')
      .addSequenceFlow('PF_7', 'Pay_Merge', 'Pay_End');

    builder
      .addMessageFlow({
        id: 'MF_Order_Req',
        sourceRef: 'Cust_Order',
        targetRef: 'Order_Start',
        name: 'Purchase Order',
      })
      .addMessageFlow({
        id: 'MF_Invoice',
        sourceRef: 'Order_Invoice',
        targetRef: 'Cust_Wait',
        name: 'Invoice Details',
      })
      .addMessageFlow({
        id: 'MF_Pay_Auth',
        sourceRef: 'Cust_Pay',
        targetRef: 'Pay_Start',
        name: 'Payment Authorization',
      })
      .addMessageFlow({
        id: 'MF_Receipt',
        sourceRef: 'Pay_Receipt',
        targetRef: 'Order_Ship',
        name: 'Payment Notification',
      })
      .addMessageFlow({
        id: 'MF_Shipment',
        sourceRef: 'Order_Ship',
        targetRef: 'Cust_Done',
        name: 'Shipping Notice',
      });

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('Pool_Customer');
    expect(resultXml).toContain('Pool_Order');
    expect(resultXml).toContain('Pool_Payment');
    expect(resultXml).toContain('MF_Order_Req');
    expect(resultXml).toContain('MF_Invoice');
    expect(resultXml).toContain('MF_Pay_Auth');
    expect(resultXml).toContain('MF_Receipt');
    expect(resultXml).toContain('MF_Shipment');

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);

    expectSnapshotMatch(resultXml, '14-multi-pool-message-choreography');
  });

  it('layouts a 4-lane pool with cross-lane sequence flows and backward rework loops', async () => {
    const builder = new BpmnBuilder('Process_Procurement');
    builder
      .addParticipant('Pool_Procurement', 'Process_Procurement', 'Enterprise Procurement')
      .addStartEvent('Start_Req', 'Request Needed')
      .addTask('Task_CreateReq', 'Draft Purchase Request')
      .addExclusiveGateway('Gate_Revise', 'Revise?')
      .addEndEvent('End_Cancel', 'Request Cancelled')
      .addEndEvent('End_Success', 'Order Fulfilled')
      .addLane(
        'Lane_Requester',
        ['Start_Req', 'Task_CreateReq', 'Gate_Revise', 'End_Cancel', 'End_Success'],
        'Requester'
      )
      .addTask('Task_ManagerReview', 'Manager Review')
      .addExclusiveGateway('Gate_Approve', 'Approved?')
      .addLane('Lane_Approver', ['Task_ManagerReview', 'Gate_Approve'], 'Approver')
      .addTask('Task_BudgetCheck', 'Verify Budget')
      .addExclusiveGateway('Gate_BudgetOk', 'Funds Available?')
      .addLane('Lane_Finance', ['Task_BudgetCheck', 'Gate_BudgetOk'], 'Finance')
      .addTask('Task_ProvisionHardware', 'Procure Hardware')
      .addTask('Task_AssignLicenses', 'Configure Licenses')
      .addLane('Lane_IT', ['Task_ProvisionHardware', 'Task_AssignLicenses'], 'IT Operations')
      .addSequenceFlow('Flow_1', 'Start_Req', 'Task_CreateReq')
      .addSequenceFlow('Flow_2', 'Task_CreateReq', 'Task_ManagerReview')
      .addSequenceFlow('Flow_3', 'Task_ManagerReview', 'Gate_Approve')
      .addSequenceFlow({
        id: 'Flow_Reject_Mgr',
        sourceRef: 'Gate_Approve',
        targetRef: 'Gate_Revise',
        name: 'Rejected',
      })
      .addSequenceFlow({
        id: 'Flow_Mgr_Appr',
        sourceRef: 'Gate_Approve',
        targetRef: 'Task_BudgetCheck',
        name: 'Approved',
      })
      .addSequenceFlow({
        id: 'Flow_Resubmit',
        sourceRef: 'Gate_Revise',
        targetRef: 'Task_CreateReq',
        name: 'Resubmit',
      })
      .addSequenceFlow({
        id: 'Flow_Abort',
        sourceRef: 'Gate_Revise',
        targetRef: 'End_Cancel',
        name: 'Abort',
      })
      .addSequenceFlow('Flow_Fin_1', 'Task_BudgetCheck', 'Gate_BudgetOk')
      .addSequenceFlow({
        id: 'Flow_Fin_Ok',
        sourceRef: 'Gate_BudgetOk',
        targetRef: 'Task_ProvisionHardware',
        name: 'Yes',
      })
      .addSequenceFlow({
        id: 'Flow_Fin_No',
        sourceRef: 'Gate_BudgetOk',
        targetRef: 'Gate_Revise',
        name: 'No Budget',
      })
      .addSequenceFlow('Flow_IT_1', 'Task_ProvisionHardware', 'Task_AssignLicenses')
      .addSequenceFlow('Flow_IT_Done', 'Task_AssignLicenses', 'End_Success');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('id="Lane_Requester_di"');
    expect(resultXml).toContain('id="Lane_Approver_di"');
    expect(resultXml).toContain('id="Lane_Finance_di"');
    expect(resultXml).toContain('id="Lane_IT_di"');

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);

    expectSnapshotMatch(resultXml, '14-four-lane-cross-lane-routing');
  });

  it('layouts a pool with 2 lanes containing an expanded sub-process and inter-pool message flows', async () => {
    const builder = new BpmnBuilder('Proc_Client');
    builder
      .addParticipant('Pool_Client', 'Proc_Client', 'Client')
      .addStartEvent('Client_Start', 'Project Needed')
      .addTask('Client_Inquire', 'Send Request for Quote')
      .addIntermediateCatchEvent('Client_WaitQuote', 'Receive Proposal')
      .addEndEvent('Client_End', 'Decision Made')
      .addSequenceFlow('CF_1', 'Client_Start', 'Client_Inquire')
      .addSequenceFlow('CF_2', 'Client_Inquire', 'Client_WaitQuote')
      .addSequenceFlow('CF_3', 'Client_WaitQuote', 'Client_End');

    builder
      .addProcess('Proc_Vendor', 'Vendor Solution')
      .addParticipant('Pool_Vendor', 'Proc_Vendor', 'Vendor Delivery')
      .addStartEvent('V_Start', 'Quote Request Ingested')
      .addTask('V_Intake', 'Validate Scope')
      .addSubProcess('V_SubQuote', 'Estimation & Costing', (sub) => {
        sub
          .addStartEvent('Sub_Start', 'Begin Calc')
          .addTask('Sub_Gather', 'Compile Bill of Materials')
          .addTask('Sub_Margin', 'Apply Pricing Margin')
          .addEndEvent('Sub_End', 'Pricing Ready')
          .addSequenceFlow('SF_1', 'Sub_Start', 'Sub_Gather')
          .addSequenceFlow('SF_2', 'Sub_Gather', 'Sub_Margin')
          .addSequenceFlow('SF_3', 'Sub_Margin', 'Sub_End');
      })
      .addTask('V_DeliverQuote', 'Publish Formal Proposal')
      .addEndEvent('V_End', 'Proposal Archived')
      .addLane(
        'Lane_Sales',
        ['V_Start', 'V_Intake', 'V_SubQuote', 'V_DeliverQuote', 'V_End'],
        'Commercial Sales'
      )
      .addTask('V_EstimateLabor', 'Engineering Effort Review')
      .addTask('V_CheckParts', 'Supply Chain Check')
      .addLane('Lane_Ops', ['V_EstimateLabor', 'V_CheckParts'], 'Technical Operations')
      .addSequenceFlow('VF_1', 'V_Start', 'V_Intake')
      .addSequenceFlow('VF_2', 'V_Intake', 'V_EstimateLabor')
      .addSequenceFlow('VF_3', 'V_EstimateLabor', 'V_CheckParts')
      .addSequenceFlow('VF_4', 'V_CheckParts', 'V_SubQuote')
      .addSequenceFlow('VF_5', 'V_SubQuote', 'V_DeliverQuote')
      .addSequenceFlow('VF_6', 'V_DeliverQuote', 'V_End');

    builder
      .addMessageFlow({
        id: 'MF_Inquiry',
        sourceRef: 'Client_Inquire',
        targetRef: 'V_Start',
        name: 'RFP Submission',
      })
      .addMessageFlow({
        id: 'MF_Proposal',
        sourceRef: 'V_DeliverQuote',
        targetRef: 'Client_WaitQuote',
        name: 'Commercial Proposal',
      });

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('id="Lane_Sales_di"');
    expect(resultXml).toContain('id="Lane_Ops_di"');
    expect(resultXml).toContain('id="V_SubQuote_di"');
    expect(resultXml).toContain('isExpanded="true"');

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);

    expectSnapshotMatch(resultXml, '14-pool-with-subprocess-and-lanes');
  });
});
