# Hand-written for the VMware Workstation VM (LSI Logic SCSI disk, SATA CD-ROM,
# e1000 network card). Filesystems come from disko.nix, not from here.
{ lib, ... }:
{
  boot.initrd.availableKernelModules = [
    "ata_piix"
    "mptspi"      # LSI Logic SCSI controller (the system disk)
    "ahci"        # SATA (CD-ROM)
    "uhci_hcd"
    "ehci_pci"
    "sd_mod"
    "sr_mod"
  ];
  boot.initrd.kernelModules = [ ];
  boot.kernelModules = [ ];

  nixpkgs.hostPlatform = lib.mkDefault "x86_64-linux";
}
