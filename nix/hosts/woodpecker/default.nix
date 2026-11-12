{ ... }:
{
  imports = [
    ./hardware.nix
    ./disko.nix
    ../../modules/base.nix
    ../../modules/vmware-guest.nix
    ../../modules/snapshots.nix
    ../../modules/kiosk.nix
    ../../modules/agent.nix
    ../../modules/woody.nix
    ../../locked/executor.nix
    ../../locked/hud.nix
  ];
}
