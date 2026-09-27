import { BpmnBuilder } from '../../src/bpmn-builder';

export interface MotifPorts {
  entry: string;
  exit: string;
}

/** Linear task chain, like iteration 02's five-node chain. */
export function chainSegment(builder: BpmnBuilder, prefix: string, length = 3): MotifPorts {
  const ids = Array.from({ length }, (_, i) => `${prefix}_task${i}`);
  ids.forEach((id, i) => {
    builder.addTask(id, `Step ${id}`);
    if (i > 0) {
      builder.addSequenceFlow(`${prefix}_cf${i}`, ids[i - 1], id);
    }
  });
  return { entry: ids[0], exit: ids[ids.length - 1] };
}

/** N-way exclusive split/join, like iteration 03's branching fixtures. */
export function exclusiveBranchJoin(
  builder: BpmnBuilder,
  prefix: string,
  branches = 3
): MotifPorts {
  const split = `${prefix}_xsplit`;
  const join = `${prefix}_xjoin`;
  builder.addExclusiveGateway(split, 'Split').addExclusiveGateway(join, 'Join');
  for (let i = 0; i < branches; i++) {
    const taskId = `${prefix}_xtask${i}`;
    builder
      .addTask(taskId, `Branch ${i}`)
      .addSequenceFlow(`${prefix}_xin${i}`, split, taskId)
      .addSequenceFlow(`${prefix}_xout${i}`, taskId, join);
  }
  return { entry: split, exit: join };
}

/** N-way parallel fork/join, like iteration 09's order fulfillment fixture. */
export function parallelSplitJoin(builder: BpmnBuilder, prefix: string, branches = 3): MotifPorts {
  const split = `${prefix}_psplit`;
  const join = `${prefix}_pjoin`;
  builder.addParallelGateway(split, 'Fork').addParallelGateway(join, 'Sync');
  for (let i = 0; i < branches; i++) {
    const taskId = `${prefix}_ptask${i}`;
    builder
      .addTask(taskId, `Parallel ${i}`)
      .addSequenceFlow(`${prefix}_pin${i}`, split, taskId)
      .addSequenceFlow(`${prefix}_pout${i}`, taskId, join);
  }
  return { entry: split, exit: join };
}

/** Task with a feedback retry cycle, like iteration 04's retry loop. */
export function retryLoop(builder: BpmnBuilder, prefix: string): MotifPorts {
  const taskId = `${prefix}_rtask`;
  const gatewayId = `${prefix}_rgw`;
  builder
    .addTask(taskId, 'Attempt')
    .addExclusiveGateway(gatewayId, 'Succeeded?')
    .addSequenceFlow(`${prefix}_reval`, taskId, gatewayId)
    .addSequenceFlow(`${prefix}_rback`, gatewayId, taskId);
  return { entry: taskId, exit: gatewayId };
}

/** Task with a boundary error event routed to a handler that rejoins, like iteration 05. */
export function boundaryExceptionTask(builder: BpmnBuilder, prefix: string): MotifPorts {
  const taskId = `${prefix}_btask`;
  const boundaryId = `${prefix}_bevt`;
  const handlerId = `${prefix}_bhandler`;
  const joinId = `${prefix}_bjoin`;
  builder
    .addTask(taskId, 'Risky Step')
    .addBoundaryEvent({
      id: boundaryId,
      attachedToRef: taskId,
      name: 'Error',
      eventDefinitionType: 'bpmn:ErrorEventDefinition',
    })
    .addTask(handlerId, 'Handle Error')
    .addExclusiveGateway(joinId, 'Join')
    .addSequenceFlow(`${prefix}_bok`, taskId, joinId)
    .addSequenceFlow(`${prefix}_berr`, boundaryId, handlerId)
    .addSequenceFlow(`${prefix}_brejoin`, handlerId, joinId);
  return { entry: taskId, exit: joinId };
}

/** Expanded subprocess wrapping a short inner chain, like iteration 06. */
export function miniSubprocess(builder: BpmnBuilder, prefix: string): MotifPorts {
  const subId = `${prefix}_sub`;
  const innerStart = `${prefix}_sub_start`;
  const innerTask = `${prefix}_sub_task`;
  const innerEnd = `${prefix}_sub_end`;
  builder.addSubProcess(subId, 'Embedded Work', (sub) => {
    sub
      .addStartEvent(innerStart)
      .addTask(innerTask, 'Inner Task')
      .addEndEvent(innerEnd)
      .addSequenceFlow(`${prefix}_sub_f1`, innerStart, innerTask)
      .addSequenceFlow(`${prefix}_sub_f2`, innerTask, innerEnd);
  });
  return { entry: subId, exit: subId };
}

type MotifFn = (builder: BpmnBuilder, prefix: string) => MotifPorts;

/**
 * Fixed, index-based motif cycle (no randomness) so composed diagrams stay
 * bitwise deterministic across runs, matching this repo's determinism
 * guarantee (see iteration 08).
 */
const MOTIF_CYCLE: MotifFn[] = [
  (b, p) => chainSegment(b, p),
  (b, p) => exclusiveBranchJoin(b, p),
  (b, p) => parallelSplitJoin(b, p),
  (b, p) => retryLoop(b, p),
  (b, p) => boundaryExceptionTask(b, p),
  (b, p) => miniSubprocess(b, p),
];

const FLOW_NODE_TAG_PATTERN =
  /<bpmn:(startEvent|endEvent|task|exclusiveGateway|parallelGateway|inclusiveGateway|eventBasedGateway|complexGateway|intermediateCatchEvent|intermediateThrowEvent|boundaryEvent|subProcess|adHocSubProcess)[ >]/g;
const SEQUENCE_FLOW_TAG_PATTERN = /<bpmn:sequenceFlow[ >]/g;

export interface ScaledProcessConfig {
  repeats: number;
  processId?: string;
}

export interface ScaledProcessResult {
  xml: string;
  nodeCount: number;
  edgeCount: number;
}

/**
 * Composes `config.repeats` motifs from the fixed cycle above into one
 * end-to-end process, wiring each motif's exit into the next motif's entry.
 */
export async function composeScaledProcess(
  config: ScaledProcessConfig
): Promise<ScaledProcessResult> {
  const builder = new BpmnBuilder(config.processId ?? 'Process_Scale');
  const startId = 'scale_start';
  const endId = 'scale_end';
  builder.addStartEvent(startId, 'Start');

  let previousExit = startId;
  for (let i = 0; i < config.repeats; i++) {
    const motif = MOTIF_CYCLE[i % MOTIF_CYCLE.length];
    const prefix = `r${i}`;
    const ports = motif(builder, prefix);
    builder.addSequenceFlow(`${prefix}_link_in`, previousExit, ports.entry);
    previousExit = ports.exit;
  }

  builder.addEndEvent(endId, 'End').addSequenceFlow('scale_link_end', previousExit, endId);

  const xml = await builder.toXml();
  const nodeCount = xml.match(FLOW_NODE_TAG_PATTERN)?.length ?? 0;
  const edgeCount = xml.match(SEQUENCE_FLOW_TAG_PATTERN)?.length ?? 0;
  return { xml, nodeCount, edgeCount };
}
