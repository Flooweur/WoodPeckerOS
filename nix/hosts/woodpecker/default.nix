{ ... }:
{
  imports = [
    ./hardware.nix
    ./disko.nix
    ../../modules/base.nix
    ../../modules/vmware-guest.nix
    ../../modules/snapshots.nix
    ../../modules/secrets.nix
    ../../modules/kiosk.nix
    ../../modules/agent.nix
    ../../locked/executor.nix
  ];
}
