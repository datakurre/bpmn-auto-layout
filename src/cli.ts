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

export const VERSION = '0.1.0';

export const HELP_TEXT = `Usage: bpmn-auto-layout [options] [input] [output]

Auto-layout BPMN 2.0 diagrams, generating missing DI information.

Options:
  -i, --in-place         Overwrite the input file in place
  -s, --spacing <number> Set grid spacing between elements (default: 60)
  -v, --version          Show version number
  -h, --help             Show help
`;

interface ParsedArgs {
  inPlace: boolean;
  spacing?: number;
  showHelp: boolean;
  showVersion: boolean;
  input?: string;
  output?: string;
}

function parseCliArgs(args: string[]): ParsedArgs {
  let inPlace = false;
  let spacing: number | undefined;
  let showHelp = false;
  let showVersion = false;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      showHelp = true;
    } else if (arg === '-v' || arg === '--version') {
      showVersion = true;
    } else if (arg === '-i' || arg === '--in-place') {
      inPlace = true;
    } else if (arg === '-s' || arg === '--spacing') {
      i++;
      if (i < args.length) {
        spacing = Number(args[i]);
      }
    } else {
      positional.push(arg);
    }
  }

  return {
    inPlace,
    spacing,
    showHelp,
    showVersion,
    input: positional[0],
    output: positional[1],
  };
}

export async function runCli(args: string[], io: CliIo = defaultIo): Promise<number> {
  const parsed = parseCliArgs(args);

  if (parsed.showVersion) {
    io.stdout(`${VERSION}\n`);
    return 0;
  }

  if (parsed.showHelp || !parsed.input) {
    io.stdout(HELP_TEXT);
    return 0;
  }

  try {
    const xml = io.readFile(parsed.input, 'utf-8');
    const result = await layoutProcess(xml, { gridSpacing: parsed.spacing });

    if (parsed.inPlace) {
      io.writeFile(parsed.input, result, 'utf-8');
      return 0;
    }

    if (parsed.output && parsed.output !== '-') {
      io.writeFile(parsed.output, result, 'utf-8');
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
