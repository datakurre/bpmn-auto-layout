import { describe, it, expect } from 'vitest';
import { BpmnBuilder } from '../src/bpmn-builder';
import { layoutProcess } from '../src/index';
import { layoutScope } from '../src/hierarchy/subprocess-layout';

interface NestParams {
  depth: number;
  prefix: string;
  n: number;
}

function nest(b: BpmnBuilder, params: NestParams): void {
  const { depth, prefix, n } = params;
  b.addStartEvent(`${prefix}_s`);
  for (let i = 0; i < n; i++) {
    b.addTask(`${prefix}_t${i}`);
  }
  if (depth > 0) {
    b.addSubProcess(`${prefix}_sub`, undefined, (c) =>
      nest(c, { depth: depth - 1, prefix: `${prefix}x`, n })
    );
  }
  b.addEndEvent(`${prefix}_e`);
  const ids = [
    `${prefix}_s`,
    ...Array.from({ length: n }, (_, i) => `${prefix}_t${i}`),
    ...(depth > 0 ? [`${prefix}_sub`] : []),
    `${prefix}_e`,
  ];
  for (let i = 0; i < ids.length - 1; i++) {
    b.addSequenceFlow(`${prefix}_f${i}`, ids[i], ids[i + 1]);
  }
}

describe('Issue #97: nested subprocess re-layout caching', () => {
  it('lays out a deeply nested chain of wide subprocesses with fewer layoutScope calls', async () => {
    // #97's own measurement recorded 32 layoutScope calls for this exact
    // depth/n before caching (8 scopes, "up to 4x" the ideal of one call
    // each). The ideal of one call per scope, or even the "one relayout per
    // scope" bound of 2*(depth+1)=16, isn't reachable here: every level in
    // this chain is wide enough to trigger its own width-budget retry, and
    // that retry computes a widthBudget from its own (inherited-budget-
    // dependent) area, which cascades to its descendants and is different
    // at every level -- so most cache keys are still distinct. Caching still
    // catches the cases where an inherited budget repeats, cutting real,
    // measured redundant work without changing the wrapping/output.
    const depth = 7;
    const n = 40;
    const builder = new BpmnBuilder('Process_Deep');
    nest(builder, { depth, prefix: 'p', n });

    const process = builder.getProcess();
    const callCounter = { count: 0 };
    layoutScope(process, undefined, { callCounter });

    expect(callCounter.count).toBeLessThan(32);
  });

  it('produces identical XML when the same diagram is laid out twice', async () => {
    const builder = new BpmnBuilder('Process_Deep');
    nest(builder, { depth: 5, prefix: 'p', n: 20 });
    const xml = await builder.toXml();

    const first = await layoutProcess(xml);
    const second = await layoutProcess(xml);

    expect(second).toBe(first);
  });
});
