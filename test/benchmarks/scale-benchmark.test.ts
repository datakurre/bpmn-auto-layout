import { describe, it, afterAll, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { layoutProcess } from '../../src/index';
import { scoreDiagram } from '../../src/layout-metrics';
import { composeScaledProcess } from '../helpers/scale-motifs';

// Stress-tests the layout pipeline with huge diagrams composed from the same
// motifs proven in iterations 01-24 (chains, branch/join, cycles, boundary
// events, subprocesses), at increasing size tiers, to find where correctness
// or performance breaks down. Skipped by default so `npm test` stays fast;
// run explicitly with `npm run benchmark:scale` (or `:extreme` for the
// largest tier).
const OUTPUT_DIR = join(__dirname, 'output');

interface Tier {
  name: string;
  repeats: number;
  timeoutMs: number;
  strict?: boolean;
  render?: boolean;
}

const TIERS: Tier[] = [
  { name: 'calibration', repeats: 4, timeoutMs: 15_000, strict: true, render: true },
  { name: 'medium', repeats: 20, timeoutMs: 30_000, render: true },
  { name: 'large', repeats: 60, timeoutMs: 60_000 },
  { name: 'huge', repeats: 150, timeoutMs: 120_000 },
  { name: 'extreme', repeats: 400, timeoutMs: 240_000 },
];

if (process.env.BENCHMARK_EXTREME) {
  TIERS.push({ name: 'breaking-point', repeats: 1000, timeoutMs: 480_000 });
}

interface TierResult {
  name: string;
  repeats: number;
  nodeCount: number;
  edgeCount: number;
  elapsedMs: number;
  msPerNode: number;
  edgeCrossings: number;
  totalBends: number;
  shapeOverlaps: number;
  edgeShapeCrossings: number;
  status: 'ok' | 'error';
  error?: string;
}

function renderTierPng(name: string, xml: string): void {
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  execFileSync(
    'bpmn-to-image',
    [
      '--background',
      'white',
      '--format',
      'png',
      '--scale',
      '2',
      '-',
      join(OUTPUT_DIR, `${name}.png`),
    ],
    { input: xml }
  );
}

const REPORT_COLUMNS = [
  'tier',
  'status',
  'nodes',
  'edges',
  'ms',
  'ms/node',
  'crossings',
  'bends',
  'overlaps',
  'edgeShapeHits',
] as const;

function toReportRow(r: TierResult): Record<(typeof REPORT_COLUMNS)[number], string> {
  return {
    tier: r.name,
    status: r.status,
    nodes: String(r.nodeCount),
    edges: String(r.edgeCount),
    ms: String(Math.round(r.elapsedMs)),
    'ms/node': Number.isFinite(r.msPerNode) ? r.msPerNode.toFixed(2) : 'n/a',
    crossings: String(r.edgeCrossings),
    bends: String(r.totalBends),
    overlaps: String(r.shapeOverlaps),
    edgeShapeHits: String(r.edgeShapeCrossings),
  };
}

function formatTable(results: TierResult[]): string {
  const rows = results.map(toReportRow);
  const widths = REPORT_COLUMNS.map((col) =>
    Math.max(col.length, ...rows.map((row) => row[col].length))
  );
  const formatLine = (cells: string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i])).join('  ');
  return [
    formatLine([...REPORT_COLUMNS]),
    ...rows.map((row) => formatLine(REPORT_COLUMNS.map((col) => row[col]))),
  ].join('\n');
}

function printReport(results: TierResult[]): void {
  if (results.length === 0) {
    return;
  }
  console.log(formatTable(results));

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'error') {
      console.log(`[breakdown] "${r.name}" failed to lay out: ${r.error}`);
      continue;
    }
    if (r.shapeOverlaps > 0 || r.edgeShapeCrossings > 0) {
      console.log(
        `[breakdown] "${r.name}" produced hard violations (${r.shapeOverlaps} overlaps, ${r.edgeShapeCrossings} edge-shape hits).`
      );
    }
    const previous = results[i - 1];
    if (previous?.status === 'ok' && previous.msPerNode > 0) {
      const growth = r.msPerNode / previous.msPerNode;
      if (growth > 3) {
        console.log(
          `[breakdown] ms/node jumped ${growth.toFixed(1)}x from "${previous.name}" to "${r.name}".`
        );
      }
    }
  }
}

describe.skipIf(!process.env.BENCHMARK)(
  'Scale benchmark: composing motifs into huge diagrams',
  () => {
    const results: TierResult[] = [];

    for (const tier of TIERS) {
      it(
        `${tier.name} (${tier.repeats} repeats)`,
        async () => {
          const { xml, nodeCount, edgeCount } = await composeScaledProcess({
            repeats: tier.repeats,
          });
          const start = performance.now();
          let laidOutXml: string;
          try {
            laidOutXml = await layoutProcess(xml);
          } catch (error) {
            results.push({
              name: tier.name,
              repeats: tier.repeats,
              nodeCount,
              edgeCount,
              elapsedMs: performance.now() - start,
              msPerNode: Number.NaN,
              edgeCrossings: Number.NaN,
              totalBends: Number.NaN,
              shapeOverlaps: Number.NaN,
              edgeShapeCrossings: Number.NaN,
              status: 'error',
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
          const elapsedMs = performance.now() - start;
          const score = await scoreDiagram(laidOutXml);
          results.push({
            name: tier.name,
            repeats: tier.repeats,
            nodeCount,
            edgeCount,
            elapsedMs,
            msPerNode: elapsedMs / nodeCount,
            edgeCrossings: score.metrics.edgeCrossings,
            totalBends: score.metrics.totalBends,
            shapeOverlaps: score.hardViolations.shapeOverlaps,
            edgeShapeCrossings: score.hardViolations.edgeShapeCrossings,
            status: 'ok',
          });

          if (tier.render) {
            try {
              renderTierPng(tier.name, laidOutXml);
            } catch (error) {
              console.warn(
                `[benchmark] could not render "${tier.name}" PNG (bpmn-to-image unavailable?): ${error instanceof Error ? error.message : String(error)}`
              );
            }
          }
          if (tier.strict) {
            expect(score.hardViolations.shapeOverlaps).toBe(0);
            expect(score.hardViolations.edgeShapeCrossings).toBe(0);
          }
        },
        tier.timeoutMs
      );
    }

    afterAll(() => {
      printReport(results);
    });
  }
);
