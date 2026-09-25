import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { scoreDiagram } from '../src/layout-metrics';

// Pins the total edge crossings and bends across the whole snapshot corpus,
// so a future change can't silently regress layout quality. These are
// baseline upper bounds, not exact targets: toBeLessThanOrEqual lets a future
// improvement pass without editing this file.
//
// #99 named 3 forward-edge crossings in two fixtures:
//
// - 15-parallel-with-unequal-branch-depth (fixed): the forward pass placed
//   the four-task deep branch on its fork's middle track, but the dummy
//   barycenter sweep then moved a dummy of Task_Teardown's long edge onto
//   Task_Deep_4's track; the dummy won the collision tie on `order`, so the
//   real node -- and, through later sweeps, its whole branch -- was pushed a
//   track down and Task_Teardown's edge crossed it. The sweep now never moves
//   a dummy onto a real node's track (sweepRankDummyBarycenter). The same
//   rule, together with a drop-column fix for loop edges
//   (getNearestClearSourceStepX), also tidied 09-order-fulfillment,
//   09-incident-management and 16-subprocess-with-boundary-error-escalation:
//   13 -> 12 crossings and 155 -> 146 bends corpus-wide.
// - 09-loan-approval-matrix (still 2 crossings, LF_High_Risk x
//   LF_Auto_Approve and LF_UW_Decline x LF_Auto_Approve): Join_Approve's
//   parents average to the same track as Join_Decline's, and the tie goes to
//   Join_Decline by document order, so the two joins are inverted relative to
//   their sources. Ordering tied merges by their unrounded parent barycenter
//   was tried and reverted: it shifts the whole underwriting branch and makes
//   the boundary timer overlap its host. A real fix has to reorder both joins
//   together with what feeds them.
describe('Corpus layout quality', () => {
  it('keeps total edge crossings and bends within the pinned baseline', async () => {
    const snapshotsDir = join(__dirname, 'snapshots');
    const bpmnFiles = readdirSync(snapshotsDir).filter((f) => f.endsWith('.bpmn'));
    expect(bpmnFiles.length).toBeGreaterThan(0);

    let totalCrossings = 0;
    let totalBends = 0;
    let totalShapeOverlaps = 0;
    let totalEdgeShapeCrossings = 0;

    for (const file of bpmnFiles) {
      const xml = readFileSync(join(snapshotsDir, file), 'utf8');
      const score = await scoreDiagram(xml);
      totalCrossings += score.metrics.edgeCrossings;
      totalBends += score.metrics.totalBends;
      totalShapeOverlaps += score.hardViolations.shapeOverlaps;
      totalEdgeShapeCrossings += score.hardViolations.edgeShapeCrossings;
    }

    expect(totalShapeOverlaps).toBe(0);
    expect(totalEdgeShapeCrossings).toBe(0);
    expect(totalCrossings).toBeLessThanOrEqual(12);
    expect(totalBends).toBeLessThanOrEqual(146);
  });
});
