import { describe, it, expect } from 'vitest';
import { BpmnBuilder } from '../src/bpmn-builder';
import { layoutProcess } from '../src/index';
import { scoreDiagram } from '../src/layout-metrics';

// Regression test for a #104 review finding: routeScope's obstacle set for
// disconnected elements (event subprocesses, compensation handlers) grew to
// include shapes sequence-flow routing never had to avoid before, and
// computeCurrentDiagramBounds stopped accounting for a loop channel's
// waypoints when placing those elements -- combined, a loop-back edge could
// get routed straight through an event subprocess placed inside its channel.
describe('a feedback loop coexisting with a disconnected element', () => {
  it('does not route the loop edge through an event subprocess', async () => {
    const b = new BpmnBuilder('P');
    b.addStartEvent('S')
      .addTask('A')
      .addTask('B')
      .addExclusiveGateway('G')
      .addEndEvent('E')
      .addSequenceFlow('f1', 'S', 'A')
      .addSequenceFlow('f2', 'A', 'B')
      .addSequenceFlow('f3', 'B', 'G')
      .addSequenceFlow('back', 'G', 'A')
      .addSequenceFlow('f4', 'G', 'E');
    b.addEventSubProcess('ES', 'Handler', (c) => {
      c.addStartEvent('ES_s').addEndEvent('ES_e').addSequenceFlow('ES_f', 'ES_s', 'ES_e');
    });

    const xml = await layoutProcess(await b.toXml());
    const score = await scoreDiagram(xml);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
  });

  it('does not route a loop edge through a compensation handler', async () => {
    const b = new BpmnBuilder('P');
    b.addStartEvent('S')
      .addTask('A')
      .addTask('B')
      .addExclusiveGateway('G')
      .addEndEvent('E')
      .addSequenceFlow('f1', 'S', 'A')
      .addSequenceFlow('f2', 'A', 'B')
      .addSequenceFlow('f3', 'B', 'G')
      .addSequenceFlow('back', 'G', 'A')
      .addSequenceFlow('f4', 'G', 'E')
      .addTask('Compensable', 'Reserve Funds')
      .addSequenceFlow('f5', 'B', 'Compensable')
      .addBoundaryEvent({
        id: 'BE_Comp',
        attachedToRef: 'Compensable',
        eventDefinitionType: 'bpmn:CompensateEventDefinition',
      })
      .addCompensationTask('Handler_Comp', 'Undo Reservation')
      .addAssociation('Assoc_Comp', 'BE_Comp', 'Handler_Comp');

    const xml = await layoutProcess(await b.toXml());
    const score = await scoreDiagram(xml);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
  });

  it('does not route a loop edge with a split/join through an event subprocess', async () => {
    const b = new BpmnBuilder('P');
    b.addStartEvent('S')
      .addTask('A')
      .addExclusiveGateway('Split')
      .addTask('B1')
      .addTask('B2')
      .addExclusiveGateway('Join')
      .addExclusiveGateway('G')
      .addEndEvent('E')
      .addSequenceFlow('f1', 'S', 'A')
      .addSequenceFlow('f2', 'A', 'Split')
      .addSequenceFlow('f3a', 'Split', 'B1')
      .addSequenceFlow('f3b', 'Split', 'B2')
      .addSequenceFlow('f4a', 'B1', 'Join')
      .addSequenceFlow('f4b', 'B2', 'Join')
      .addSequenceFlow('f5', 'Join', 'G')
      .addSequenceFlow('back', 'G', 'A')
      .addSequenceFlow('f6', 'G', 'E');
    b.addEventSubProcess('ES', 'Handler', (c) => {
      c.addStartEvent('ES_s').addEndEvent('ES_e').addSequenceFlow('ES_f', 'ES_s', 'ES_e');
    });

    const xml = await layoutProcess(await b.toXml());
    const score = await scoreDiagram(xml);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
  });

  it('does not route a boundary-event retry loop through an event subprocess', async () => {
    const b = new BpmnBuilder('P');
    b.addStartEvent('S')
      .addTask('A')
      .addBoundaryEvent({
        id: 'BE',
        attachedToRef: 'A',
        eventDefinitionType: 'bpmn:ErrorEventDefinition',
      })
      .addTask('Fix')
      .addEndEvent('E')
      .addSequenceFlow('f1', 'S', 'A')
      .addSequenceFlow('f2', 'A', 'E')
      .addSequenceFlow('f3', 'BE', 'Fix')
      .addSequenceFlow('back', 'Fix', 'A');
    b.addEventSubProcess('ES', 'Handler', (c) => {
      c.addStartEvent('ES_s').addEndEvent('ES_e').addSequenceFlow('ES_f', 'ES_s', 'ES_e');
    });

    const xml = await layoutProcess(await b.toXml());
    const score = await scoreDiagram(xml);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
  });
});
