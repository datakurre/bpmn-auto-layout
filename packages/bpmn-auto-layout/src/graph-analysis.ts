/**
 * Graph-structure validation helpers.
 *
 * These run before any layout computation so that structural errors are
 * surfaced with clear messages instead of crashing deep inside routing.
 */

/**
 * A `bpmn:SequenceFlow` whose `sourceRef`/`targetRef` belong to a different
 * immediate flow-element container -- a `bpmn:Process`, or a nested
 * `bpmn:SubProcess` -- than the flow itself, is not valid BPMN: a flow can
 * only connect elements within the exact container that owns it.  Left
 * undetected this used to surface as a bare `Cannot read properties of
 * undefined (reading '$type')` deep in track/waypoint computation, which
 * named neither the flow nor why it was malformed.
 */
export function assertNoCrossProcessFlows(processes: any[]): void {
  const containerOf = new Map<string, string>();
  const visit = (nodes: any[], containerId: string): void => {
    for (const node of nodes) {
      containerOf.set(node.id, containerId);
      if (node.flowElements)
        visit(node.flowElements, node.$type === "bpmn:SubProcess" ? node.id : containerId);
    }
  };
  for (const process of processes) {
    visit(process.flowElements || [], process.id);
  }
  for (const flow of processes.flatMap((process) => flattenFlowsOf(process.flowElements || []))) {
    const ownContainer = containerOf.get(flow.id);
    const srcContainer = flow.sourceRef && containerOf.get(flow.sourceRef.id);
    const tgtContainer = flow.targetRef && containerOf.get(flow.targetRef.id);
    if (srcContainer && srcContainer !== ownContainer) {
      throw new Error(
        `${flow.id} belongs to '${ownContainer}' but its source '${flow.sourceRef.id}' lives in '${srcContainer}' -- a sequence flow cannot cross between processes or subprocesses`,
      );
    }
    if (tgtContainer && tgtContainer !== ownContainer) {
      throw new Error(
        `${flow.id} belongs to '${ownContainer}' but its target '${flow.targetRef.id}' lives in '${tgtContainer}' -- a sequence flow cannot cross between processes or subprocesses`,
      );
    }
  }
}

/** Recursively collect every SequenceFlow in a flowElements tree. */
export function flattenFlowsOf(nodes: any[]): any[] {
  return nodes.flatMap((node) => [
    ...(node.$type === "bpmn:SequenceFlow" ? [node] : []),
    ...(node.flowElements ? flattenFlowsOf(node.flowElements) : []),
  ]);
}
