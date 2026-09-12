{
  description = "bpmn-auto-layout";

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
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      overlay = final: prev: {
        bpmn-auto-layout = final.callPackage ./nix/package.nix { };
      };
    in
    {
      packages = forAllSystems (pkgs: {
        default = pkgs.callPackage ./nix/package.nix { };
        bpmn-auto-layout = pkgs.callPackage ./nix/package.nix { };
      });

      apps = forAllSystems (pkgs: {
        default = {
          type = "app";
          program = "${self.packages.${pkgs.stdenv.hostPlatform.system}.default}/bin/bpmn-auto-layout";
        };
        bpmn-auto-layout = {
          type = "app";
          program = "${
            self.packages.${pkgs.stdenv.hostPlatform.system}.bpmn-auto-layout
          }/bin/bpmn-auto-layout";
        };
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs
            bpmn-to-image.packages.${pkgs.stdenv.hostPlatform.system}.default
          ];
        };
      });

      overlays.default = overlay;

      formatter = forAllSystems (pkgs: pkgs.nixfmt-tree);
    };
}
