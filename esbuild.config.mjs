import { build, context } from 'esbuild';

/** @type {import('esbuild').BuildOptions} */
const esmConfig = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: 'dist/index.js',
  sourcemap: true,
  external: ['bpmn-js', 'bpmn-js/*', 'bpmn-moddle', 'bpmn-moddle/*'],
};

/** @type {import('esbuild').BuildOptions} */
const cjsConfig = {
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: 'dist/index.cjs',
  sourcemap: true,
  external: ['bpmn-js', 'bpmn-js/*', 'bpmn-moddle', 'bpmn-moddle/*'],
};

/** @type {import('esbuild').BuildOptions} */
const cliConfig = {
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: 'dist/cli.js',
  sourcemap: true,
  banner: {
    js: '#!/usr/bin/env node\n',
  },
  external: ['bpmn-js', 'bpmn-js/*', 'bpmn-moddle', 'bpmn-moddle/*'],
};

const configs = [esmConfig, cjsConfig, cliConfig];

const isWatch = process.argv.includes('--watch');

if (isWatch) {
  const contexts = await Promise.all(configs.map((config) => context(config)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log('Watching for changes...');
} else {
  await Promise.all(configs.map((config) => build(config)));
}
