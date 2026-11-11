{ lib, buildNpmPackage, nodejs_22 }:

buildNpmPackage {
  pname = "woody-agent";
  version = "0.1.0";

  src = lib.cleanSourceWith {
    src = ./.;
    filter = path: _type:
      let base = baseNameOf path;
      in base != "node_modules" && base != "dist" && base != "state";
  };

  nodejs = nodejs_22;

  # Hash of the npm dependency set in package-lock.json. When dependencies
  # change, set this to lib.fakeHash, build, and copy the hash Nix reports.
  npmDepsHash = "sha256-flWVpD0YZ4HBOyjbmZUlWqE6XOMCucxUmbZdoTiQn2g=";

  meta = {
    description = "WoodPecker-OS agent service";
    mainProgram = "woody-agent";
  };
}
