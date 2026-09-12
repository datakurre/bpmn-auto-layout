import { describe, it, expect } from 'vitest';
import { BpmnBuilder } from '../src/bpmn-builder';
import { layoutProcess } from '../src/index';
import { scoreDiagram } from '../src/layout-metrics';
import { expectImageSnapshotMatch } from './helpers/snapshot-helper';

describe('Iteration 2: Linear Sequences', () => {
  it('layouts Start -> End with collinear centers and straight 0-bend edge', async () => {
    const builder = new BpmnBuilder();
    builder
      .addStartEvent('Start_1', 'Start')
      .addEndEvent('End_1', 'Finish')
      .addSequenceFlow('Flow_1', 'Start_1', 'End_1');
    const inputXml = await builder.toXml();

    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('<bpmndi:BPMNEdge id="Flow_1_di" bpmnElement="Flow_1">');

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);
    expect(score.metrics.totalBends).toBe(0);

    expectImageSnapshotMatch(resultXml, '02-start-end');
  });

  it('layouts Start -> Task -> End with collinear centers and zero bends', async () => {
    const builder = new BpmnBuilder();
    builder
      .addStartEvent('Start_1', 'Start')
      .addTask('Task_1', 'Handle Request')
      .addEndEvent('End_1', 'Finish')
      .addSequenceFlow('Flow_1', 'Start_1', 'Task_1')
      .addSequenceFlow('Flow_2', 'Task_1', 'End_1');
    const inputXml = await builder.toXml();

    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('<bpmndi:BPMNEdge id="Flow_1_di" bpmnElement="Flow_1">');
    expect(resultXml).toContain('<bpmndi:BPMNEdge id="Flow_2_di" bpmnElement="Flow_2">');

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);
    expect(score.metrics.totalBends).toBe(0);

    expectImageSnapshotMatch(resultXml, '02-start-task-end');
  });

  it('layouts a 5-element mixed chain with straight collinear connections', async () => {
    const builder = new BpmnBuilder();
    builder
      .addStartEvent('Start_1', 'Start')
      .addTask('Task_1', 'Step 1')
      .addIntermediateCatchEvent('Catch_1', 'Wait Timer')
      .addTask('Task_2', 'Step 2')
      .addEndEvent('End_1', 'Done')
      .addSequenceFlow('Flow_1', 'Start_1', 'Task_1')
      .addSequenceFlow('Flow_2', 'Task_1', 'Catch_1')
      .addSequenceFlow('Flow_3', 'Catch_1', 'Task_2')
      .addSequenceFlow('Flow_4', 'Task_2', 'End_1');
    const inputXml = await builder.toXml();

    const resultXml = await layoutProcess(inputXml);

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);
    expect(score.metrics.totalBends).toBe(0);

    expectImageSnapshotMatch(resultXml, '02-five-nodes-chain');
  });
});
