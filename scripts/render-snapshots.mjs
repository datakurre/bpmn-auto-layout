import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const snapshotsDir = join(__dirname, '../test/snapshots');

const files = readdirSync(snapshotsDir)
  .filter((file) => file.endsWith('.bpmn'))
  .sort();

console.log(`Rendering ${files.length} BPMN snapshot diagrams to PNG...`);

for (const file of files) {
  const bpmnPath = join(snapshotsDir, file);
  const pngFile = file.replace(/\.bpmn$/, '.png');
  const pngPath = join(snapshotsDir, pngFile);

  console.log(`Rendering ${file} -> ${pngFile}...`);
  execFileSync(
    'bpmn-to-image',
    ['--background', 'white', '--format', 'png', '--scale', '2', bpmnPath, pngPath],
    { stdio: 'inherit' }
  );
}

console.log(`Successfully rendered ${files.length} snapshots.`);
