import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { BpmnBuilder } from '../src/bpmn-builder';
import { layoutProcess, layoutProcessWithDiagnostics } from '../src/index';
import { scoreDiagram, boxesOverlap } from '../src/layout-metrics';
import { expectImageSnapshotMatch } from './helpers/snapshot-helper';
import { routeBoundaryExit, ensureBoundariesAttached } from '../src/hierarchy/boundary-events';
import { alignIntraProcessBranches } from '../src/hierarchy/path-alignment';

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

  it('restores attachment for displaced boundary events', () => {
    const taskShape = {
      element: { id: 'Task_1', $type: 'bpmn:Task' },
      bounds: { x: 200, y: 150, width: 100, height: 80 },
    };
    const boundarySingle = {
      element: { id: 'BE_1', $type: 'bpmn:BoundaryEvent', attachedToRef: 'Task_1' },
      bounds: { x: 0, y: 0, width: 36, height: 36 },
    };
    ensureBoundariesAttached([taskShape, boundarySingle]);
    expect(boxesOverlap(boundarySingle.bounds, taskShape.bounds)).toBe(true);
    expect(boundarySingle.bounds.x).toBe(232);
    expect(boundarySingle.bounds.y).toBe(212);

    const boundaryMulti1 = {
      element: { id: 'BE_M1', $type: 'bpmn:BoundaryEvent', attachedToRef: 'Task_1' },
      bounds: { x: 50, y: 50, width: 36, height: 36 },
    };
    const boundaryMulti2 = {
      element: { id: 'BE_M2', $type: 'bpmn:BoundaryEvent', attachedToRef: 'Task_1' },
      bounds: { x: 500, y: 500, width: 36, height: 36 },
    };
    ensureBoundariesAttached([taskShape, boundaryMulti1, boundaryMulti2]);
    expect(boxesOverlap(boundaryMulti1.bounds, taskShape.bounds)).toBe(true);
    expect(boxesOverlap(boundaryMulti2.bounds, taskShape.bounds)).toBe(true);
    expect(boundaryMulti1.bounds.y).toBe(212);
    expect(boundaryMulti2.bounds.y).toBe(212);
    expect(boundaryMulti1.bounds.x).toBeLessThan(boundaryMulti2.bounds.x);

    const boundaryMissingHost = {
      element: { id: 'BE_Missing', $type: 'bpmn:BoundaryEvent', attachedToRef: 'Task_NonExistent' },
      bounds: { x: 0, y: 0, width: 36, height: 36 },
    };
    ensureBoundariesAttached([boundaryMissingHost]);
    expect(boundaryMissingHost.bounds.x).toBe(0);
  });

  it('shifts attached boundary events along with host task during intra-process branch alignment', () => {
    const process: any = {
      id: 'Proc_1',
      flowElements: [
        { id: 'Start_1', $type: 'bpmn:StartEvent' },
        { id: 'GW_Split', $type: 'bpmn:ExclusiveGateway' },
        { id: 'Task_Obs', $type: 'bpmn:Task' },
        { id: 'Task_Branch', $type: 'bpmn:Task' },
        { id: 'Boundary_1', $type: 'bpmn:BoundaryEvent', attachedToRef: 'Task_Branch' },
        { id: 'GW_Join', $type: 'bpmn:ExclusiveGateway' },
        { id: 'End_1', $type: 'bpmn:EndEvent' },
        {
          id: 'Flow_Direct',
          $type: 'bpmn:SequenceFlow',
          sourceRef: 'GW_Split',
          targetRef: 'GW_Join',
        },
        {
          id: 'Flow_ToBranch',
          $type: 'bpmn:SequenceFlow',
          sourceRef: 'GW_Split',
          targetRef: 'Task_Branch',
        },
        {
          id: 'Flow_FromBranch',
          $type: 'bpmn:SequenceFlow',
          sourceRef: 'Task_Branch',
          targetRef: 'GW_Join',
        },
        {
          id: 'Flow_FromBoundary',
          $type: 'bpmn:SequenceFlow',
          sourceRef: 'Boundary_1',
          targetRef: 'End_1',
        },
      ],
    };

    const taskBranchBounds = { x: 300, y: 300, width: 100, height: 80 };
    const boundaryBounds = { x: 332, y: 362, width: 36, height: 36 };

    const result: any = {
      minX: 100,
      minY: 100,
      width: 800,
      height: 600,
      shapes: [
        {
          element: { id: 'GW_Split', $type: 'bpmn:ExclusiveGateway' },
          bounds: { x: 200, y: 100, width: 50, height: 50 },
        },
        {
          element: { id: 'Task_Obs', $type: 'bpmn:Task' },
          bounds: { x: 200, y: 180, width: 100, height: 80 },
        },
        {
          element: { id: 'GW_Join', $type: 'bpmn:ExclusiveGateway' },
          bounds: { x: 600, y: 100, width: 50, height: 50 },
        },
        { element: { id: 'Task_Branch', $type: 'bpmn:Task' }, bounds: taskBranchBounds },
        {
          element: { id: 'Boundary_1', $type: 'bpmn:BoundaryEvent', attachedToRef: 'Task_Branch' },
          bounds: boundaryBounds,
        },
        {
          element: { id: 'End_1', $type: 'bpmn:EndEvent' },
          bounds: { x: 700, y: 400, width: 36, height: 36 },
        },
      ],
      edges: [
        {
          element: process.flowElements[7],
          waypoints: [
            { x: 250, y: 125 },
            { x: 600, y: 125 },
          ],
        },
        {
          element: process.flowElements[8],
          waypoints: [
            { x: 225, y: 150 },
            { x: 300, y: 340 },
          ],
        },
        {
          element: process.flowElements[9],
          waypoints: [
            { x: 400, y: 340 },
            { x: 625, y: 150 },
          ],
        },
        {
          element: process.flowElements[10],
          waypoints: [
            { x: 350, y: 398 },
            { x: 700, y: 418 },
          ],
        },
      ],
    };

    const initialXDiff = boundaryBounds.x - taskBranchBounds.x;
    alignIntraProcessBranches({ process, result });
    expect(boxesOverlap(boundaryBounds, taskBranchBounds)).toBe(true);
    expect(boundaryBounds.x - taskBranchBounds.x).toBe(initialXDiff);
  });

  it('never detaches boundary event when message flow connects to boundary event in collaboration', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="Defs_Coll" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:collaboration id="Collab_1">
    <bpmn:participant id="Pool_Receiver" name="Receiver Pool" processRef="Proc_Receiver" />
    <bpmn:participant id="Pool_Sender" name="Sender Pool" processRef="Proc_Sender" />
    <bpmn:messageFlow id="Msg_1" sourceRef="Task_Send" targetRef="Boundary_Catch" />
  </bpmn:collaboration>
  <bpmn:process id="Proc_Receiver" isExecutable="false">
    <bpmn:startEvent id="Start_R" />
    <bpmn:task id="Task_Recv" name="Process Task" />
    <bpmn:boundaryEvent id="Boundary_Catch" name="Timeout Catch" attachedToRef="Task_Recv" />
    <bpmn:task id="Task_Escalate" name="Escalate" />
    <bpmn:endEvent id="End_R" />
    <bpmn:endEvent id="End_Boundary" />
    <bpmn:sequenceFlow id="FR_1" sourceRef="Start_R" targetRef="Task_Recv" />
    <bpmn:sequenceFlow id="FR_2" sourceRef="Task_Recv" targetRef="End_R" />
    <bpmn:sequenceFlow id="FR_3" sourceRef="Boundary_Catch" targetRef="Task_Escalate" />
    <bpmn:sequenceFlow id="FR_4" sourceRef="Task_Escalate" targetRef="End_Boundary" />
  </bpmn:process>
  <bpmn:process id="Proc_Sender" isExecutable="false">
    <bpmn:startEvent id="Start_S" />
    <bpmn:task id="Task_Send" name="Send Request" />
    <bpmn:endEvent id="End_S" />
    <bpmn:sequenceFlow id="FS_1" sourceRef="Start_S" targetRef="Task_Send" />
    <bpmn:sequenceFlow id="FS_2" sourceRef="Task_Send" targetRef="End_S" />
  </bpmn:process>
</bpmn:definitions>`;

    const { xml: resultXml, warnings } = await layoutProcessWithDiagnostics(xml);
    expect(resultXml).toBeDefined();
    const detachedWarnings = warnings.filter((w) => w.code === 'DETACHED_BOUNDARY_EVENT');
    expect(detachedWarnings).toEqual([]);

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
  });

  it('keeps the publication retract boundary event attached to its review task', async () => {
    const xml = readFileSync(
      new URL('./fixtures/publication-boundary-message.bpmn', import.meta.url),
      'utf-8'
    );
    const { xml: resultXml, warnings } = await layoutProcessWithDiagnostics(xml);

    const detachedWarnings = warnings.filter((w) => w.code === 'DETACHED_BOUNDARY_EVENT');
    expect(detachedWarnings).toEqual([]);

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
  });
});
