import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const SNAPSHOTS_DIR = join(__dirname, '../snapshots');

function verifyBpmnSnapshot(xml: string, snapshotName: string, updateSnapshots: boolean): void {
  const bpmnPath = join(SNAPSHOTS_DIR, `${snapshotName}.bpmn`);
  const normalizedXml = xml.replace(/\r\n/g, '\n');

  if (updateSnapshots || !existsSync(bpmnPath)) {
    writeFileSync(bpmnPath, normalizedXml, 'utf8');
    return;
  }

  const baselineXml = readFileSync(bpmnPath, 'utf8').replace(/\r\n/g, '\n');
  if (normalizedXml !== baselineXml) {
    throw new Error(
      `BPMN XML snapshot mismatch for "${snapshotName}".\n` +
        `Run with UPDATE_SNAPSHOTS=true to update baselines if this change was intended.`
    );
  }
}

function verifyImageSnapshot(xml: string, snapshotName: string, updateSnapshots: boolean): void {
  const snapshotPath = join(SNAPSHOTS_DIR, `${snapshotName}.png`);
  const tempActualPath = `/tmp/${snapshotName}_actual.png`;

  try {
    execFileSync(
      'bpmn-to-image',
      ['--background', 'white', '--format', 'png', '--scale', '2', '-', tempActualPath],
      { input: xml }
    );

    const actualBuffer = readFileSync(tempActualPath);

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

export function expectSnapshotMatch(xml: string, snapshotName: string): void {
  if (!existsSync(SNAPSHOTS_DIR)) {
    mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  }

  const updateSnapshots = process.env.UPDATE_SNAPSHOTS === 'true';
  verifyBpmnSnapshot(xml, snapshotName, updateSnapshots);
  verifyImageSnapshot(xml, snapshotName, updateSnapshots);
}

export const expectImageSnapshotMatch = expectSnapshotMatch;
