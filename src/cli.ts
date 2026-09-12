import { readFileSync, writeFileSync } from 'node:fs';
import { layoutProcess } from './index';

export interface CliIo {
  stdout: (data: string) => void;
  stderr: (data: string) => void;
  readFile: (path: string, encoding: 'utf-8') => string;
  writeFile: (path: string, data: string, encoding: 'utf-8') => void;
}

const defaultIo: CliIo = {
  stdout: (data) => {
    process.stdout.write(data);
  },
  stderr: (data) => {
    process.stderr.write(data);
  },
  readFile: (path, encoding) => readFileSync(path, encoding),
  writeFile: (path, data, encoding) => {
    writeFileSync(path, data, encoding);
  },
};

export const HELP_TEXT = 'Usage: bpmn-auto-layout <input.bpmn> [output.bpmn]\n';

export async function runCli(args: string[], io: CliIo = defaultIo): Promise<number> {
  const [input, output] = args;

  if (!input || input === '-h' || input === '--help') {
    io.stdout(HELP_TEXT);
    return 0;
  }

  try {
    const xml = io.readFile(input, 'utf-8');
    const result = await layoutProcess(xml);

    if (output && output !== '-') {
      io.writeFile(output, result, 'utf-8');
    } else {
      io.stdout(result);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`Error: ${message}\n`);
    return 1;
  }
}

/* v8 ignore start */
const isMain =
  process.argv[1] && (process.argv[1].endsWith('cli.js') || process.argv[1].endsWith('cli.ts'));

if (isMain) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
/* v8 ignore stop */
