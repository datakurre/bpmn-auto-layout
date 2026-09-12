import { describe, it, expect } from 'vitest';
import { BpmnBuilder } from '../src/bpmn-builder';
import { layoutProcess } from '../src/index';
import { scoreDiagram } from '../src/layout-metrics';
import { expectImageSnapshotMatch } from './helpers/snapshot-helper';

describe('Iteration 3: Branching & Gateways', () => {
  it('layouts symmetrical 2-way split and join with balanced tracks', async () => {
    const builder = new BpmnBuilder();
    builder
      .addStartEvent('Start_1', 'Start')
      .addExclusiveGateway('Split_1', 'Check')
      .addTask('Task_A', 'Approve')
      .addTask('Task_B', 'Reject')
      .addExclusiveGateway('Join_1', 'Merge')
      .addEndEvent('End_1', 'Finish')
      .addSequenceFlow('Flow_1', 'Start_1', 'Split_1')
      .addSequenceFlow('Flow_2', 'Split_1', 'Task_A')
      .addSequenceFlow('Flow_3', 'Split_1', 'Task_B')
      .addSequenceFlow('Flow_4', 'Task_A', 'Join_1')
      .addSequenceFlow('Flow_5', 'Task_B', 'Join_1')
      .addSequenceFlow('Flow_6', 'Join_1', 'End_1');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);
    expect(score.metrics.edgeCrossings).toBe(0);

    expectImageSnapshotMatch(resultXml, '03-symmetrical-split-join');
  });

  it('layouts 3-way split with center branch collinear to gateways', async () => {
    const builder = new BpmnBuilder();
    builder
      .addStartEvent('Start_1', 'Start')
      .addParallelGateway('Fork_1', 'Fork')
      .addTask('Task_Top', 'Email Customer')
      .addTask('Task_Mid', 'Update Inventory')
      .addTask('Task_Bot', 'Charge Card')
      .addParallelGateway('Join_1', 'Join')
      .addEndEvent('End_1', 'Finish')
      .addSequenceFlow('Flow_1', 'Start_1', 'Fork_1')
      .addSequenceFlow('Flow_2', 'Fork_1', 'Task_Top')
      .addSequenceFlow('Flow_3', 'Fork_1', 'Task_Mid')
      .addSequenceFlow('Flow_4', 'Fork_1', 'Task_Bot')
      .addSequenceFlow('Flow_5', 'Task_Top', 'Join_1')
      .addSequenceFlow('Flow_6', 'Task_Mid', 'Join_1')
      .addSequenceFlow('Flow_7', 'Task_Bot', 'Join_1')
      .addSequenceFlow('Flow_8', 'Join_1', 'End_1');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);
    expect(score.metrics.edgeCrossings).toBe(0);

    expectImageSnapshotMatch(resultXml, '03-three-way-split');
  });

  it('layouts asymmetric branches cleanly without edge-shape collisions', async () => {
    const builder = new BpmnBuilder();
    builder
      .addStartEvent('Start_1', 'Start')
      .addExclusiveGateway('Split_1', 'Branch')
      .addTask('Task_A1', 'Review Part 1')
      .addTask('Task_A2', 'Review Part 2')
      .addTask('Task_B1', 'Quick Fast-Track')
      .addExclusiveGateway('Join_1', 'Converge')
      .addEndEvent('End_1', 'Done')
      .addSequenceFlow('Flow_1', 'Start_1', 'Split_1')
      .addSequenceFlow('Flow_2', 'Split_1', 'Task_A1')
      .addSequenceFlow('Flow_3', 'Task_A1', 'Task_A2')
      .addSequenceFlow('Flow_4', 'Task_A2', 'Join_1')
      .addSequenceFlow('Flow_5', 'Split_1', 'Task_B1')
      .addSequenceFlow('Flow_6', 'Task_B1', 'Join_1')
      .addSequenceFlow('Flow_7', 'Join_1', 'End_1');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);

    expectImageSnapshotMatch(resultXml, '03-asymmetric-branches');
  });
});
