# BPMN Auto Layout

Private, copyable BPMN layout utilities used by graph-agent.

```ts
import { layoutProcess, ensureLabelDi } from "bpmn-auto-layout";

const laidOut = await layoutProcess(xml);
const complete = await ensureLabelDi(laidOut);
```

`layoutProcess` accepts BPMN XML and returns BPMN XML with generated BPMN DI
for every top-level process, including orthogonal sequence-flow routing and
external labels. The layout operates on standard BPMN and BPMN DI types, so
Camunda 8- or Zeebe-specific moddle packages are not required.

The package is private and is not published. To reuse it in another project,
copy this directory and install its dependencies before running `npm run build`.
