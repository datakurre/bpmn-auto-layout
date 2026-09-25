import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { scoreDiagram } from '../src/layout-metrics';

// Pins the total edge crossings and bends across the whole snapshot corpus,
// so a future change can't silently regress layout quality. See #99, which
// attributes 3 of these crossings to a missing sibling-order sweep. Two
// investigations have now looked at the two named fixtures without a fix
// landing, because both turned out not to be sibling-order problems at a
// single split, which is what #99's own implementation plan (barycenter over
// one reconvergence point) assumes:
//
// - 09-loan-approval-matrix (2 crossings, LF_High_Risk x LF_Auto_Approve and
//   LF_UW_Decline x LF_Auto_Approve): Task_Fast_Approve sits above
//   Gateway_Risk_Tier/Gateway_Underwriter, but its join (Join_Approve, y=300)
//   sits below theirs (Join_Decline, y=180) -- source order and destination
//   order are inverted between two DIFFERENT downstream joins, not two
//   siblings of one gateway sharing one join. A sibling swap at either
//   gateway can't fix this; both joins would need to be reordered together,
//   and Join_Decline/Join_Approve aren't siblings of a common split either.
// - 15-parallel-with-unequal-branch-depth (1 crossing, Flow_B3_Out x
//   Flow_B2_4): Task_Teardown's return-to-join edge has to travel from its
//   own track up to Join_Parallel's, and the orthogonal router's chosen
//   vertical corridor (x=1318) happens to pass through the exact x where an
//   unrelated branch (Task_Deep_3 -> Task_Deep_4) exits horizontally at
//   y=300. The two edges don't share an ancestor split at all; this is a
//   corridor/step-x selection collision in the router, not a branch-order
//   problem.
//
// A prior attempt (see git history for the reverted merge-distance-based
// sibling reorder) confirmed the risk empirically: reordering siblings moves
// every downstream track, and measured against this corpus it traded the 3
// targeted crossings for 8 new ones in 09-loan-approval-matrix alone (13 ->
// 21 total) while leaving 15-parallel-with-unequal-branch-depth unchanged.
// Fixing this needs two separate, more targeted changes -- consistent join
// ordering between correlated branches for the first case, and corridor
// selection that avoids an unrelated branch's exit column for the second --
// neither of which is the sibling-reorder sweep #99 describes. Left open.
// These are current baseline upper bounds, not exact targets: use
// toBeLessThanOrEqual so a future improvement doesn't fail this test the way
// an exact pin would.
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
    expect(totalCrossings).toBeLessThanOrEqual(13);
    expect(totalBends).toBeLessThanOrEqual(155);
  });
});
