{
  description = "In-place BPMN auto-layout";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    bpmn-to-image = {
      url = "github:datakurre/bpmn-to-image";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      bpmn-to-image,
      ...
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (
        pkgs:
        let
          python = pkgs.python3.withPackages (ps: [
            ps.fastapi
            ps.uvicorn
            ps.websockets
          ]);
          feedback = pkgs.writeShellApplication {
            name = "bpmn-feedback";
            runtimeInputs = [ pkgs.python3 ];
            text = ''
              exec ${pkgs.python3}/bin/python3 ${./tools/bpmn_feedback.py} "$@"
            '';
          };
          feedback-ui = pkgs.writeShellApplication {
            name = "bpmn-feedback-ui";
            runtimeInputs = [
              python
              layout-cli
              bpmn-to-image.packages.${pkgs.stdenv.hostPlatform.system}.bpmn-to-image
            ];
            text = ''
              exec ${python}/bin/python3 ${./tools/bpmn_feedback_server.py} "$@"
            '';
          };
          layout = pkgs.buildNpmPackage {
            pname = "bpmn-auto-layout";
            version = "0.1.0";
            src = ./packages/bpmn-auto-layout;
            npmDepsHash = "sha256-jt8/WwDl0Wx13wyCkQ+HWCMIqwTLdtJsgaDUeKzrFgA=";
            npmBuildHook = "";
            buildPhase = "npm run build";
            installPhase = ''
              mkdir -p $out/lib/node_modules/bpmn-auto-layout
              cp -r dist package.json node_modules $out/lib/node_modules/bpmn-auto-layout/
            '';
          };
          layout-cli = pkgs.writeShellApplication {
            name = "bpmn-auto-layout";
            runtimeInputs = [ pkgs.nodejs ];
            text = ''
              if [ "$#" -ne 1 ]; then
                echo "usage: bpmn-auto-layout FILE.bpmn" >&2
                exit 2
              fi

              input=$(realpath "$1")
              ${pkgs.nodejs}/bin/node --input-type=module - "$input" <<'NODE'
              import { readFile, writeFile } from "node:fs/promises";
              import { layoutProcess } from "${layout}/lib/node_modules/bpmn-auto-layout/dist/index.js";

              const file = process.argv[2];
              const xml = await readFile(file, "utf8");
              await writeFile(file, await layoutProcess(xml));
              NODE
            '';
            meta.mainProgram = "bpmn-auto-layout";
          };
        in
        {
          bpmn-auto-layout = layout;
          bpmn-feedback = feedback;
          bpmn-feedback-ui = feedback-ui;
          default = layout-cli;
        }
      );

      # `nix flake check -L` -- AGENTS.md tells contributors to run this, but
      # until now it evaluated no checks at all (#44). selftest/regression
      # run the persisted-fixture and pinned-invariant checks from
      # tools/bpmn_feedback.py against a freshly built engine, entirely
      # inside the sandboxed check build (no network beyond the FOD
      # npm-deps fetch the `default`/`bpmn-feedback` packages already need).
      # The TypeScript unit suite (`npm test`) is deliberately not one of
      # these checks: its test-helpers.ts locates fixtures/ by walking a
      # fixed number of parent directories up from the compiled test file,
      # which assumes the repo's own packages/bpmn-auto-layout nesting --
      # true when run from a checkout, not true of how nix stages a `src`
      # derivation's directory (which drops that outer nesting). It runs in
      # CI directly against a checkout instead (.github/workflows/ci.yml),
      # where that assumption holds.
      #
      # The wider quality gate (`bpmn-feedback report` + `check`, currently
      # ~70 findings across the fixture corpus) is intentionally not one of
      # these checks either: nix checks are pass/fail with no partial-credit
      # reporting, and failing it here would make `nix flake check`
      # permanently red. It runs non-blocking in CI instead until enough of
      # those findings are fixed to flip it to blocking with a ratchet, per
      # the issue's own suggested order.
      checks = forAllSystems (
        pkgs:
        let
          layoutCli = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
          feedback = self.packages.${pkgs.stdenv.hostPlatform.system}.bpmn-feedback;
        in
        {
          selftest =
            pkgs.runCommand "bpmn-auto-layout-selftest"
              {
                nativeBuildInputs = [
                  layoutCli
                  feedback
                ];
              }
              ''
                cp -r ${./fixtures} ./fixtures
                chmod -R +w ./fixtures
                bpmn-feedback selftest --layout-command bpmn-auto-layout
                touch $out
              '';

          regression =
            pkgs.runCommand "bpmn-auto-layout-regression"
              {
                nativeBuildInputs = [
                  layoutCli
                  feedback
                ];
              }
              ''
                cp -r ${./fixtures} ./fixtures
                chmod -R +w ./fixtures
                bpmn-feedback regression --layout-command bpmn-auto-layout
                touch $out
              '';
        }
      );

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            self.packages.${pkgs.stdenv.hostPlatform.system}.default
            bpmn-to-image.packages.${pkgs.stdenv.hostPlatform.system}.bpmn-to-image
            self.packages.${pkgs.stdenv.hostPlatform.system}.bpmn-feedback
            pkgs.gnumake
            pkgs.python3
            self.packages.${pkgs.stdenv.hostPlatform.system}.bpmn-feedback-ui
            # `node`/`npm` on PATH for tools/upstream-baseline (#54): the
            # pinned bpmn-io/bpmn-auto-layout comparison baseline is a plain
            # npm install kept deliberately outside the nix package graph
            # (a moving external engine is not something to vendor
            # hermetically), installed and run through this instead.
            pkgs.nodejs
          ];
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt-tree);
    };
}
