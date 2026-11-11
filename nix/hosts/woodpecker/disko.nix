# Disk layout as code. disko partitions and formats the disk at install time
# and generates the matching mount configuration.
#
# One Btrfs filesystem with subvolumes, so snapshots are cheap:
#   @root       /            system state outside the Nix store
#   @home       /home
#   @nix        /nix         the Nix store (never snapshotted: it is reproducible)
#   @log        /var/log     kept apart so a rollback does not erase logs
#   @snapshots  /.snapshots  where pre-rebuild snapshots are stored
#
# The disk has both a BIOS boot partition and an EFI partition, so the VM
# boots whether VMware is set to BIOS or UEFI firmware.
{ settings, ... }:
let
  btrfsOpts = [ "compress=zstd" "noatime" ];
in
{
  disko.devices.disk.main = {
    type = "disk";
    device = settings.disk;
    content = {
      type = "gpt";
      partitions = {
        bios = {
          priority = 1;
          size = "1M";
          type = "EF02";
        };
        ESP = {
          priority = 2;
          size = "1G";
          type = "EF00";
          content = {
            type = "filesystem";
            format = "vfat";
            mountpoint = "/boot";
            mountOptions = [ "umask=0077" ];
          };
        };
        root = {
          size = "100%";
          content = {
            type = "btrfs";
            extraArgs = [ "-f" "-L" "woodpecker" ];
            subvolumes = {
              "@root" = { mountpoint = "/"; mountOptions = btrfsOpts; };
              "@home" = { mountpoint = "/home"; mountOptions = btrfsOpts; };
              "@nix" = { mountpoint = "/nix"; mountOptions = btrfsOpts; };
              "@log" = { mountpoint = "/var/log"; mountOptions = btrfsOpts; };
              "@snapshots" = { mountpoint = "/.snapshots"; mountOptions = btrfsOpts; };
            };
          };
        };
      };
    };
  };

  fileSystems."/var/log".neededForBoot = true;
}
