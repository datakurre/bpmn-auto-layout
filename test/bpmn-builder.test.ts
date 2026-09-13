import { describe, it, expect } from 'vitest';
import { BpmnBuilder } from '../src/bpmn-builder';

describe('BpmnBuilder', () => {
  it('creates basic elements and accessors', async () => {
    const builder = new BpmnBuilder('Proc_A', 'Defs_A');
    expect(builder.getModdle()).toBeDefined();
    expect(builder.getDefinitions().id).toBe('Defs_A');
    expect(builder.getProcess().id).toBe('Proc_A');

    builder
      .addStartEvent('Start_1', 'Start')
      .addTask('Task_1', 'Work')
      .addExclusiveGateway('Gate_1', 'Choice')
      .addParallelGateway('Gate_2', 'Fork')
      .addInclusiveGateway('Gate_3', 'Multi')
      .addIntermediateCatchEvent('Catch_1', 'Wait')
      .addIntermediateThrowEvent('Throw_1', 'Signal')
      .addBoundaryEvent('Bound_1', 'Task_1', 'Error')
      .addEndEvent('End_1', 'Finish');

    const xml = await builder.toXml();
    expect(xml).toContain('Start_1');
    expect(xml).toContain('Task_1');
    expect(xml).toContain('Gate_1');
    expect(xml).toContain('Gate_2');
    expect(xml).toContain('Gate_3');
    expect(xml).toContain('Catch_1');
    expect(xml).toContain('Throw_1');
    expect(xml).toContain('Bound_1');
    expect(xml).toContain('End_1');
  });

  it('supports sequence flows with element references', async () => {
    const builder = new BpmnBuilder();
    builder
      .addStartEvent('Start_1')
      .addTask('Task_1')
      .addSequenceFlow('Flow_1', 'Start_1', 'Task_1')
      .addSequenceFlow('Flow_2', 'Task_1', 'Unregistered_Target');

    const xml = await builder.toXml();
    expect(xml).toContain('Flow_1');
    expect(xml).toContain('Flow_2');
  });

  it('supports boundary event with unregistered host', async () => {
    const builder = new BpmnBuilder();
    builder.addBoundaryEvent('Bound_1', 'Missing_Host');
    const xml = await builder.toXml();
    expect(xml).toContain('Bound_1');
  });

  it('supports nested sub-processes with configure callback', async () => {
    const builder = new BpmnBuilder();
    builder.addSubProcess('Sub_1', 'SubProcess', (sub) => {
      sub.addStartEvent('Sub_Start').addTask('Sub_Task').addEndEvent('Sub_End');
    });

    const xml = await builder.toXml();
    expect(xml).toContain('Sub_1');
    expect(xml).toContain('Sub_Start');
    expect(xml).toContain('Sub_Task');
    expect(xml).toContain('Sub_End');
  });

  it('supports sub-process without configure callback', async () => {
    const builder = new BpmnBuilder();
    builder.addSubProcess('Sub_Simple', 'Empty Sub');
    const xml = await builder.toXml();
    expect(xml).toContain('Sub_Simple');
  });

  it('supports lanes and laneSets', async () => {
    const builder = new BpmnBuilder();
    builder.addStartEvent('Start_1').addTask('Task_1');
    builder.addLane('Lane_1', ['Start_1', 'Task_1'], 'Lane One');
    builder.addLane('Lane_2', ['Unregistered_Node'], 'Lane Two');

    const xml = await builder.toXml();
    expect(xml).toContain('LaneSet');
    expect(xml).toContain('Lane_1');
    expect(xml).toContain('Lane_2');
  });

  it('supports collaborations, participants, and message flows', async () => {
    const builder = new BpmnBuilder('Process_1');
    builder.addTask('Task_1');
    builder.addParticipant('Participant_1', 'Process_1', 'Pool 1');
    builder.addParticipant('Participant_2', 'External_Process', 'Pool 2');
    builder.addMessageFlow({
      id: 'Msg_1',
      sourceRef: 'Task_1',
      targetRef: 'Participant_2',
      name: 'Invoice Message',
    });
    builder.addMessageFlow('Msg_2', 'Unknown_Src', 'Unknown_Tgt');

    const xml = await builder.toXml();
    expect(xml).toContain('Collaboration_1');
    expect(xml).toContain('Participant_1');
    expect(xml).toContain('Participant_2');
    expect(xml).toContain('Msg_1');
    expect(xml).toContain('name="Invoice Message"');
    expect(xml).toContain('Msg_2');
  });

  it('supports event definitions on start and end events', async () => {
    const builder = new BpmnBuilder();
    builder
      .addStartEvent('Start_Err', 'Error Start', 'bpmn:ErrorEventDefinition')
      .addEndEvent('End_Term', 'Terminate End', 'bpmn:TerminateEventDefinition');

    const xml = await builder.toXml();
    expect(xml).toContain('errorEventDefinition');
    expect(xml).toContain('terminateEventDefinition');
  });

  it('supports event sub-processes with and without callback', async () => {
    const builder = new BpmnBuilder();
    builder
      .addEventSubProcess('EventSub_1', 'Error Handler', (sub) => {
        sub.addStartEvent('Sub_Start', 'Err', 'bpmn:ErrorEventDefinition');
      })
      .addEventSubProcess('EventSub_Empty', 'Empty Event Sub');

    const xml = await builder.toXml();
    expect(xml).toContain('EventSub_1');
    expect(xml).toContain('triggeredByEvent="true"');
    expect(xml).toContain('EventSub_Empty');
  });

  it('supports ad-hoc sub-processes with and without callback', async () => {
    const builder = new BpmnBuilder();
    builder
      .addAdHocSubProcess('AdHoc_1', 'Review Checks', (sub) => {
        sub.addTask('Sub_Task_A', 'Check A');
      })
      .addAdHocSubProcess('AdHoc_Empty', 'Empty Ad-Hoc');

    const xml = await builder.toXml();
    expect(xml).toContain('AdHoc_1');
    expect(xml).toContain('adHocSubProcess');
    expect(xml).toContain('Sub_Task_A');
    expect(xml).toContain('AdHoc_Empty');
  });

  it('supports compensation task and compensation sub-process with and without callback', async () => {
    const builder = new BpmnBuilder();
    builder
      .addCompensationTask('CompTask_1', 'Cancel Booking')
      .addCompensationSubProcess('CompSub_1', 'Refund Process', (sub) => {
        sub.addTask('Sub_Task_A', 'Issue Refund');
      })
      .addCompensationSubProcess('CompSub_Empty', 'Empty Compensation Sub');

    const xml = await builder.toXml();
    expect(xml).toContain('CompTask_1');
    expect(xml).toContain('isForCompensation="true"');
    expect(xml).toContain('CompSub_1');
    expect(xml).toContain('Sub_Task_A');
    expect(xml).toContain('CompSub_Empty');
  });

  it('supports boundary event config with event definition and cancelActivity', async () => {
    const builder = new BpmnBuilder();
    builder
      .addTask('Task_1')
      .addBoundaryEvent({
        id: 'Bound_NonInterrupting',
        attachedToRef: 'Task_1',
        name: 'Escalation Timer',
        eventDefinitionType: 'bpmn:TimerEventDefinition',
        cancelActivity: false,
      })
      .addBoundaryEvent({
        id: 'Bound_Interrupting',
        attachedToRef: 'Task_1',
        cancelActivity: true,
      })
      .addBoundaryEvent({ id: 'Bound_Plain', attachedToRef: 'Task_1' });

    const xml = await builder.toXml();
    expect(xml).toContain('Bound_NonInterrupting');
    expect(xml).toContain('timerEventDefinition');
    expect(xml).toContain('cancelActivity="false"');
    expect(xml).toContain('Bound_Interrupting');
    expect(xml).toContain('Bound_Plain');
  });

  it('supports data objects, references, data stores, annotations, and associations', async () => {
    const builder = new BpmnBuilder();
    builder
      .addDataObject('DataObj_1', 'My Data')
      .addDataObjectReference('Doc_1', 'Document Ref', 'DataObj_1')
      .addDataObjectReference('Doc_Unreg', 'Unregistered Ref', 'Missing_DataObj')
      .addDataObjectReference('Doc_Direct', 'Direct Ref')
      .addDataStoreReference('Store_1', 'Database')
      .addTextAnnotation('Note_1', 'Some important note')
      .addTextAnnotation('Note_2', 'Second note')
      .addTask('Task_1')
      .addAssociation('Assoc_1', 'Doc_1', 'Task_1')
      .addAssociation('Assoc_2', 'Task_1', 'Unregistered_Tgt')
      .addAssociation('Assoc_3', 'Unregistered_Src', 'Task_1')
      .addAssociation('Assoc_4', 'Task_1', 'Doc_1');

    const xml = await builder.toXml();
    expect(xml).toContain('dataObject');
    expect(xml).toContain('dataObjectReference');
    expect(xml).toContain('dataStoreReference');
    expect(xml).toContain('textAnnotation');
    expect(xml).toContain('association');
    expect(xml).toContain('Assoc_1');
    expect(xml).toContain('Assoc_2');
    expect(xml).toContain('Assoc_3');
    expect(xml).toContain('Assoc_4');

    const freshBuilder = new BpmnBuilder();
    freshBuilder.addAssociation('Assoc_Fresh', 'S', 'T');
    const freshXml = await freshBuilder.toXml();
    expect(freshXml).toContain('Assoc_Fresh');
  });
});
