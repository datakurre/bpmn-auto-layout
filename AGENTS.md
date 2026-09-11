## Agent Sandbox

```toml agent-sandbox
[network]
allowed_hosts = [
    "*.nixos.org:443",
    "*.github.com:443",
    "*.cachix.org:443",
    "registry.npmjs.org:443",
]

[ports]
web = 8000
```

## BPMN layout iteration

Use the repository-local skill at `.agents/skills/iterate-bpmn-auto-layout/SKILL.md`
when changing the layout algorithm or reviewing generated diagrams. The
feedback loop is intentionally a first version: reports and metrics help find
problems, but they do not replace human visual review or prove that a layout is
correct.

### 1. Develop the layout algorithm

1. Reproduce the issue with the smallest BPMN input possible. If the
   reproduction is a single, isolable concern (not a realistic diagram),
   persist it under `fixtures/regression/` instead of a scratch file so the
   next iteration does not have to rediscover it.
2. Run the deterministic fixture self-test against the persisted fixture set,
   and the regression fixtures against their pinned invariants:

   ```sh
   nix develop --command python3 tools/bpmn_feedback.py selftest
   nix develop --command python3 tools/bpmn_feedback.py regression
   ```

   `metric-selftest` (no engine required) separately pins every metric
   `collect_metrics` computes to a value verified against hand-built DI --
   run it after changing anything in `collect_metrics` itself:

   ```sh
   python3 tools/bpmn_feedback.py metric-selftest
   ```

3. Change the TypeScript implementation in
   `packages/bpmn-auto-layout/src/`. Keep placement and routing deterministic:
   the same BPMN input and options must produce the same BPMN DI.
4. Build and inspect a report containing the persisted fixtures and the
   motivating BPMN:

   ```sh
   nix develop --command python3 tools/bpmn_feedback.py report \
     fixtures/*.bpmn path/to/problem.bpmn
   ```

5. Compare the report images, `metrics.json`, and the serialized
   `transformed.bpmn`. Run targeted checks, then `nix flake check -L`.
6. If the fix closes a `fixtures/regression/` gap, add the fixture (if not
   already added in step 1) and a matching entry in `REGRESSION_CHECKS` in
   `tools/bpmn_feedback.py` that asserts the one invariant it pins — not an
   image comparison, so later fixes never require re-blessing a golden file.
   Leave the corpus stronger than you found it.

Prefer a rule that fixes the geometric cause across diagrams over a
fixture-specific offset. Preserve valid BPMN container boundaries, orthogonal
routes, readable labels, and stable output ordering.

### 2. Maintain the layout rules

`docs/bpmn-layout-rules.json` is a managed, implementation-derived inventory
of known rules and measurable metrics. It is not yet a complete formal
specification of the algorithm. Treat missing rules and disagreements between
the document and TypeScript as maintenance work, not as permission to invent
behavior.

After changing layout behavior:

1. Identify the actual source locations and update the corresponding rule with
   accurate `source_lines`.
2. Add or revise a rule only when the behavior is deterministic and
   intentional; distinguish implementation facts from proposed improvements.
3. Add a metric when feedback needs objective evidence that the current report
   does not provide.
4. Re-run reports and update the ruleset in the same change as the algorithm.

When feedback exposes behavior not covered by the ruleset, first document the
current behavior, then decide whether the algorithm or only the documentation
should change.

### 3. Use and evolve the feedback loop

The current tools are dependency-light and ephemeral by design:

```sh
nix develop --command python3 tools/bpmn_feedback.py report \
  fixtures/*.bpmn
```

Run `make feedback-ui` on the host to open the browser review service. The
agent publishes state and reads user actions through the JSON protocol under
the gitignored `.bpmn-feedback/agent/` directory. Reports contain per-diagram
original/transformed images, transformed BPMN, and deterministic metrics for
agent ingestion.

When ingesting feedback, correlate selected observations and low ratings with
`metrics.json`, inspect the relevant TypeScript path, and reproduce the issue
before changing code. Improve the first-version tool when a recurring review
question cannot be represented, a metric is misleading, or a report makes
comparison difficult; keep the feedback schema versioned and preserve
backward-readable JSON where practical.

### 4. Regenerate the parametric benchmark corpus

`fixtures/generated/*.bpmn` is produced entirely by
`tools/corpus-generator/generate.mjs` -- never hand-edit a file there;
regenerate it instead (see README.md's "Generated benchmark corpus" section
for the full topology/size/label-load matrix and invocation). `selftest`
re-validates the generated corpus's referential integrity on every run
alongside the curated and regression fixtures.
