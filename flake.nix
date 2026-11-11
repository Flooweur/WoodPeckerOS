{
  description = "WoodPecker-OS: a NixOS VM operated by Woody";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

    disko = {
      url = "github:nix-community/disko";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    sops-nix = {
      url = "github:Mic92/sops-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, disko, sops-nix, ... }: {
    nixosConfigurations.woodpecker = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      specialArgs = {
        inherit self;
        # Per-machine values (user name, keyboard, disk, lab subnet) live in one file.
        settings = import ./nix/hosts/woodpecker/settings.nix;
      };
      modules = [
        disko.nixosModules.disko
        sops-nix.nixosModules.sops
        ./nix/hosts/woodpecker
      ];
    };
  };
}
