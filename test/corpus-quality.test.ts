import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { scoreDiagram } from '../src/layout-metrics';

// Pins the total edge crossings and bends across the whole snapshot corpus,
// so a future change can't silently regress layout quality. See #99: a
// merge-distance-based sibling reorder was tried to remove the 3 forward-edge
// crossings this issue attributes to branch order (in 09-loan-approval-matrix
// and 15-parallel-with-unequal-branch-depth), but reordering siblings moves
// every downstream track, and measured against this same corpus it traded 3
// crossings for 8 new ones in 09-loan-approval-matrix alone (13 -> 21 total)
// while leaving 15-parallel-with-unequal-branch-depth unchanged. That result
// means the fix needs to reason about the full set of edges a reorder would
// newly cross, not just the branch's own reconvergence point -- left as
// follow-up work. These are current baseline upper bounds, not exact targets:
// use toBeLessThanOrEqual so a future improvement doesn't fail this test the
// way an exact pin would.
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
