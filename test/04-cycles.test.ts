import { describe, it, expect } from 'vitest';
import { BpmnBuilder } from '../src/bpmn-builder';
import { layoutProcess } from '../src/index';
import { scoreDiagram } from '../src/layout-metrics';
import { expectImageSnapshotMatch } from './helpers/snapshot-helper';

describe('Iteration 4: Cycles & Loops', () => {
  it('layouts task retry loop with clean orthogonal perimeter routing', async () => {
    const builder = new BpmnBuilder();
    builder
      .addStartEvent('Start_1', 'Start')
      .addTask('Task_A', 'Draft Document')
      .addTask('Task_B', 'Review Document')
      .addEndEvent('End_1', 'Published')
      .addSequenceFlow('Flow_1', 'Start_1', 'Task_A')
      .addSequenceFlow('Flow_2', 'Task_A', 'Task_B')
      .addSequenceFlow('Flow_Loop', 'Task_B', 'Task_A')
      .addSequenceFlow('Flow_3', 'Task_B', 'End_1');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);

    expectImageSnapshotMatch(resultXml, '04-retry-loop');
  });

  it('layouts gateway feedback loop back to an upstream task', async () => {
    const builder = new BpmnBuilder();
    builder
      .addStartEvent('Start_1', 'Start')
      .addTask('Task_Work', 'Execute Job')
      .addExclusiveGateway('Gate_Valid', 'Valid?')
      .addEndEvent('End_1', 'Success')
      .addSequenceFlow('Flow_1', 'Start_1', 'Task_Work')
      .addSequenceFlow('Flow_2', 'Task_Work', 'Gate_Valid')
      .addSequenceFlow('Flow_Pass', 'Gate_Valid', 'End_1')
      .addSequenceFlow('Flow_Retry', 'Gate_Valid', 'Task_Work');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);

    expectImageSnapshotMatch(resultXml, '04-gateway-loop');
  });
});
