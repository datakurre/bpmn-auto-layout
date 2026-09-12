import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const SNAPSHOTS_DIR = join(__dirname, '../snapshots');

export function expectImageSnapshotMatch(xml: string, snapshotName: string): void {
  if (!existsSync(SNAPSHOTS_DIR)) {
    mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  }

  const snapshotPath = join(SNAPSHOTS_DIR, `${snapshotName}.png`);
  const tempActualPath = `/tmp/${snapshotName}_actual.png`;

  try {
    execFileSync(
      'bpmn-to-image',
      ['--background', 'white', '--format', 'png', '--scale', '2', '-', tempActualPath],
      { input: xml }
    );

    const actualBuffer = readFileSync(tempActualPath);
    const updateSnapshots = process.env.UPDATE_SNAPSHOTS === 'true';

    if (updateSnapshots || !existsSync(snapshotPath)) {
      writeFileSync(snapshotPath, actualBuffer);
      return;
    }

    const baselineBuffer = readFileSync(snapshotPath);
    const actualHash = createHash('sha256').update(actualBuffer).digest('hex');
    const baselineHash = createHash('sha256').update(baselineBuffer).digest('hex');

    if (actualHash !== baselineHash) {
      throw new Error(
        `Image snapshot mismatch for "${snapshotName}".\nExpected SHA256: ${baselineHash}\nReceived SHA256: ${actualHash}`
      );
    }
  } finally {
    if (existsSync(tempActualPath)) {
      unlinkSync(tempActualPath);
    }
  }
}
