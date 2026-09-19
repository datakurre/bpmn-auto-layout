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
    const leftOutOfSpanObs = { x: 10, y: 250, width: 20, height: 40 };
    const rightOutOfSpanObs = { x: 400, y: 250, width: 20, height: 40 };
    const detoured = routeBoundaryExit(src, tgt, [obs, leftOutOfSpanObs, rightOutOfSpanObs]);
    expect(detoured.length).toBe(5);

    const vObs = { x: 110, y: 150, width: 20, height: 30 };
    const vBlocked = routeBoundaryExit(src, tgt, [vObs]);
    expect(vBlocked.length).toBe(5);

    // Vertical blocker where stepX >= tgtEntry.x falls back
    const farVObs = { x: 110, y: 150, width: 300, height: 30 };
    const vFallback = routeBoundaryExit(src, tgt, [farVObs]);
    expect(vFallback.length).toBe(3);

    // Backwards boundary exit (target to the left of source)
    const backTgt = { x: 50, y: 80, width: 50, height: 50 };
    const backUnblocked = routeBoundaryExit(src, backTgt, []);
    expect(backUnblocked.length).toBe(5);

    // Backwards boundary exit with drop blocker and lateral obstacles
    const dropObs = { x: 110, y: 150, width: 20, height: 30 };
    const leftObs = { x: 10, y: 100, width: 20, height: 50 };
    const rightObs = { x: 200, y: 100, width: 50, height: 50 };
    const backDropBlocked = routeBoundaryExit(src, backTgt, [leftObs, rightObs, dropObs]);
    expect(backDropBlocked.length).toBe(7);
  });

  it('layouts task with a boundary event flow targeting a gateway', async () => {
    const builder = new BpmnBuilder();
    builder
      .addStartEvent('Start_1', 'Start')
      .addTask('Task_Main', 'Process Order')
      .addExclusiveGateway('Gateway_Merge', 'Merge')
      .addEndEvent('End_1', 'Completed')
      .addBoundaryEvent('Boundary_Error', 'Task_Main', 'Error')
      .addSequenceFlow('Flow_1', 'Start_1', 'Task_Main')
      .addSequenceFlow('Flow_2', 'Task_Main', 'Gateway_Merge')
      .addSequenceFlow('Flow_3', 'Boundary_Error', 'Gateway_Merge')
      .addSequenceFlow('Flow_4', 'Gateway_Merge', 'End_1');

    const xml = await builder.toXml();
    const resultXml = await layoutProcess(xml);
    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
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

  it('aligns dedicated end event directly underneath single boundary event on task', async () => {
    const builder = new BpmnBuilder();
    builder
      .addStartEvent('Start_1', 'Start')
      .addTask('Task_Main', 'Process Payment')
      .addEndEvent('End_Main', 'Success')
      .addBoundaryEvent('Boundary_Timeout', 'Task_Main', 'Timeout')
      .addEndEvent('End_Timeout', 'Timed Out')
      .addSequenceFlow('Flow_1', 'Start_1', 'Task_Main')
      .addSequenceFlow('Flow_2', 'Task_Main', 'End_Main')
      .addSequenceFlow('Flow_Timeout', 'Boundary_Timeout', 'End_Timeout');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);
    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.metrics.edgeCrossings).toBe(0);
  });

  it('skips aligning terminal boundary rank when host is a subprocess', async () => {
    const builder = new BpmnBuilder();
    builder
      .addStartEvent('Start_1', 'Start')
      .addSubProcess('Sub_1', 'Sub', (sub) => {
        sub
          .addStartEvent('Sub_Start', 'Start')
          .addTask('Sub_Task', 'Work')
          .addEndEvent('Sub_End', 'End')
          .addSequenceFlow('SF_1', 'Sub_Start', 'Sub_Task')
          .addSequenceFlow('SF_2', 'Sub_Task', 'Sub_End');
      })
      .addEndEvent('End_1', 'Done')
      .addBoundaryEvent('Sub_Boundary', 'Sub_1', 'Error')
      .addEndEvent('End_Sub_Error', 'Sub Error')
      .addSequenceFlow('Flow_1', 'Start_1', 'Sub_1')
      .addSequenceFlow('Flow_2', 'Sub_1', 'End_1')
      .addSequenceFlow('Flow_Err', 'Sub_Boundary', 'End_Sub_Error');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);
    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
  });
});
