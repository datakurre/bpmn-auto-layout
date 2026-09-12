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

  npmDepsHash = "sha256-NH3nA+r0O3+CHLZgbGhWzuDhiPpnyKVV0BtPqB+ecRQ=";

  npmBuildScript = "build";

  meta = {
    description = packageJson.description;
    license = lib.licenses.mit;
    mainProgram = "bpmn-auto-layout";
  };
}
