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
