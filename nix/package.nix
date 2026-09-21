{
  lib,
  buildNpmPackage,
}:

let
  packageJson = builtins.fromJSON (builtins.readFile ../package.json);
in
buildNpmPackage {
  pname = packageJson.name;
  version = packageJson.version;

  src = ../.;

  npmDepsHash = "sha256-AFjgUvt6n8kskaG/Lzr/lPHIiMNGkLK+49Rg8+LYBxE=";

  npmBuildScript = "build";

  meta = {
    description = packageJson.description;
    license = lib.licenses.mit;
    mainProgram = "bpmn-auto-layout";
  };
}
