# BPMN Autolayout

Lay out a BPMN file in place using Nix:

```sh
nix run github:datakurre/bpmn-autolayout -- path/to/process.bpmn
```

From a checkout, run:

```sh
nix run . -- path/to/process.bpmn
```

The command reads the BPMN XML, generates BPMN DI layout information, and
overwrites the input file. Keep a backup or commit your changes before running
it if you need to preserve the original layout.

The tool targets Camunda 8-flavoured BPMN documents and accepts exactly one
input file:

```text
Usage: bpmn-autolayout FILE.bpmn
```

Nix flakes must be enabled in the local Nix configuration. The first run may
download Nixpkgs and the JavaScript dependencies; subsequent runs use the Nix
store cache.

## Aligning an existing diagram instead of regenerating it

The default command above always discards whatever DI is already in the
file and rebuilds the diagram from the BPMN semantics. If you have already
laid out the process by hand and only want the existing shapes and edges
nudged onto a consistent grid -- not moved, reordered, or rerouted -- pass
`--align`:

```sh
nix run . -- --align path/to/process.bpmn
```

This mode keeps every existing shape's and edge's relative order on both
axes, merges positions that are already nearly aligned onto the same value,
and snaps everything to the grid; it never re-decides topology, branch
ordering, container sizing, or routing around obstacles the way the default
command does. A file with no existing DI has nothing for this mode to align
and is left unchanged. Running it twice produces the same result as running
it once. `alignProcess` is also available as a programmatic export
alongside `layoutProcess` for callers using the package directly. Lanes,
pools, and expanded subprocess containers are not yet moved by this mode --
their bounds are derived from their contents rather than independently
positioned, and only the contained flow nodes are aligned for now.

## Layout feedback loop

The repository includes a dependency-light Python feedback tool. The flake dev
shell provides `bpmn-feedback`, `python3`, `bpmn-auto-layout`, `bpmn-to-image`,
and `make`:

```sh
nix develop
make feedback-check
```

This lays out and checks the current persisted fixture set. The report command
prints a copy-pasteable `xdg-open` command for viewing it from a host terminal
and a short report ID. Use that ID with `check` or `latest`.
The supported CLI commands are `bpmn-feedback report`, `check`, `latest`, and
`selftest`.
For browser interaction, run `make feedback-ui` on the host and open
`http://localhost:8000/`. It reads the agent's ephemeral state JSON through a
read-only FastAPI WebSocket. The dashboard shows only the current agent state,
aspect, candidate images, descriptions, and quality-gate badges. Click an image
to open it full-screen, then reply directly to the agent with the best
candidate and any comment. Click the backdrop or **Close** to return.
Open `/fixtures` to copy every source fixture under `fixtures/` into an
ephemeral report directory, lay out and render the copies, and view the
resulting diagrams in order. Source fixtures are never modified.
The same operation is available as `POST /api/fixtures/update`.
The check is a deterministic quality gate for crossings, route intersections,
orthogonality, label overlaps, and missing named labels. See
`.agents/skills/iterate-bpmn-auto-layout/SKILL.md` for the complete single-rule
iteration protocol.

The persisted fixtures cover activities, event definitions, gateways, branches,
loops, boundary and nested subprocesses, call activities, lanes,
collaborations, messages, data artifacts, vendor extensions, and dense routing
stress cases. `report` lays out each input BPMN, renders original/transformed SVGs, and writes an ephemeral HTML
report plus deterministic metrics under
`.bpmn-feedback/reports/`. Candidate selection and iteration comments happen directly in the agent
conversation; the browser is only a visual review surface.
Persisted source fixtures are stored directly under `fixtures/`; layout commands
operate on ephemeral report copies so source BPMN cannot be overwritten by a
broken layout implementation.

## Comparing against another engine

`report` accepts a repeatable `--engine NAME=COMMAND` option to lay out the
same inputs with additional engines and score them identically alongside our
own output (our own engine is always included as `ours` unless overridden):

```sh
nix develop --command npm ci --prefix tools/upstream-baseline
nix develop --command python3 tools/bpmn_feedback.py report fixtures/*.bpmn \
  --engine upstream="node tools/upstream-baseline/run.mjs"
```

`tools/upstream-baseline` is a pinned, isolated install of
`bpmn-io/bpmn-auto-layout` -- the upstream project this repo shares a name
with -- used as a fixed external comparison baseline. An engine that errors
or is missing degrades to an empty column with the error recorded; `check`
still gates only `ours`, so a baseline's numbers are information, never a
build failure.

Passing `--engine ours-align="bpmn-auto-layout --align"` adds a column for
this project's own alignment mode (see above), scored against every
fixture's own input DI rather than the from-scratch column's
semantics-only starting point. That column's report includes a third
table, **Alignment**, that no other column populates: shapes compared,
how far they moved, whether any pair changed relative order (must read 0
-- that is the mode's own contract), and how the grid/lattice/orthogonality
metrics changed relative to the input. `ours-align` is a naming
convention `is_align_engine`/`resolve_engine_command` recognize; an engine
by that name whose command is not found on PATH (e.g. `--engine
ours-align=ours-align` in a checkout with no CLI installed) falls back to
running `alignProcess` from the locally built package directly, the same
way a bare `ours` command falls back to `layoutProcess` there.

## Published comparison report

Every push to `main` renders the N-way comparison report over the curated
fixture corpus (source vs. our own engine vs. the pinned upstream baseline)
and publishes it to GitHub Pages -- the project's demo, its public quality
record, and a regression signal that does not drift when we change our own
metrics. A pull request renders the same report but uploads it as a
downloadable workflow artifact instead of publishing it, so a PR's layout
effect is visible without becoming the project's public claim. The page
shows the measured commit and timestamp, each engine's resolved version, and
the validity/aesthetics bias statement -- it is a static artifact of
`tools/bpmn_feedback.py report` with no second renderer to maintain.
Publishing requires GitHub Pages enabled for this repository with source set
to "GitHub Actions" (a one-time repository setting under Settings -> Pages).

The `original` column exists to be an independent third point of comparison.
If a curated fixture's committed DI turns out to be identical, or nearly
identical, to a fresh run of our own engine on the same semantics, that
fixture's `original` column reads `n/a (seeded from this engine...)` instead
of a number -- showing it as agreement with itself would misrepresent it as
independent corroboration. `selftest` prints (never fails on) the same
detection for the persisted corpus.

## Generated benchmark corpus

Three fixture directories, three owners: `fixtures/*.bpmn` are the curated,
hand-reviewed corpus; `fixtures/regression/*.bpmn` are minimal, hand-written,
one pinned invariant each; `fixtures/generated/*.bpmn` are produced entirely
by `tools/corpus-generator/generate.mjs` and are never hand-edited.

```sh
nix develop --command npm ci --prefix tools/corpus-generator
nix develop --command node tools/corpus-generator/generate.mjs --seed 1
```

Generates the full topology-class x size x label-load matrix (9 topologies --
linear, branch/merge, nested branches, a loop back-edge, boundary events, an
expanded subprocess, nested subprocesses, disconnected components, and
pool+lanes -- at small/medium/large node counts, each with no/short/long
labels) deterministically from the seed: same seed, byte-identical BPMN.
Every generated file records its topology, size, and seed in a
`<bpmn:documentation>` element and in its filename, and is checked for
referential integrity (no dangling refs, no duplicate ids, no
`<incoming>`/`<outgoing>` mismatch) before it is ever written. `selftest`
re-checks the same invariant on every run. Pass `--topology`, `--size`, or
`--label-load` to regenerate a single combination; see `--help` for details.

Run a stdlib-only validation with:

```sh
python3 tools/bpmn_feedback.py selftest
```

The implementation-derived rules and metric definitions used by the loop live in
`docs/bpmn-layout-rules.json`.
