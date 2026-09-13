import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { layoutProcess } from '../src/index';
import { scoreDiagram } from '../src/layout-metrics';

describe('Release Pipeline Layout Verification', () => {
  it('layouts release-pipeline.bpmn cleanly without overlaps or crossings', async () => {
    const xmlPath = path.resolve(__dirname, '../release-pipeline.bpmn');
    const inputXml = fs.readFileSync(xmlPath, 'utf-8');
    const resultXml = await layoutProcess(inputXml);

    const score = await scoreDiagram(resultXml);
    expect(score.isValid).toBe(true);
    expect(score.hardViolations.shapeOverlaps).toBe(0);
    expect(score.hardViolations.edgeShapeCrossings).toBe(0);
    expect(score.hardViolations.nonOrthogonalSegments).toBe(0);
  });
});
