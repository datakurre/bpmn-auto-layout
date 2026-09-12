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
      .addBoundaryEvent('Bound_1', 'Task_1', 'Error')
      .addEndEvent('End_1', 'Finish');

    const xml = await builder.toXml();
    expect(xml).toContain('Start_1');
    expect(xml).toContain('Task_1');
    expect(xml).toContain('Gate_1');
    expect(xml).toContain('Gate_2');
    expect(xml).toContain('Gate_3');
    expect(xml).toContain('Catch_1');
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
    builder.addMessageFlow('Msg_1', 'Task_1', 'Participant_2');
    builder.addMessageFlow('Msg_2', 'Unknown_Src', 'Unknown_Tgt');

    const xml = await builder.toXml();
    expect(xml).toContain('Collaboration_1');
    expect(xml).toContain('Participant_1');
    expect(xml).toContain('Participant_2');
    expect(xml).toContain('Msg_1');
    expect(xml).toContain('Msg_2');
  });
});
