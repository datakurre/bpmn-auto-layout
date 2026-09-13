import type { AutoLayoutOptions } from '../types';

function getRefId(ref: any): string | undefined {
  if (!ref) {
    return undefined;
  }
  if (typeof ref === 'string') {
    return ref;
  }
  return ref.id;
}

interface FlowEntry {
  flow: any;
  containerId: string;
}

interface FlowCollectorContext {
  containerOf: Map<string, string>;
  flows: FlowEntry[];
}

function collectContainersAndFlows(
  elements: any[],
  containerId: string,
  ctx: FlowCollectorContext
): void {
  for (const el of elements) {
    if (el.$type === 'bpmn:SequenceFlow') {
      ctx.flows.push({ flow: el, containerId });
    } else {
      ctx.containerOf.set(el.id, containerId);
      if (Array.isArray(el.flowElements)) {
        collectContainersAndFlows(el.flowElements, el.id, ctx);
      }
    }
  }
}

function checkFlowEndpoints(
  entry: FlowEntry,
  containerOf: Map<string, string>
): string | undefined {
  const srcId = getRefId(entry.flow.sourceRef);
  if (!srcId || !containerOf.has(srcId)) {
    return `Sequence flow "${entry.flow.id}" references unresolvable sourceRef "${srcId || 'undefined'}"`;
  }

  const tgtId = getRefId(entry.flow.targetRef);
  if (!tgtId || !containerOf.has(tgtId)) {
    return `Sequence flow "${entry.flow.id}" references unresolvable targetRef "${tgtId || 'undefined'}"`;
  }

  return undefined;
}

function checkFlowBoundaries(
  entry: FlowEntry,
  containerOf: Map<string, string>
): string | undefined {
  const srcId = getRefId(entry.flow.sourceRef)!;
  const tgtId = getRefId(entry.flow.targetRef)!;

  const srcContainer = containerOf.get(srcId);
  if (srcContainer !== entry.containerId) {
    return `Sequence flow "${entry.flow.id}" belongs to container "${entry.containerId}" but its source "${srcId}" lives in container "${srcContainer}" -- sequence flows cannot cross container boundaries`;
  }

  const tgtContainer = containerOf.get(tgtId);
  if (tgtContainer !== entry.containerId) {
    return `Sequence flow "${entry.flow.id}" belongs to container "${entry.containerId}" but its target "${tgtId}" lives in container "${tgtContainer}" -- sequence flows cannot cross container boundaries`;
  }

  return undefined;
}

function validateSingleFlow(
  entry: FlowEntry,
  containerOf: Map<string, string>
): string | undefined {
  return checkFlowEndpoints(entry, containerOf) || checkFlowBoundaries(entry, containerOf);
}

export function validateFlowContainers(definitions: any, options?: AutoLayoutOptions): string[] {
  const ctx: FlowCollectorContext = {
    containerOf: new Map<string, string>(),
    flows: [],
  };
  const warnings: string[] = [];

  const rootElements = definitions?.rootElements || [];
  for (const root of rootElements) {
    if (root.$type === 'bpmn:Process') {
      collectContainersAndFlows(root.flowElements || [], root.id, ctx);
    }
  }

  for (const entry of ctx.flows) {
    const errorMsg = validateSingleFlow(entry, ctx.containerOf);
    if (errorMsg) {
      if (!options?.lenientFlowValidation) {
        throw new Error(errorMsg);
      }
      warnings.push(errorMsg);
    }
  }

  return warnings;
}
