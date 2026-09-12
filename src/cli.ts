import { readFileSync, writeFileSync } from 'node:fs';
import { layoutProcess } from './index';

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const input = args[0];
  const output = args[1];

  if (!input || input === '-h' || input === '--help') {
    console.log('Usage: bpmn-auto-layout <input.bpmn> [output.bpmn]');
    process.exit(0);
  }

  const xml = readFileSync(input, 'utf-8');
  const result = await layoutProcess(xml);

  if (output && output !== '-') {
    writeFileSync(output, result, 'utf-8');
  } else {
    process.stdout.write(result);
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
