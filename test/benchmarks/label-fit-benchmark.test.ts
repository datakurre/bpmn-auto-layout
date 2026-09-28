import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { layoutProcess } from '../../src/index';
import { scoreDiagram } from '../../src/layout-metrics';
import { measureLabelFit, readLaidOutShapes } from '../helpers/label-fit-metrics';

// Scores how well pool/lane headers, task boxes and element labels fit their
// text. Runs the committed grant-review fixture and, when BENCHMARK_FILE names
// a BPMN file, that file too (e.g. a real-world diagram that must not be
// committed). Skipped by default; run with `npm run benchmark:labels`.
const inputs = [new URL('../fixtures/grant-review-collaboration.bpmn', import.meta.url).pathname];
if (process.env.BENCHMARK_FILE) {
  inputs.push(process.env.BENCHMARK_FILE);
}

describe.skipIf(!process.env.BENCHMARK)('Label fit benchmark', () => {
  it.each(inputs)('fits every label in %s', async (file) => {
    const xml = await layoutProcess(readFileSync(file, 'utf8'));
    const [fit, score] = await Promise.all([
      readLaidOutShapes(xml).then(measureLabelFit),
      scoreDiagram(xml),
    ]);
    console.log(
      `${basename(file)}: ${JSON.stringify({
        ...fit,
        size: `${score.compactness.width}x${score.compactness.height}`,
        bends: score.metrics.totalBends,
        crossings: score.metrics.edgeCrossings,
      })}`
    );
    expect(fit).toEqual({ overflowingHeaders: [], overflowingTasks: [], labelsInHeaderBand: [] });
    expect(score.isValid).toBe(true);
  });
});
