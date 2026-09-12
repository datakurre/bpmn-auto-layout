# bpmn-auto-layout

Auto-layout BPMN 2.0 diagrams, generating missing DI (Diagram Interchange) information.

## Installation

```bash
npm install bpmn-auto-layout
```

## Usage

```typescript
import { layoutProcess } from 'bpmn-auto-layout';

const layoutedXml = await layoutProcess(rawBpmnXml);
```

### CLI

```bash
npx bpmn-auto-layout input.bpmn [output.bpmn]
```

## Development

Use the Nix development shell:

```bash
nix develop --command <command>
```

Available scripts:

```bash
npm run build        # Build bundle (ESM/CJS) and type declarations (.d.ts)
npm run typecheck    # Run TypeScript type check
npm test             # Run test suite with Vitest
npm run lint         # Run ESLint
npm run format       # Format code with Prettier
```

## License

MIT
