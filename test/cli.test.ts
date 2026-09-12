import { describe, it, expect, vi } from 'vitest';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { runCli, HELP_TEXT, type CliIo } from '../src/cli';

const sampleBpmn = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:startEvent id="StartEvent_1" />
  </bpmn:process>
</bpmn:definitions>`;

describe('cli', () => {
  it('prints help when no arguments provided', async () => {
    let stdoutOutput = '';
    const io: CliIo = {
      stdout: (msg) => {
        stdoutOutput += msg;
      },
      stderr: () => {},
      readFile: () => '',
      writeFile: () => {},
    };

    const code = await runCli([], io);
    expect(code).toBe(0);
    expect(stdoutOutput).toBe(HELP_TEXT);
  });

  it('prints help when -h or --help is passed', async () => {
    let stdoutOutput = '';
    const io: CliIo = {
      stdout: (msg) => {
        stdoutOutput += msg;
      },
      stderr: () => {},
      readFile: () => '',
      writeFile: () => {},
    };

    const code1 = await runCli(['-h'], io);
    expect(code1).toBe(0);
    expect(stdoutOutput).toBe(HELP_TEXT);

    stdoutOutput = '';
    const code2 = await runCli(['--help'], io);
    expect(code2).toBe(0);
    expect(stdoutOutput).toBe(HELP_TEXT);
  });

  it('outputs layouted BPMN to stdout when no output file is provided', async () => {
    let stdoutOutput = '';
    const io: CliIo = {
      stdout: (msg) => {
        stdoutOutput += msg;
      },
      stderr: () => {},
      readFile: () => sampleBpmn,
      writeFile: () => {},
    };

    const code = await runCli(['input.bpmn'], io);
    expect(code).toBe(0);
    expect(stdoutOutput).toContain('Process_1');
  });

  it('outputs layouted BPMN to stdout when output is "-"', async () => {
    let stdoutOutput = '';
    const io: CliIo = {
      stdout: (msg) => {
        stdoutOutput += msg;
      },
      stderr: () => {},
      readFile: () => sampleBpmn,
      writeFile: () => {},
    };

    const code = await runCli(['input.bpmn', '-'], io);
    expect(code).toBe(0);
    expect(stdoutOutput).toContain('Process_1');
  });

  it('writes layouted BPMN to output file when path provided', async () => {
    let writtenFile = '';
    let writtenContent = '';
    const io: CliIo = {
      stdout: () => {},
      stderr: () => {},
      readFile: () => sampleBpmn,
      writeFile: (file, content) => {
        writtenFile = file;
        writtenContent = content;
      },
    };

    const code = await runCli(['input.bpmn', 'output.bpmn'], io);
    expect(code).toBe(0);
    expect(writtenFile).toBe('output.bpmn');
    expect(writtenContent).toContain('Process_1');
  });

  it('handles Error instances and writes to stderr', async () => {
    let stderrOutput = '';
    const io: CliIo = {
      stdout: () => {},
      stderr: (msg) => {
        stderrOutput += msg;
      },
      readFile: () => {
        throw new Error('File not found');
      },
      writeFile: () => {},
    };

    const code = await runCli(['missing.bpmn'], io);
    expect(code).toBe(1);
    expect(stderrOutput).toContain('Error: File not found');
  });

  it('handles non-Error thrown values and writes to stderr', async () => {
    let stderrOutput = '';
    const io: CliIo = {
      stdout: () => {},
      stderr: (msg) => {
        stderrOutput += msg;
      },
      readFile: () => {
        throw 'Unexpected string error';
      },
      writeFile: () => {},
    };

    const code = await runCli(['bad.bpmn'], io);
    expect(code).toBe(1);
    expect(stderrOutput).toContain('Error: Unexpected string error');
  });

  it('uses defaultIo correctly when called without custom io', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const tempIn = 'temp-test-input.bpmn';
    const tempOut = 'temp-test-output.bpmn';

    try {
      // Test default stdout
      const codeHelp = await runCli(['--help']);
      expect(codeHelp).toBe(0);
      expect(stdoutSpy).toHaveBeenCalledWith(HELP_TEXT);

      // Test default readFile and writeFile
      writeFileSync(tempIn, sampleBpmn, 'utf-8');
      const codeFile = await runCli([tempIn, tempOut]);
      expect(codeFile).toBe(0);
      expect(existsSync(tempOut)).toBe(true);

      // Test default stderr
      const codeError = await runCli(['nonexistent-test-file-12345.bpmn']);
      expect(codeError).toBe(1);
      expect(stderrSpy).toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      if (existsSync(tempIn)) {
        unlinkSync(tempIn);
      }
      if (existsSync(tempOut)) {
        unlinkSync(tempOut);
      }
    }
  });
});
