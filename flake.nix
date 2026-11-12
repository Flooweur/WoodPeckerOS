{
  description = "WoodPecker-OS: a NixOS VM operated by Woody";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

    disko = {
      url = "github:nix-community/disko";
      inputs.nixpkgs.follows = "nixpkgs";
    };

  };

  outputs = { self, nixpkgs, disko, ... }: {
    nixosConfigurations.woodpecker = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      specialArgs = {
        inherit self;
        # Per-machine values (user name, keyboard, disk, host-only subnet) live in one file.
        settings = import ./nix/hosts/woodpecker/settings.nix;
      };
      modules = [
        disko.nixosModules.disko
        ./nix/hosts/woodpecker
      ];
    };

    # What the executor compares before applying a change Woody proposes.
    # See nix/locked/fingerprint.nix.
    fingerprint = import ./nix/locked/fingerprint.nix {
      inherit (nixpkgs) lib;
      config = self.nixosConfigurations.woodpecker.config;
    };
  };
}
