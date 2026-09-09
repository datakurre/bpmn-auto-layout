# BPMN layout feedback workflow

Use this skill when evolving BPMN auto-layout behavior from visual reports and structured feedback.

## Repeatable commands

Run from the repository root inside the flake dev shell:

```sh
nix develop --command python3 tools/bpmn_feedback.py generate --output fixtures/bpmn-feedback --force
nix develop --command python3 tools/bpmn_feedback.py report fixtures/bpmn-feedback/*.bpmn
nix develop --command python3 tools/bpmn_feedback.py feedback --report .bpmn-feedback/reports/report-*/index.html
```

If no inputs are passed to `report`, it generates the deterministic fixture set in the report workspace first. The dev shell provides `bpmn-auto-layout`, `bpmn-to-image`, and `python3`.

## Report ephemerality

Reports are workspace-local and ephemeral under `.bpmn-feedback/reports/report-*` (gitignored). Each report contains:

- `index.html` with per-part original/transformed SVG images;
- copied `original.bpmn` and layout-mutated `transformed.bpmn` files;
- `metrics.json` with deterministic structural and layout metrics.

Do not treat report paths as stable artifacts. Regenerate them from source BPMN and the current implementation.

## Feedback JSON schema

`tools/bpmn_feedback.py feedback` writes `bpmn-layout-feedback/v1` JSON:

```json
{
  "schema": "bpmn-layout-feedback/v1",
  "created_at": "ISO-8601 UTC timestamp",
  "diagram": "BPMN path or diagram identifier",
  "report": "report HTML path",
  "part": "report part identifier",
  "choices": {
    "edge-crossings": false,
    "edge-overlaps-element": false,
    "label-overlaps-element": false,
    "label-too-far": false,
    "shape-spacing": false,
    "gateway-branching": false,
    "loop-routing": false,
    "subprocess-or-boundary": false,
    "lanes-or-pools": false,
    "messages-or-data": false,
    "other": false
  },
  "ratings": {
    "overall": 4,
    "readability": 4,
    "flow-clarity": 4,
    "routing-quality": 4,
    "label-quality": 4
  },
  "comments": "free text",
  "agent_ingest": { "ruleset": "docs/bpmn-layout-rules.json" }
}
```

Non-interactive example:

```sh
nix develop --command python3 tools/bpmn_feedback.py feedback \
  --non-interactive \
  --diagram fixtures/bpmn-feedback/gateways-branches-loops.bpmn \
  --report .bpmn-feedback/reports/report-abc/index.html \
  --choice loop-routing \
  --rating overall=3 --rating routing-quality=2 \
  --comment "Loop channel crosses too close to the review task" \
  --output .bpmn-feedback/feedback/loops.json
```

## Agent ingestion loop

1. Read `metrics.json` and all relevant feedback JSON.
2. Correlate selected choices and low Likert ratings with deterministic metrics.
3. Inspect current TypeScript behavior before changing rules; `docs/bpmn-layout-rules.json` is implementation-derived, not aspirational.
4. Update TypeScript, then update `docs/bpmn-layout-rules.json` from the changed implementation with source lines.
5. Rerun `report` on generated fixtures and any user-provided BPMN that motivated the feedback.
