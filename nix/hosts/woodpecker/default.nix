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
    ../../modules/embed.nix
    ../../modules/woody.nix
    ../../locked/executor.nix
    ../../locked/workbench.nix
    ../../locked/hud.nix
  ];
}
