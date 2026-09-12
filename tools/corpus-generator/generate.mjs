#!/usr/bin/env node
// Parametric generator for a graduated benchmark corpus (#57).
//
// Generates valid BPMN *semantics* only -- no DI, no layout -- deterministically
// from (topology class, size, label load, seed). Rendering and layout are
// handled downstream by the actual engines under comparison; this tool's only
// job is to produce input they can both consume.
//
// Three directories, three owners, no ambiguity (per the issue): the curated
// fixtures/*.bpmn stay the hand-reviewed corpus and are never generated;
// fixtures/regression/*.bpmn stay minimal, hand-written, one invariant each;
// fixtures/generated/*.bpmn live here, are never hand-edited, and are fully
// reproducible by re-running this script with the same seed.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BpmnModdle } from "bpmn-moddle";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT_DIR = path.resolve(__dirname, "..", "..", "fixtures", "generated");

// ---------------------------------------------------------------------------
// Deterministic PRNG. Never use Math.random() anywhere below this point --
// "same seed, byte-identical BPMN" is the whole point of the tool.
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, list) {
  return list[Math.floor(rng() * list.length) % list.length];
}

// ---------------------------------------------------------------------------
// Label load: none / short / long. Label placement is where engines diverge
// most and where our own metrics are least validated (#57), so this axis is
// deliberately independent of topology and size.
// ---------------------------------------------------------------------------

const SHORT_WORDS = [
  "Review",
  "Approve",
  "Notify",
  "Archive",
  "Validate",
  "Prepare",
  "Dispatch",
  "Escalate",
  "Reconcile",
  "Publish",
];

const LONG_PHRASES = [
  "Review the submitted request for completeness and route it to the correct team",
  "Validate that every required supporting document has been attached and is legible",
  "Escalate the case to a senior reviewer when the automated checks cannot decide",
  "Reconcile the incoming payment against the outstanding invoices for this account",
  "Notify all stakeholders that the process has reached a terminal state",
  "Archive the finished case file according to the retention policy currently in force",
  "Prepare a summary report covering every exception raised during this run",
  "Dispatch the approved shipment to the carrier and record the tracking reference",
];

function labelFor(labelLoad, rng, index) {
  if (labelLoad === "none") return undefined;
  if (labelLoad === "short") return `${pick(rng, SHORT_WORDS)} ${index}`;
  return `${pick(rng, LONG_PHRASES)} (step ${index})`;
}

// ---------------------------------------------------------------------------
// Builder: wraps moddle element creation, incoming/outgoing bookkeeping, and
// a scope stack so nested subprocess content lands in the right
// flowElements array without a separate code path per nesting depth.
// ---------------------------------------------------------------------------

class Builder {
  constructor(moddle, prefix, rng, labelLoad) {
    this.moddle = moddle;
    this.prefix = prefix;
    this.rng = rng;
    this.labelLoad = labelLoad;
    this.counter = 0;
    this.scopes = [[]];
  }

  get flowElements() {
    return this.scopes[0];
  }

  get currentScope() {
    return this.scopes[this.scopes.length - 1];
  }

  withScope(fn) {
    const scope = [];
    this.scopes.push(scope);
    fn();
    this.scopes.pop();
    return scope;
  }

  node(type, kind) {
    this.counter += 1;
    const localType = type.replace("bpmn:", "");
    const id = `${this.prefix}_${localType}_${this.counter}`;
    const attrs = { id };
    const name = labelFor(this.labelLoad, this.rng, this.counter);
    if (name) attrs.name = name;
    void kind; // reserved for future per-kind label vocab; unused for now
    const element = this.moddle.create(type, attrs);
    element.incoming = [];
    element.outgoing = [];
    this.currentScope.push(element);
    return element;
  }

  connect(source, target) {
    this.counter += 1;
    const id = `${this.prefix}_Flow_${this.counter}`;
    const flow = this.moddle.create("bpmn:SequenceFlow", { id, sourceRef: source, targetRef: target });
    source.outgoing.push(flow);
    target.incoming.push(flow);
    this.currentScope.push(flow);
    return flow;
  }
}

// ---------------------------------------------------------------------------
// Topology builders. Each takes (builder, targetCount) and grows a graph
// until it holds roughly targetCount flow nodes (events/activities/gateways
// -- sequence flows don't count toward size), returning every start and end
// event so the caller can wire boundary-event exception paths, disconnected
// components, etc. without re-deriving them.
// ---------------------------------------------------------------------------

function countNodes(list) {
  return list.filter((el) => el.$type !== "bpmn:SequenceFlow").length;
}

function buildLinear(b, targetCount) {
  const start = b.node("bpmn:StartEvent", "event");
  let prev = start;
  const taskCount = Math.max(1, targetCount - 2);
  for (let i = 0; i < taskCount; i += 1) {
    const task = b.node("bpmn:Task", "task");
    b.connect(prev, task);
    prev = task;
  }
  const end = b.node("bpmn:EndEvent", "event");
  b.connect(prev, end);
  return { starts: [start], ends: [end] };
}

function buildBranchMerge(b, targetCount) {
  const start = b.node("bpmn:StartEvent", "event");
  let prev = start;
  while (countNodes(b.flowElements) < targetCount - 2) {
    const split = b.node("bpmn:ExclusiveGateway", "gateway");
    b.connect(prev, split);
    const branchA = b.node("bpmn:Task", "task");
    const branchB = b.node("bpmn:Task", "task");
    b.connect(split, branchA);
    b.connect(split, branchB);
    const merge = b.node("bpmn:ExclusiveGateway", "gateway");
    b.connect(branchA, merge);
    b.connect(branchB, merge);
    prev = merge;
  }
  const end = b.node("bpmn:EndEvent", "event");
  b.connect(prev, end);
  return { starts: [start], ends: [end] };
}

function buildNestedBranches(b, targetCount) {
  const start = b.node("bpmn:StartEvent", "event");
  const outerSplit = b.node("bpmn:ExclusiveGateway", "gateway");
  b.connect(start, outerSplit);
  const outerMerge = b.node("bpmn:ExclusiveGateway", "gateway");

  let innerPrev = outerSplit;
  while (countNodes(b.flowElements) < targetCount - 5) {
    const innerSplit = b.node("bpmn:ExclusiveGateway", "gateway");
    b.connect(innerPrev, innerSplit);
    const innerA = b.node("bpmn:Task", "task");
    const innerB = b.node("bpmn:Task", "task");
    b.connect(innerSplit, innerA);
    b.connect(innerSplit, innerB);
    const innerMerge = b.node("bpmn:ExclusiveGateway", "gateway");
    b.connect(innerA, innerMerge);
    b.connect(innerB, innerMerge);
    innerPrev = innerMerge;
  }
  b.connect(innerPrev, outerMerge);

  const simpleBranch = b.node("bpmn:Task", "task");
  b.connect(outerSplit, simpleBranch);
  b.connect(simpleBranch, outerMerge);

  const end = b.node("bpmn:EndEvent", "event");
  b.connect(outerMerge, end);
  return { starts: [start], ends: [end] };
}

function buildLoopBackEdge(b, targetCount) {
  const start = b.node("bpmn:StartEvent", "event");
  const loopHead = b.node("bpmn:Task", "task");
  b.connect(start, loopHead);
  const decide = b.node("bpmn:ExclusiveGateway", "gateway");
  b.connect(loopHead, decide);

  let prev = decide;
  const midTasks = [];
  while (countNodes(b.flowElements) < targetCount - 3) {
    const task = b.node("bpmn:Task", "task");
    b.connect(prev, task);
    midTasks.push(task);
    prev = task;
  }
  // The back-edge: closes a real cycle in the graph, the point of this class.
  b.connect(prev, loopHead);

  const end = b.node("bpmn:EndEvent", "event");
  b.connect(decide, end);
  return { starts: [start], ends: [end] };
}

function buildBoundaryEvents(b, targetCount) {
  const start = b.node("bpmn:StartEvent", "event");
  let prev = start;
  const exceptionEnds = [];
  while (countNodes(b.flowElements) < targetCount - 2) {
    const task = b.node("bpmn:Task", "task");
    b.connect(prev, task);

    const boundary = b.node("bpmn:BoundaryEvent", "event");
    boundary.attachedToRef = task;
    boundary.cancelActivity = true;
    boundary.eventDefinitions = [b.moddle.create("bpmn:TimerEventDefinition", {})];

    const exceptionTask = b.node("bpmn:Task", "task");
    b.connect(boundary, exceptionTask);
    const exceptionEnd = b.node("bpmn:EndEvent", "event");
    b.connect(exceptionTask, exceptionEnd);
    exceptionEnds.push(exceptionEnd);

    prev = task;
  }
  const end = b.node("bpmn:EndEvent", "event");
  b.connect(prev, end);
  return { starts: [start], ends: [end, ...exceptionEnds] };
}

function buildExpandedSubprocess(b, targetCount) {
  const start = b.node("bpmn:StartEvent", "event");
  const subProcess = b.node("bpmn:SubProcess", "subprocess");
  subProcess.triggeredByEvent = false;
  b.connect(start, subProcess);

  const inner = b.withScope(() => {
    const innerStart = b.node("bpmn:StartEvent", "event");
    let prev = innerStart;
    while (countNodes(b.currentScope) < targetCount - 4) {
      const task = b.node("bpmn:Task", "task");
      b.connect(prev, task);
      prev = task;
    }
    const innerEnd = b.node("bpmn:EndEvent", "event");
    b.connect(prev, innerEnd);
  });
  subProcess.flowElements = inner;

  const end = b.node("bpmn:EndEvent", "event");
  b.connect(subProcess, end);
  return { starts: [start], ends: [end] };
}

function buildNestedSubprocess(b, targetCount) {
  const start = b.node("bpmn:StartEvent", "event");
  const outer = b.node("bpmn:SubProcess", "subprocess");
  outer.triggeredByEvent = false;
  b.connect(start, outer);

  const outerInner = b.withScope(() => {
    const outerStart = b.node("bpmn:StartEvent", "event");
    const inner = b.node("bpmn:SubProcess", "subprocess");
    inner.triggeredByEvent = false;
    b.connect(outerStart, inner);

    const innerInner = b.withScope(() => {
      const innerStart = b.node("bpmn:StartEvent", "event");
      let prev = innerStart;
      while (countNodes(b.currentScope) < targetCount - 6) {
        const task = b.node("bpmn:Task", "task");
        b.connect(prev, task);
        prev = task;
      }
      const innerEnd = b.node("bpmn:EndEvent", "event");
      b.connect(prev, innerEnd);
    });
    inner.flowElements = innerInner;

    const outerEnd = b.node("bpmn:EndEvent", "event");
    b.connect(inner, outerEnd);
  });
  outer.flowElements = outerInner;

  const end = b.node("bpmn:EndEvent", "event");
  b.connect(outer, end);
  return { starts: [start], ends: [end] };
}

function buildDisconnectedComponents(b, targetCount) {
  const perComponent = Math.max(3, Math.round(targetCount / 3));
  const starts = [];
  const ends = [];
  while (countNodes(b.flowElements) < targetCount) {
    const { starts: s, ends: e } = buildLinear(b, perComponent);
    starts.push(...s);
    ends.push(...e);
  }
  return { starts, ends };
}

// Pool + lanes needs a different document shape (a collaboration wrapping
// the process, plus a laneSet inside it) so it is not just another
// "flowElements list -> single process" builder like the rest.
function buildPoolLanes(moddle, prefix, rng, targetCount, labelLoad) {
  const b = new Builder(moddle, prefix, rng, labelLoad);
  const laneNames = ["Intake", "Processing", "Fulfilment"];
  const laneCount = 3;
  const lanesNodes = Array.from({ length: laneCount }, () => []);

  const start = b.node("bpmn:StartEvent", "event");
  lanesNodes[0].push(start);
  let prev = start;
  let laneIndex = 0;
  // Contiguous blocks per lane (a phase of work stays in one lane before
  // handing off), not an alternating zigzag -- both more representative of
  // a real swimlane process and far cheaper to lay out: a lane transition
  // on every single node is the layout engine's pathological case.
  const blockSize = Math.max(2, Math.round((targetCount - 2) / (laneCount * 2)));
  let sinceLaneChange = 0;
  while (countNodes(b.flowElements) < targetCount - 2) {
    if (sinceLaneChange >= blockSize) {
      laneIndex = (laneIndex + 1) % laneCount;
      sinceLaneChange = 0;
    }
    const task = b.node("bpmn:Task", "task");
    b.connect(prev, task);
    lanesNodes[laneIndex].push(task);
    prev = task;
    sinceLaneChange += 1;
  }
  const end = b.node("bpmn:EndEvent", "event");
  lanesNodes[laneCount - 1].push(end);
  b.connect(prev, end);

  const process = moddle.create("bpmn:Process", {
    id: `${prefix}_Process`,
    isExecutable: false,
    flowElements: b.flowElements,
  });
  const lanes = laneNames.map((name, index) =>
    moddle.create("bpmn:Lane", { id: `${prefix}_Lane_${index + 1}`, name, flowNodeRef: lanesNodes[index] }),
  );
  process.laneSets = [moddle.create("bpmn:LaneSet", { id: `${prefix}_LaneSet`, lanes })];

  const participant = moddle.create("bpmn:Participant", {
    id: `${prefix}_Participant`,
    name: "Process",
    processRef: process,
  });
  const collaboration = moddle.create("bpmn:Collaboration", {
    id: `${prefix}_Collaboration`,
    participants: [participant],
  });

  return { rootElements: [collaboration, process] };
}

// ---------------------------------------------------------------------------
// Topology registry
// ---------------------------------------------------------------------------

const SIMPLE_TOPOLOGIES = {
  linear: buildLinear,
  "branch-merge": buildBranchMerge,
  "nested-branches": buildNestedBranches,
  "loop-back-edge": buildLoopBackEdge,
  "boundary-events": buildBoundaryEvents,
  "expanded-subprocess": buildExpandedSubprocess,
  "nested-subprocess": buildNestedSubprocess,
  "disconnected-components": buildDisconnectedComponents,
};

const POOL_LANES_TOPOLOGY = "pool-lanes";

export const TOPOLOGIES = [...Object.keys(SIMPLE_TOPOLOGIES), POOL_LANES_TOPOLOGY];

export const SIZES = { small: 5, medium: 15, large: 40 };

export const LABEL_LOADS = ["none", "short", "long"];

// The current layout engine's per-diagram cost is not linear in node count
// for every topology: a diagram that crowds many lane transitions or many
// boundary events into a small area triggers combinatorial search inside
// the engine's collision-repair/lane-ordering passes (confirmed while
// building this generator -- pool-lanes at the nominal "large" target of 40
// nodes did not finish within a 120s timeout; boundary-events likewise past
// ~24). Capping just these two classes' "large" tier to a size verified to
// finish in single-digit seconds keeps every generated file within "both
// engines accept without error" (#57's own success criterion) honest,
// without understating the size axis for the seven topologies that scale
// fine. Revisit these caps if the engine's scaling on lane/boundary-event
// diagrams improves.
const SIZE_OVERRIDES = {
  "pool-lanes": { large: 20 },
  "boundary-events": { large: 16 },
};

function resolveTargetCount(topology, size) {
  const override = SIZE_OVERRIDES[topology]?.[size];
  return override ?? SIZES[size];
}

// ---------------------------------------------------------------------------
// Referential integrity: every generated diagram must be free of dangling
// refs, duplicate ids, and incoming/outgoing mismatches before it is ever
// written to disk (#57's success criteria). Walks the full moddle tree,
// including nested subprocess content and lane flowNodeRef lists.
// ---------------------------------------------------------------------------

function collectElements(definitions) {
  const byId = new Map();
  const problems = [];

  function visit(element) {
    if (!element || typeof element !== "object" || !element.$type) return;
    const id = element.id;
    if (id) {
      if (byId.has(id)) {
        problems.push(`duplicate id: ${id}`);
      } else {
        byId.set(id, element);
      }
    }
    if (Array.isArray(element.flowElements)) {
      for (const child of element.flowElements) visit(child);
    }
    if (Array.isArray(element.rootElements)) {
      for (const child of element.rootElements) visit(child);
    }
    if (Array.isArray(element.participants)) {
      for (const child of element.participants) visit(child);
    }
    if (Array.isArray(element.laneSets)) {
      for (const child of element.laneSets) visit(child);
    }
    if (Array.isArray(element.lanes)) {
      for (const child of element.lanes) visit(child);
    }
  }
  for (const root of definitions.rootElements) visit(root);
  return { byId, problems };
}

export function validateReferentialIntegrity(definitions) {
  const { byId, problems } = collectElements(definitions);

  function walkFlowElements(list) {
    for (const element of list ?? []) {
      if (element.$type === "bpmn:SequenceFlow") {
        const sourceId = element.sourceRef?.id;
        const targetId = element.targetRef?.id;
        if (!sourceId || !byId.has(sourceId)) {
          problems.push(`${element.id}: sourceRef does not resolve (${sourceId ?? "missing"})`);
        } else if (!byId.get(sourceId).outgoing?.includes(element)) {
          problems.push(`${element.id}: source ${sourceId} is missing this flow in its outgoing list`);
        }
        if (!targetId || !byId.has(targetId)) {
          problems.push(`${element.id}: targetRef does not resolve (${targetId ?? "missing"})`);
        } else if (!byId.get(targetId).incoming?.includes(element)) {
          problems.push(`${element.id}: target ${targetId} is missing this flow in its incoming list`);
        }
      }
      if (Array.isArray(element.flowElements)) walkFlowElements(element.flowElements);
    }
  }
  for (const root of definitions.rootElements) {
    if (Array.isArray(root.flowElements)) walkFlowElements(root.flowElements);
  }

  for (const [id, element] of byId) {
    for (const flow of element.incoming ?? []) {
      if (!byId.has(flow.id)) problems.push(`${id}: incoming references unresolved flow ${flow.id}`);
    }
    for (const flow of element.outgoing ?? []) {
      if (!byId.has(flow.id)) problems.push(`${id}: outgoing references unresolved flow ${flow.id}`);
    }
    if (element.attachedToRef && !byId.has(element.attachedToRef.id)) {
      problems.push(`${id}: attachedToRef does not resolve (${element.attachedToRef.id})`);
    }
    for (const ref of element.flowNodeRef ?? []) {
      if (!byId.has(ref.id)) problems.push(`${id}: flowNodeRef does not resolve (${ref.id})`);
    }
    if (element.processRef && !byId.has(element.processRef.id)) {
      problems.push(`${id}: processRef does not resolve (${element.processRef.id})`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Document assembly and generation
// ---------------------------------------------------------------------------

function seedFromString(value) {
  // Deterministic FNV-1a-style string hash -- never Math.random().
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

async function buildDefinitions(moddle, topology, size, labelLoad, seed) {
  if (!SIZES[size]) throw new Error(`unknown size: ${size}`);
  const targetCount = resolveTargetCount(topology, size);
  const prefix = `Gen_${topology.replace(/-/g, "_")}_${size}`;
  const rngSeed = seedFromString(`${topology}:${size}:${labelLoad}:${seed}`);
  const rng = mulberry32(rngSeed);

  let rootElements;
  if (topology === POOL_LANES_TOPOLOGY) {
    ({ rootElements } = buildPoolLanes(moddle, prefix, rng, targetCount, labelLoad));
  } else {
    const build = SIMPLE_TOPOLOGIES[topology];
    if (!build) throw new Error(`unknown topology: ${topology}`);
    const b = new Builder(moddle, prefix, rng, labelLoad);
    build(b, targetCount);
    const process = moddle.create("bpmn:Process", { id: `${prefix}_Process`, isExecutable: false, flowElements: b.flowElements });
    rootElements = [process];
  }

  const definitions = moddle.create("bpmn:Definitions", {
    id: `Definitions_${prefix}`,
    targetNamespace: "https://github.com/datakurre/bpmn-auto-layout/generated-fixtures",
    rootElements,
  });

  // Document the generating parameters *in* the file so a regression traces
  // back to a topology and seed, not to "diagram 47" (#57 success criteria).
  const documentation = moddle.create("bpmn:Documentation", {
    text: `Generated by tools/corpus-generator/generate.mjs -- topology=${topology} size=${size} (target ${targetCount} flow nodes) labelLoad=${labelLoad} seed=${seed}. Do not hand-edit; regenerate instead.`,
  });
  const mainProcess = rootElements.find((el) => el.$type === "bpmn:Process");
  mainProcess.documentation = [documentation];

  const problems = validateReferentialIntegrity(definitions);
  if (problems.length > 0) {
    throw new Error(`referential integrity check failed for ${prefix}:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  }

  return definitions;
}

export async function generateOne(moddle, topology, size, labelLoad, seed) {
  const definitions = await buildDefinitions(moddle, topology, size, labelLoad, seed);
  const { xml } = await moddle.toXML(definitions, { format: true });
  return xml;
}

function filenameFor(topology, size, labelLoad, seed) {
  return `${topology}-${size}-${labelLoad}-seed${seed}.bpmn`;
}

async function main() {
  const args = process.argv.slice(2);
  const options = { seed: 1, outDir: DEFAULT_OUT_DIR, topology: null, size: null, labelLoad: null };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--seed") options.seed = Number(args[++i]);
    else if (arg === "--out") options.outDir = path.resolve(args[++i]);
    else if (arg === "--topology") options.topology = args[++i];
    else if (arg === "--size") options.size = args[++i];
    else if (arg === "--label-load") options.labelLoad = args[++i];
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "usage: generate.mjs [--seed N] [--out DIR] [--topology NAME] [--size small|medium|large] [--label-load none|short|long]\n" +
          "  Omit --topology/--size/--label-load to generate the full matrix.",
      );
      return;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  const topologies = options.topology ? [options.topology] : TOPOLOGIES;
  const sizes = options.size ? [options.size] : Object.keys(SIZES);
  const labelLoads = options.labelLoad ? [options.labelLoad] : LABEL_LOADS;

  await mkdir(options.outDir, { recursive: true });
  const moddle = new BpmnModdle();
  let count = 0;
  for (const topology of topologies) {
    for (const size of sizes) {
      for (const labelLoad of labelLoads) {
        const xml = await generateOne(moddle, topology, size, labelLoad, options.seed);
        const filename = filenameFor(topology, size, labelLoad, options.seed);
        await writeFile(path.join(options.outDir, filename), xml, "utf8");
        count += 1;
      }
    }
  }
  console.log(`generated ${count} files under ${options.outDir}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error.stack || String(error));
    process.exitCode = 1;
  });
}
