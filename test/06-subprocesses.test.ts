import { describe, it, expect } from 'vitest';
import { BpmnBuilder } from '../src/bpmn-builder';
import { layoutProcess } from '../src/index';
import { scoreDiagram } from '../src/layout-metrics';
import { expectImageSnapshotMatch } from './helpers/snapshot-helper';

describe('Iteration 6: Recursive Expanded Sub-Processes', () => {
  it('layouts an expanded subprocess with internal flow and parent flow', async () => {
    const builder = new BpmnBuilder();
    builder
      .addStartEvent('Start_Parent', 'Start')
      .addSubProcess('Sub_Order', 'Order Fulfillment', (sub) => {
        sub
          .addStartEvent('Sub_Start', 'Order Placed')
          .addTask('Sub_Task', 'Pack Items')
          .addEndEvent('Sub_End', 'Items Packed')
          .addSequenceFlow('Sub_Flow_1', 'Sub_Start', 'Sub_Task')
          .addSequenceFlow('Sub_Flow_2', 'Sub_Task', 'Sub_End');
      })
      .addEndEvent('End_Parent', 'Delivered')
      .addSequenceFlow('Parent_Flow_1', 'Start_Parent', 'Sub_Order')
      .addSequenceFlow('Parent_Flow_2', 'Sub_Order', 'End_Parent');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('isExpanded="true"');

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);

    expectImageSnapshotMatch(resultXml, '06-subprocess-expanded');
  });

  it('layouts recursively nested subprocesses', async () => {
    const buildInner = (inner: BpmnBuilder) => {
      inner
        .addStartEvent('Inner_Start', 'Begin Inner')
        .addTask('Inner_Task', 'Deep Compute')
        .addEndEvent('Inner_End', 'Finish Inner')
        .addSequenceFlow('Inner_F1', 'Inner_Start', 'Inner_Task')
        .addSequenceFlow('Inner_F2', 'Inner_Task', 'Inner_End');
    };

    const builder = new BpmnBuilder();
    builder
      .addStartEvent('Start_1', 'Start')
      .addSubProcess('Outer_Sub', 'Outer Scope', (outer) => {
        outer
          .addStartEvent('Outer_Start', 'Begin Outer')
          .addSubProcess('Inner_Sub', 'Inner Scope', buildInner)
          .addEndEvent('Outer_End', 'Finish Outer')
          .addSequenceFlow('Outer_F1', 'Outer_Start', 'Inner_Sub')
          .addSequenceFlow('Outer_F2', 'Inner_Sub', 'Outer_End');
      })
      .addEndEvent('End_1', 'Finish All')
      .addSequenceFlow('Main_F1', 'Start_1', 'Outer_Sub')
      .addSequenceFlow('Main_F2', 'Outer_Sub', 'End_1');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('isExpanded="true"');

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);

    expectImageSnapshotMatch(resultXml, '06-subprocess-nested');
  });
});
