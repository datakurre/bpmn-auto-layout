import { describe, it, expect } from 'vitest';
import { BpmnBuilder } from '../src/bpmn-builder';
import { layoutProcess } from '../src/index';
import { scoreDiagram } from '../src/layout-metrics';
import { expectImageSnapshotMatch } from './helpers/snapshot-helper';

describe('Iteration 1: Single Elements', () => {
  it('layouts a single StartEvent with correct DI bounds', async () => {
    const builder = new BpmnBuilder();
    builder.addStartEvent('Start_1', 'Start');
    const inputXml = await builder.toXml();

    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('<bpmndi:BPMNDiagram');
    expect(resultXml).toContain('<bpmndi:BPMNShape id="Start_1_di" bpmnElement="Start_1">');
    expect(resultXml).toContain('<dc:Bounds x="100" y="122" width="36" height="36" />');

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);

    expectImageSnapshotMatch(resultXml, '01-start-event');
  });

  it('layouts a single Task with standard 100x80 dimensions', async () => {
    const builder = new BpmnBuilder();
    builder.addTask('Task_1', 'Perform Task');
    const inputXml = await builder.toXml();

    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('<bpmndi:BPMNShape id="Task_1_di" bpmnElement="Task_1">');
    expect(resultXml).toContain('<dc:Bounds x="100" y="100" width="100" height="80" />');

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);

    expectImageSnapshotMatch(resultXml, '01-single-task');
  });

  it('layouts a single ExclusiveGateway with standard 50x50 dimensions', async () => {
    const builder = new BpmnBuilder();
    builder.addExclusiveGateway('Gateway_1', 'Decide');
    const inputXml = await builder.toXml();

    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('<bpmndi:BPMNShape id="Gateway_1_di" bpmnElement="Gateway_1">');
    expect(resultXml).toContain('<dc:Bounds x="100" y="115" width="50" height="50" />');

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);

    expectImageSnapshotMatch(resultXml, '01-exclusive-gateway');
  });

  it('layouts a single EndEvent with standard 36x36 dimensions', async () => {
    const builder = new BpmnBuilder();
    builder.addEndEvent('End_1', 'Finish');
    const inputXml = await builder.toXml();

    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('<bpmndi:BPMNShape id="End_1_di" bpmnElement="End_1">');
    expect(resultXml).toContain('<dc:Bounds x="100" y="122" width="36" height="36" />');

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);

    expectImageSnapshotMatch(resultXml, '01-end-event');
  });
});
