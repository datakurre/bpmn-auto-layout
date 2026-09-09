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
shell provides `python3`, `bpmn-auto-layout`, and `bpmn-to-image`:

```sh
nix develop --command python3 tools/bpmn_feedback.py generate --output fixtures/bpmn-feedback --force
nix develop --command python3 tools/bpmn_feedback.py report fixtures/bpmn-feedback/*.bpmn
nix develop --command python3 tools/bpmn_feedback.py feedback --report .bpmn-feedback/reports/report-*/index.html
```

`generate` writes deterministic BPMN fixtures covering events, tasks, gateways,
branches, loops, subprocesses, lanes, boundary events, messages, and data
references. `report` lays out each input BPMN, renders original/transformed SVGs,
and writes an ephemeral HTML report plus deterministic metrics under
`.bpmn-feedback/reports/`. `feedback` records checkbox observations, 1–5 Likert
ratings, and comments as `bpmn-layout-feedback/v1` JSON for later ingestion.

Run a stdlib-only validation with:

```sh
python3 tools/bpmn_feedback.py selftest
```

The implementation-derived rules and metric definitions used by the loop live in
`docs/bpmn-layout-rules.json`.
