---
name: iterate-bpmn-auto-layout
description: Use this skill when evolving BPMN auto-layout behavior from visual reports and structured feedback.
---

# BPMN layout feedback workflow

Use this skill when evolving BPMN auto-layout behavior from visual reports and
structured feedback. The purpose is controlled visual iteration, not automatic
optimization from metrics.

## Shell prerequisite

All commands run inside the Nix development shell. From the repository root:

```sh
nix develop
```

The shell provides: `bpmn-auto-layout` (the layout engine), `bpmn-to-image`
(SVG renderer), `bpmn-feedback` (CLI tool), `bpmn-feedback-ui` (FastAPI
server), `python3`, and `make`.

## Architecture overview

```
Human (agent conversation)  ←──  Agent (this skill)  ──→  TypeScript src
                                     ↕
                               state.json
                                     ↕
                              Read-only browser UI
                                     ↕
                               report artifacts
```

Three components interact:

1. **Agent** (you) — changes TypeScript, generates reports, publishes state,
   and asks the user directly in the agent conversation.
2. **FastAPI UI** (`make feedback-ui`) — read-only browser review surface at
   `http://localhost:8000/`. It shows the current four candidate options, the
   shared sample diagrams, aspect, descriptions, and quality-gate badges.
   Every diagram opens in a full-screen lightbox with zoom.
   It does not expose report links or submit actions.
3. **State file** under `.bpmn-feedback/agent/state.json` — the agent writes
   state and the UI reads it. The file is gitignored and must be written
   atomically: serialize the complete document, write it to a temporary file
   in `.bpmn-feedback/agent/`, flush and close it, then replace `state.json`
   with an atomic same-directory rename. Never write directly to `state.json`.

### State schema (agent writes)

```json
{
  "schema": "bpmn-layout-agent-state/v1",
  "phase": "target|candidates|accepted|processing|idle",
  "message": "Human-readable status",
  "updated_at": "ISO-8601 UTC",
  "aspect": "node spacing",
  "sample_seed": 48271,
  "sample": ["fixtures/bpmn-feedback/original/flow.bpmn", "fixtures/bpmn-feedback/original/gateway.bpmn"],
  "candidates": [
    {"label": "A", "report": "...", "images": ["...flow.svg", "...gateway.svg"],
     "description": "...", "quality_gate_passed": true},
    {"label": "B", "report": "...", "images": ["...flow.svg", "...gateway.svg"],
     "description": "...", "quality_gate_passed": false,
     "quality_gate_failures": ["diagram: edge_crossings=1"]},
    {"label": "C", "report": "...", "images": ["...flow.svg", "...gateway.svg"],
     "description": "...", "quality_gate_passed": true},
    {"label": "D", "report": "...", "images": ["...flow.svg", "...gateway.svg"],
     "description": "...", "quality_gate_passed": true}
  ],
  "aspects": ["routing", "spacing", "labels", "containers", "other"]
}
```

### Server endpoints

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/` | GET | Dashboard with the current candidate comparison |
| `/api/state` | GET | Current agent state JSON |
| `/ws` | WebSocket | Read-only live state push |
| `/reports/{path}` | GET | Internal SVG assets for the option viewer |

### Direct agent prompt

After publishing the candidates, ask the user directly in the agent
conversation for the best candidate and an optional comment. Include the
aspect and candidate labels in the prompt. The browser is only a visual aid;
it does not receive or submit the answer. Never infer a choice from a timeout,
browser state, or deterministic metrics.

## Design authority

The agent may propose new layout rules and magic constants when the current
fixtures, motivating BPMN, or human review reveal a general geometric need.
Treat `docs/bpmn-layout-rules.json` as an implementation-derived inventory:
verify the relevant TypeScript behavior, then document an intentional accepted
rule or magic with accurate source lines. Do not invent a fixture-specific
offset or silently turn a proposed improvement into a rule.

Each iteration has one coherent layout hypothesis. It may tune an existing
rule or magic, introduce a new rule, or change a connected group of placement
and routing logic when the evidence shows a fundamental geometric problem.
Do not bundle unrelated refactors, but do not constrain a solution to one
parameter when the target requires an algorithmic change.

## Candidate comparison

Choose one aspect to evaluate, then prepare four candidate renderings. Write
the singular aspect in `state.json`; the `aspects` array is optional protocol
metadata. The UI displays the aspect and does not ask the reviewer to choose a
different one.

Select at least two random BPMN graphs for each comparison. Choose the sample
once before rendering and use exactly the same graphs, in the same order, for
A, B, C, and D. Record the selected paths (and the random seed) in the state
message or `sample` metadata so the comparison is reproducible. The sample
must be large enough to expose regressions; use the full fixture set when a
small sample would hide the suspected failure.

The first report of a comparison clears reports from the previous iteration:

```sh
bpmn-feedback report --clear-output fixtures/bpmn-feedback/original/*.bpmn
```

Render the other three candidates without `--clear-output` so all four remain
available until the reviewer chooses one. Keep each candidate in an isolated
git worktree (or an equivalent isolated checkout) rooted at the same base
commit. Name the worktrees after A, B, C, and D, and retain them until the
choice is accepted so every alternative can be inspected or recovered.

For example, from the repository root:

```sh
base=$(git rev-parse HEAD)
git worktree add ../bpmn-layout-A "$base"
git worktree add ../bpmn-layout-B "$base"
git worktree add ../bpmn-layout-C "$base"
git worktree add ../bpmn-layout-D "$base"
```

Make no changes in A. Implement each alternative only in its own worktree,
render from that worktree, and apply the selected worktree's change to the
main checkout after review. Remove the four worktrees only after the accepted
implementation and reports have been recorded.

If fixtures are missing, generate them first:

```sh
make feedback-generate
```

## One iteration, four renderings

1. Inspect the motivating BPMN plus at least one additional randomly selected
   graph and the TypeScript paths implementing the target. Decide whether the
   evidence calls for a parameter, a new rule, or a broader algorithm change.
2. Prepare four isolated candidate implementations. Candidate A **must always
   be the current implementation** from the base commit, unchanged. Candidates
   B, C, and D should be distinct hypotheses, including algorithmic alternatives
   when appropriate. Keep placement and routing deterministic within a
   candidate.
3. Render every graph in the shared sample for every candidate, producing a
   report whose candidate state includes an `images` array with at least two
   transformed SVGs. Run `bpmn-feedback check` on
   every report. A candidate that fails the quality gate must still be shown,
   but the failure must be stated beside its report and never hidden behind a
   visual preference.
4. Publish the four candidates, the shared `sample`, their report paths,
   image arrays, singular `aspect`, and quality-gate results in `state.json`.
   The UI presents every transformed image with lightbox zoom and remains
   read-only.
5. Ask the user directly for the candidate and comment. Apply only the chosen
   candidate. Update `docs/bpmn-layout-rules.json` when behavior or a magic
   changes, including accurate `source_lines`. Re-render the accepted result
   and run the quality gate.
6. Ask directly whether to continue with another target. If continuing, start
   a new comparison and clear the previous reports; otherwise finish. Never
   treat an unselected candidate as accepted behavior.

The agent must not infer which rendering looks best or substitute deterministic
metrics for the user's visual choice.

## Reports and helper commands

Reports are scratch space under `.bpmn-feedback/reports/report-*` and contain
original/transformed SVGs, copied BPMN, and deterministic `metrics.json`.
Only the active four candidates need to be retained.
`bpmn-feedback report` prints both the full path and a short report ID.
`bpmn-feedback latest` prints the newest report path. Commands accepting a
report also accept `latest`, a short ID, or a unique ID prefix. The quality
gate checks crossings, edge/shape intersections, non-orthogonal segments,
label overlaps, and missing named labels; shape overlaps remain informational
because containers and boundaries can legitimately overlap.

Direct commands:

```sh
bpmn-feedback report [BPMN ...]
bpmn-feedback check [--report REPORT]
bpmn-feedback latest
```

User interaction is handled directly in the agent conversation. The FastAPI UI
is a read-only visual aid; it has no terminal review, comparison, or
questionnaire commands.

## Ruleset maintenance

After an accepted behavior change, update the corresponding implementation
rule in `docs/bpmn-layout-rules.json`. Record constants such as track pitches,
clearances, channel widths, nudges, label gaps, and container padding only when
they are intentional and observable in the implementation. Keep output stable:
the same BPMN and options must produce the same BPMN DI.
