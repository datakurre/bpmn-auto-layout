import { describe, it, expect } from 'vitest';
import { BpmnBuilder } from '../src/bpmn-builder';
import { layoutProcess } from '../src/index';
import { scoreDiagram } from '../src/layout-metrics';
import { expectImageSnapshotMatch } from './helpers/snapshot-helper';

import { routeBoundaryExit } from '../src/hierarchy/boundary-events';

describe('Iteration 5: Boundary Events', () => {
  it('routes boundary exits cleanly around horizontal obstacles or when unblocked', () => {
    const src = { x: 100, y: 100, width: 36, height: 36 };
    const tgt = { x: 300, y: 220, width: 100, height: 80 };

    const unblockedNoObs = routeBoundaryExit(src, tgt);
    expect(unblockedNoObs.length).toBe(3);

    const unblockedEmpty = routeBoundaryExit(src, tgt, []);
    expect(unblockedEmpty.length).toBe(3);

    const obs = { x: 150, y: 250, width: 50, height: 40 };
    const detoured = routeBoundaryExit(src, tgt, [obs]);
    expect(detoured.length).toBe(5);

    const vObs = { x: 110, y: 150, width: 20, height: 30 };
    const vBlocked = routeBoundaryExit(src, tgt, [vObs]);
    expect(vBlocked.length).toBe(3);
  });

  it('layouts task with a boundary event and its exception flow', async () => {
    const builder = new BpmnBuilder();
    builder
      .addStartEvent('Start_1', 'Start')
      .addTask('Task_Main', 'Process Order')
      .addEndEvent('End_Main', 'Completed')
      .addBoundaryEvent('Boundary_Timer', 'Task_Main', '24h Timeout')
      .addTask('Task_Timeout', 'Escalate Delay')
      .addEndEvent('End_Timeout', 'Escalated')
      .addSequenceFlow('Flow_1', 'Start_1', 'Task_Main')
      .addSequenceFlow('Flow_2', 'Task_Main', 'End_Main')
      .addSequenceFlow('Flow_Exception', 'Boundary_Timer', 'Task_Timeout')
      .addSequenceFlow('Flow_3', 'Task_Timeout', 'End_Timeout');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);

    expectImageSnapshotMatch(resultXml, '05-boundary-event-single');
  });

  it('layouts task with multiple boundary events', async () => {
    const builder = new BpmnBuilder();
    builder
      .addStartEvent('Start_1', 'Start')
      .addTask('Task_Main', 'Call External API')
      .addEndEvent('End_Main', 'API Success')
      .addBoundaryEvent('Boundary_Error', 'Task_Main', '404 Error')
      .addBoundaryEvent('Boundary_Timer', 'Task_Main', 'Timeout')
      .addEndEvent('End_Error', 'Failed')
      .addEndEvent('End_Timeout', 'Timed Out')
      .addSequenceFlow('Flow_1', 'Start_1', 'Task_Main')
      .addSequenceFlow('Flow_2', 'Task_Main', 'End_Main')
      .addSequenceFlow('Flow_Err', 'Boundary_Error', 'End_Error')
      .addSequenceFlow('Flow_Time', 'Boundary_Timer', 'End_Timeout');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);

    expectImageSnapshotMatch(resultXml, '05-boundary-events-multiple');
  });
});
