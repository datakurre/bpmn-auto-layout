{
  description = "In-place BPMN auto-layout";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
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
          layout = pkgs.buildNpmPackage {
            pname = "bpmn-auto-layout";
            version = "0.1.0";
            src = ./packages/bpmn-auto-layout;
            npmDepsHash = "sha256-MyUtCO8LYdgRtsO04jshNnJWrK2JGdl6NzoNYx4mMUo=";
            npmBuildHook = "";
            buildPhase = "npm run build";
            installPhase = ''
              mkdir -p $out/lib/node_modules/@graph-agent/bpmn-auto-layout
              cp -r dist package.json node_modules $out/lib/node_modules/@graph-agent/bpmn-auto-layout/
            '';
          };
        in
        {
          bpmn-auto-layout = layout;
          default = pkgs.writeShellApplication {
            name = "bpmn-autolayout";
            runtimeInputs = [ pkgs.nodejs ];
            text = ''
              if [ "$#" -ne 1 ]; then
                echo "usage: bpmn-autolayout FILE.bpmn" >&2
                exit 2
              fi

              input=$(realpath "$1")
              ${pkgs.nodejs}/bin/node --input-type=module - "$input" <<'NODE'
              import { readFile, writeFile } from "node:fs/promises";
              import { layoutProcess } from "${layout}/lib/node_modules/@graph-agent/bpmn-auto-layout/dist/index.js";

              const file = process.argv[2];
              const xml = await readFile(file, "utf8");
              await writeFile(file, await layoutProcess(xml));
              NODE
            '';
            meta.mainProgram = "bpmn-autolayout";
          };
        }
      );

      formatter = forAllSystems (pkgs: pkgs.nixfmt-tree);
    };
}
