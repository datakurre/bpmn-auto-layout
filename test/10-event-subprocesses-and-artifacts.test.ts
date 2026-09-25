import { describe, it, expect } from 'vitest';
import { BpmnBuilder } from '../src/bpmn-builder';
import { layoutProcess } from '../src/index';
import { scoreDiagram } from '../src/layout-metrics';
import { routeAssociationEdge, layoutScope, routeScope } from '../src/hierarchy/subprocess-layout';
import { getArtifactDimensions } from '../src/hierarchy/artifact-layout';
import { expectSnapshotMatch } from './helpers/snapshot-helper';

describe('Iteration 10: Event Sub-Processes & Artifacts', () => {
  it('layouts event sub-process positioned below main process flow', async () => {
    const builder = new BpmnBuilder('Process_EventSub');
    builder
      .addStartEvent('Start_Main', 'Order Placed')
      .addTask('Task_ProcessOrder', 'Process Order')
      .addEndEvent('End_Main', 'Order Completed')
      .addSequenceFlow('Flow_1', 'Start_Main', 'Task_ProcessOrder')
      .addSequenceFlow('Flow_2', 'Task_ProcessOrder', 'End_Main')
      .addEventSubProcess('EventSub_Error', 'Error Handling', (sub) => {
        sub
          .addStartEvent('Start_Err', 'Error Caught', 'bpmn:ErrorEventDefinition')
          .addTask('Task_Compensate', 'Compensate Order')
          .addEndEvent('End_Err', 'Order Cancelled')
          .addSequenceFlow('SubFlow_1', 'Start_Err', 'Task_Compensate')
          .addSequenceFlow('SubFlow_2', 'Task_Compensate', 'End_Err');
      });

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('triggeredByEvent="true"');
    expect(resultXml).toContain('isExpanded="true"');

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);
  });

  it('layouts connected data object and data store with orthogonal associations', async () => {
    const builder = new BpmnBuilder('Process_DataArtifacts');
    builder
      .addStartEvent('Start_1', 'Start')
      .addTask('Task_Review', 'Review Application')
      .addEndEvent('End_1', 'Complete')
      .addSequenceFlow('Flow_1', 'Start_1', 'Task_Review')
      .addSequenceFlow('Flow_2', 'Task_Review', 'End_1')
      .addDataObjectReference('Doc_Application', 'Application Form')
      .addDataStoreReference('Store_Database', 'Customer DB')
      .addAssociation('Assoc_Doc', 'Doc_Application', 'Task_Review')
      .addAssociation('Assoc_Store', 'Task_Review', 'Store_Database');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('dataObjectReference');
    expect(resultXml).toContain('dataStoreReference');
    expect(resultXml).toContain('association');

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);
  });

  it('layouts text annotation associated with task', async () => {
    const builder = new BpmnBuilder('Process_Annotation');
    builder
      .addStartEvent('Start_1', 'Start')
      .addTask('Task_Approve', 'Approve Payment')
      .addEndEvent('End_1', 'End')
      .addSequenceFlow('Flow_1', 'Start_1', 'Task_Approve')
      .addSequenceFlow('Flow_2', 'Task_Approve', 'End_1')
      .addTextAnnotation('Note_Approval', 'Requires dual authorization for > $10,000')
      .addAssociation('Assoc_Note', 'Note_Approval', 'Task_Approve');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('textAnnotation');
    expect(resultXml).toContain('Requires dual authorization');
    expect(resultXml).toMatch(
      /<bpmndi:BPMNShape id="Note_Approval_di"[^>]*>\s*<dc:Bounds [^>]*height="58"/
    );

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);
  });

  it('computes artifact dimensions dynamically for text annotations and standard artifacts', () => {
    expect(getArtifactDimensions({ $type: 'bpmn:DataObjectReference' })).toEqual({
      width: 36,
      height: 50,
    });
    expect(getArtifactDimensions({ $type: 'bpmn:DataStoreReference' })).toEqual({
      width: 50,
      height: 50,
    });
    expect(getArtifactDimensions({ $type: 'bpmn:TextAnnotation', text: 'Short note' })).toEqual({
      width: 100,
      height: 30,
    });
    expect(
      getArtifactDimensions({
        $type: 'bpmn:TextAnnotation',
        name: 'Check credit score and collateral',
      })
    ).toEqual({ width: 100, height: 58 });
  });

  it('layouts disconnected artifacts stacked below main diagram', async () => {
    const builder = new BpmnBuilder('Process_Disconnected');
    builder
      .addStartEvent('Start_1', 'Start')
      .addTask('Task_Simple', 'Simple Task')
      .addEndEvent('End_1', 'End')
      .addSequenceFlow('Flow_1', 'Start_1', 'Task_Simple')
      .addSequenceFlow('Flow_2', 'Task_Simple', 'End_1')
      .addDataObjectReference('Doc_Unlinked', 'Reference Guide')
      .addDataStoreReference('Store_Backup', 'Audit Archive');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    expect(resultXml).toContain('Reference Guide');
    expect(resultXml).toContain('Audit Archive');

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
  });

  it('layouts complex workflow with main flow, event subprocess, and data artifacts', async () => {
    const builder = new BpmnBuilder('Process_Integration');
    builder
      .addStartEvent('Start_Req', 'Loan Requested')
      .addTask('Task_Ingest', 'Ingest Documents')
      .addExclusiveGateway('Gate_Check', 'Complete?')
      .addTask('Task_Standard', 'Standard Underwrite')
      .addTask('Task_FastTrack', 'Fast Track Review')
      .addExclusiveGateway('Gate_Merge', 'Join Review')
      .addTask('Task_Archive', 'Store Application')
      .addEndEvent('End_Complete', 'Loan Decided')
      .addSequenceFlow('F1', 'Start_Req', 'Task_Ingest')
      .addSequenceFlow('F2', 'Task_Ingest', 'Gate_Check')
      .addSequenceFlow('F3', 'Gate_Check', 'Task_Standard')
      .addSequenceFlow('F4', 'Gate_Check', 'Task_FastTrack')
      .addSequenceFlow('F5', 'Task_Standard', 'Gate_Merge')
      .addSequenceFlow('F6', 'Task_FastTrack', 'Gate_Merge')
      .addSequenceFlow('F7', 'Gate_Merge', 'Task_Archive')
      .addSequenceFlow('F8', 'Task_Archive', 'End_Complete')
      .addDataObjectReference('Doc_Packet', 'Loan Dossier')
      .addDataStoreReference('Store_CoreDB', 'Core Banking DB')
      .addTextAnnotation('Note_Criteria', 'Check credit score and collateral')
      .addAssociation('Assoc_Doc', 'Doc_Packet', 'Task_Ingest')
      .addAssociation('Assoc_DB', 'Task_Archive', 'Store_CoreDB')
      .addAssociation('Assoc_Note', 'Note_Criteria', 'Task_Standard')
      .addEventSubProcess('EventSub_Cancel', 'Cancellation Handler', (sub) => {
        sub
          .addStartEvent('Start_Cancel', 'Client Cancellation', 'bpmn:MessageEventDefinition')
          .addTask('Task_Cleanup', 'Clean Temporary Files')
          .addEndEvent('End_Cancelled', 'Process Terminated', 'bpmn:TerminateEventDefinition')
          .addSequenceFlow('SubF1', 'Start_Cancel', 'Task_Cleanup')
          .addSequenceFlow('SubF2', 'Task_Cleanup', 'End_Cancelled');
      })
      .addDataObjectReference('Doc_Policy', 'Lending Policy Doc');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);
    expect(resultXml).toMatch(
      /<bpmndi:BPMNShape id="Note_Criteria_di"[^>]*>\s*<dc:Bounds [^>]*height="58"/
    );

    expectSnapshotMatch(resultXml, '10-event-subprocesses-and-artifacts');
  });

  it('handles all routing directions in routeAssociationEdge', () => {
    // 1. Target directly above source
    const tgtAbove = routeAssociationEdge(
      { x: 100, y: 200, width: 100, height: 80 },
      { x: 100, y: 50, width: 100, height: 80 }
    );
    expect(tgtAbove.length).toBe(2);
    expect(tgtAbove[0].x).toBe(tgtAbove[1].x);

    // 2. Overlapping Y: Source to the left of target
    const srcLeft = routeAssociationEdge(
      { x: 50, y: 100, width: 50, height: 50 },
      { x: 200, y: 100, width: 50, height: 50 }
    );
    expect(srcLeft.length).toBe(2);
    expect(srcLeft[0].y).toBe(srcLeft[1].y);

    // 3. Overlapping Y: Target to the left of source
    const tgtLeft = routeAssociationEdge(
      { x: 200, y: 100, width: 50, height: 50 },
      { x: 50, y: 100, width: 50, height: 50 }
    );
    expect(tgtLeft.length).toBe(2);
    expect(tgtLeft[0].y).toBe(tgtLeft[1].y);

    // 4. Diagonal: Source to the left of target
    const diagSrcLeft = routeAssociationEdge(
      { x: 50, y: 50, width: 50, height: 50 },
      { x: 200, y: 200, width: 50, height: 50 }
    );
    expect(diagSrcLeft.length).toBe(3);

    // 4b. Diagonal: Source left and below target with obstacle in column
    const diagSrcLeftBelow = routeAssociationEdge(
      { x: 50, y: 200, width: 50, height: 50 },
      { x: 200, y: 50, width: 50, height: 50 },
      [
        { x: 60, y: 120, width: 30, height: 30 },
        { x: 300, y: 50, width: 50, height: 50 },
      ]
    );
    expect(diagSrcLeftBelow.length).toBe(4);

    // 4c. Diagonal: Source left and above target with stepped route obstructed
    const diagSrcLeftBlockedStepped = routeAssociationEdge(
      { x: 50, y: 50, width: 50, height: 50 },
      { x: 200, y: 200, width: 50, height: 50 },
      [
        { x: 100, y: 140, width: 40, height: 30 },
        { x: 300, y: 200, width: 50, height: 50 },
      ]
    );
    expect(diagSrcLeftBlockedStepped.length).toBe(3);

    // 5. Diagonal: Source to the right of target
    const diagSrcRight = routeAssociationEdge(
      { x: 200, y: 50, width: 50, height: 50 },
      { x: 50, y: 200, width: 50, height: 50 }
    );
    expect(diagSrcRight.length).toBe(3);
  });

  it('handles task data input and data output associations', async () => {
    const scopeElement = {
      $type: 'bpmn:Process',
      flowElements: [
        { $type: 'bpmn:StartEvent', id: 'Start_1' },
        {
          $type: 'bpmn:Task',
          id: 'Task_1',
          dataInputAssociations: [
            { id: 'DIA_1', sourceRef: [{ id: 'Doc_In' }] },
            { sourceRef: { id: 'Doc_In2' } },
          ],
          dataOutputAssociations: [
            { id: 'DOA_1', targetRef: { id: 'Store_Out' } },
            { targetRef: { id: 'Store_Out2' } },
          ],
        },
        { $type: 'bpmn:DataObjectReference', id: 'Doc_In' },
        { $type: 'bpmn:DataObjectReference', id: 'Doc_In2' },
        { $type: 'bpmn:DataStoreReference', id: 'Store_Out' },
        { $type: 'bpmn:DataStoreReference', id: 'Store_Out2' },
        { $type: 'bpmn:SequenceFlow', id: 'Flow_1', sourceRef: 'Start_1', targetRef: 'Task_1' },
      ],
    };

    const result = layoutScope(scopeElement);
    expect(result.shapes.some((s) => s.element.id === 'Doc_In')).toBe(true);
    expect(result.shapes.some((s) => s.element.id === 'Doc_In2')).toBe(true);
    expect(result.shapes.some((s) => s.element.id === 'Store_Out')).toBe(true);
    expect(result.shapes.some((s) => s.element.id === 'Store_Out2')).toBe(true);

    const boundsMap = new Map(result.shapes.map((s) => [s.element.id, s.bounds]));
    const edges = routeScope(scopeElement, { boundsMap, analysisMap: new Map() });
    expect(edges.some((e) => e.element.id === 'DIA_1')).toBe(true);
    expect(edges.some((e) => e.element.id === 'Assoc_Doc_In2_Task_1')).toBe(true);
    expect(edges.some((e) => e.element.id === 'DOA_1')).toBe(true);
    expect(edges.some((e) => e.element.id === 'Assoc_Task_1_Store_Out2')).toBe(true);
  });

  it('handles placement of multiple artifacts (below and side) on the same host', async () => {
    const builder = new BpmnBuilder('Process_MultiArtifacts');
    builder
      .addStartEvent('Start_1')
      .addTask('Task_Busy', 'Busy Task')
      .addEndEvent('End_1')
      .addSequenceFlow('F1', 'Start_1', 'Task_Busy')
      .addSequenceFlow('F2', 'Task_Busy', 'End_1')
      .addDataObjectReference('Doc_1', 'Input Doc')
      .addTextAnnotation('Note_Below', 'Below note')
      .addTextAnnotation('Note_Side', 'Side note')
      .addAssociation('A1', 'Doc_1', 'Task_Busy')
      .addAssociation('A2', 'Note_Below', 'Task_Busy')
      .addAssociation('A3', 'Note_Side', 'Task_Busy');

    const inputXml = await builder.toXml();
    const resultXml = await layoutProcess(inputXml);
    expect(resultXml).toContain('Note_Below');
    expect(resultXml).toContain('Note_Side');
  });

  it('handles wrapping in layoutDisconnectedElements and empty scopes', () => {
    // Empty scope
    const emptyResult = layoutScope({ flowElements: [] });
    expect(emptyResult.shapes.length).toBe(0);

    // Scope with only disconnected data object (no regular nodes)
    const orphanScope = {
      flowElements: [
        { $type: 'bpmn:DataObjectReference', id: 'Doc_Solo' },
        {
          $type: 'bpmn:Association',
          id: 'Assoc_Orphan',
          sourceRef: 'Unknown_1',
          targetRef: 'Unknown_2',
        },
      ],
    };
    const disconnectedOnly = layoutScope(orphanScope);
    expect(disconnectedOnly.shapes.length).toBe(1);

    // Assoc_Orphan's refs resolve to nothing placed, so routing it finds no
    // bounds for either end and skips it rather than throwing.
    const boundsMap = new Map(disconnectedOnly.shapes.map((s) => [s.element.id, s.bounds]));
    const edges = routeScope(orphanScope, { boundsMap, analysisMap: new Map() });
    expect(edges.length).toBe(0);

    // Many disconnected items forcing row wrapping
    const items: any[] = [];
    for (let i = 0; i < 20; i++) {
      items.push({
        $type: 'bpmn:DataObjectReference',
        id: `Doc_Many_${i}`,
      });
    }
    const wrapResult = layoutScope({ flowElements: items });
    expect(wrapResult.shapes.length).toBe(20);
    // Shapes should be placed on multiple rows (at least two different Y values)
    const yValues = new Set(wrapResult.shapes.map((s) => s.bounds.y));
    expect(yValues.size).toBeGreaterThan(1);
  });

  it('routes association edges across all relative orientations and overlaps', () => {
    // 1. src left and above tgt (diagonal)
    const q1 = routeAssociationEdge(
      { x: 0, y: 0, width: 50, height: 50 },
      { x: 100, y: 100, width: 50, height: 50 }
    );
    expect(q1.length).toBe(3);
    expect(q1[0].x).toBe(50);
    expect(q1[2].y).toBe(100);

    // 2. src left and below tgt (diagonal)
    const q2 = routeAssociationEdge(
      { x: 0, y: 100, width: 50, height: 50 },
      { x: 100, y: 0, width: 50, height: 50 }
    );
    expect(q2.length).toBe(3);
    expect(q2[0].x).toBe(50);
    expect(q2[2].y).toBe(50);

    // 3. src right and above tgt (diagonal) — enters tgt at its right edge, centered on tgt's y
    const q3 = routeAssociationEdge(
      { x: 100, y: 0, width: 50, height: 50 },
      { x: 0, y: 100, width: 50, height: 50 }
    );
    expect(q3.length).toBe(3);
    expect(q3[0].y).toBe(50);
    expect(q3[2].x).toBe(50);

    // 4. src right and below tgt (diagonal) — enters tgt at its right edge, centered on tgt's y
    const q4 = routeAssociationEdge(
      { x: 100, y: 100, width: 50, height: 50 },
      { x: 0, y: 0, width: 50, height: 50 }
    );
    expect(q4.length).toBe(3);
    expect(q4[0].y).toBe(100);
    expect(q4[2].x).toBe(50);

    // 4b. src right and above tgt with obstacle blocking right port — enters tgt at top edge (4 points)
    const q3Obstructed = routeAssociationEdge(
      { x: 100, y: 0, width: 50, height: 50 },
      { x: 0, y: 100, width: 50, height: 50 },
      [
        { x: 120, y: 80, width: 50, height: 50 },
        { x: 10, y: 0, width: 20, height: 20 }, // obs with a.x >= obs.x + obs.width and a.y >= obs.y + obs.height
      ]
    );
    expect(q3Obstructed.length).toBe(4);

    // 4c. src right and below tgt with obstacle blocking right port — enters tgt at bottom edge (4 points)
    const q4Obstructed = routeAssociationEdge(
      { x: 100, y: 100, width: 50, height: 50 },
      { x: 0, y: 0, width: 50, height: 50 },
      [{ x: 120, y: 20, width: 50, height: 50 }]
    );
    expect(q4Obstructed.length).toBe(4);

    // 4d. src right and above tgt with horizontal obstacle blocking horizontal entry
    const q3HorizBlock = routeAssociationEdge(
      { x: 100, y: 0, width: 50, height: 50 },
      { x: 0, y: 100, width: 50, height: 50 },
      [{ x: 60, y: 110, width: 30, height: 30 }]
    );
    expect(q3HorizBlock.length).toBe(4);

    // 5. src horizontally overlapping and below tgt
    const vOverlapBelow = routeAssociationEdge(
      { x: 10, y: 100, width: 50, height: 50 },
      { x: 20, y: 0, width: 50, height: 50 }
    );
    expect(vOverlapBelow.length).toBe(2);
    expect(vOverlapBelow[0].y).toBe(100);
    expect(vOverlapBelow[1].y).toBe(50);

    // 6. src horizontally overlapping and above tgt
    const vOverlapAbove = routeAssociationEdge(
      { x: 20, y: 0, width: 50, height: 50 },
      { x: 10, y: 100, width: 50, height: 50 }
    );
    expect(vOverlapAbove.length).toBe(2);
    expect(vOverlapAbove[0].y).toBe(50);
    expect(vOverlapAbove[1].y).toBe(100);

    // 7. src vertically overlapping and right of tgt
    const hOverlapRight = routeAssociationEdge(
      { x: 100, y: 10, width: 50, height: 50 },
      { x: 0, y: 20, width: 50, height: 50 }
    );
    expect(hOverlapRight.length).toBe(2);
    expect(hOverlapRight[0].x).toBe(100);
    expect(hOverlapRight[1].x).toBe(50);

    // 8. src vertically overlapping and left of tgt
    const hOverlapLeft = routeAssociationEdge(
      { x: 0, y: 20, width: 50, height: 50 },
      { x: 100, y: 10, width: 50, height: 50 }
    );
    expect(hOverlapLeft.length).toBe(2);
    expect(hOverlapLeft[0].x).toBe(50);
    expect(hOverlapLeft[1].x).toBe(100);

    // 9. Mutually overlapping shapes
    const overlapping = routeAssociationEdge(
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 50, y: 50, width: 100, height: 100 }
    );
    expect(overlapping.length).toBe(3);
  });
});
