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

Run a stdlib-only validation with:

```sh
python3 tools/bpmn_feedback.py selftest
```

The implementation-derived rules and metric definitions used by the loop live in
`docs/bpmn-layout-rules.json`.
