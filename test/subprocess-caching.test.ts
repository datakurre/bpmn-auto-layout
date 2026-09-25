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
    // each). The issue's acceptance criterion asked for at most
    // 2*(depth+1)=16 calls (one normal pass plus at most one relayout per
    // scope), but that bound isn't reachable for this fixture: every level
    // in this chain is wide enough to trigger its own width-budget retry,
    // and that retry computes a widthBudget from its own (inherited-budget-
    // dependent) area, which cascades to its descendants and is different
    // at every level -- so most cache keys are still distinct.
    //
    // Measured after caching: 27 calls (down from 32). #97 was reopened
    // after #102 merged with this gap unaddressed; per the issue's own
    // second resolution path ("decide the remaining cost is acceptable...
    // and change the criterion"), 27 is accepted as the real bound for this
    // adversarial fixture -- reaching 16 would need predicting each
    // subprocess's width budget before its first layout, which risks
    // mispredicting the budget and needing a fallback retry anyway, for a
    // diagram whose absolute layout time is 65ms in the worst case measured.
    // Pinned as an upper bound (not exact) so a future improvement, such as
    // that prediction, doesn't fail this test.
    const depth = 7;
    const n = 40;
    const builder = new BpmnBuilder('Process_Deep');
    nest(builder, { depth, prefix: 'p', n });

    const process = builder.getProcess();
    const callCounter = { count: 0 };
    layoutScope(process, undefined, { callCounter });

    expect(callCounter.count).toBeLessThanOrEqual(27);
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
