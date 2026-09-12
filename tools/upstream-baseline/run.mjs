#!/usr/bin/env node
// Transform a single BPMN file in place using the pinned upstream
// bpmn-io/bpmn-auto-layout engine, so tools/bpmn_feedback.py's --engine
// mechanism can drive it exactly like our own layout command (#54). Requires
// `npm install --prefix tools/upstream-baseline` to have run first.
import { readFile, writeFile } from "node:fs/promises";
import { layoutProcess } from "bpmn-auto-layout";

const file = process.argv[2];
if (!file) {
  console.error("usage: run.mjs FILE.bpmn");
  process.exit(2);
}
const xml = await readFile(file, "utf8");
await writeFile(file, await layoutProcess(xml));
