{ lib, buildNpmPackage, nodejs_22 }:

buildNpmPackage {
  pname = "woody-hud";
  version = "0.1.0";

  src = lib.cleanSourceWith {
    src = ./.;
    filter = path: _type:
      let base = baseNameOf path;
      in base != "node_modules" && base != "dist";
  };

  nodejs = nodejs_22;

  # Hash of the npm dependency set in package-lock.json. When dependencies
  # change, set this to lib.fakeHash, build, and copy the hash Nix reports.
  npmDepsHash = "sha256-f4yu4o81lXKAbPBrCKfOZ/cy0M13LF4ZNkehCT2dxbc=";

  meta = {
    description = "WoodPecker-OS HUD web app and approval gateway";
    mainProgram = "woody-hud";
  };
}
