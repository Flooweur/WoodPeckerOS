# The only file you should need to edit for your own machine.
# Check the values marked CHECK against the old install before reinstalling:
#   grep -E "keyMap|timeZone|defaultLocale|layout" /etc/nixos/configuration.nix
{
  # Human admin account (not the agent).
  adminUser = "flooweur";

  timeZone = "Europe/Paris";      # CHECK
  locale = "fr_FR.UTF-8";         # CHECK
  consoleKeyMap = "fr";           # CHECK: a wrong value makes console passwords hard to type

  # VMware "LSI Logic" SCSI disk. `lsblk` in the installer shows the real name.
  disk = "/dev/sda";

  # VMware host-only network (VMnet1 on the Windows host). SSH is only
  # accepted from this subnet.
  labSubnet = "192.168.222.0/24";

  # Where this repo is cloned inside the VM.
  repoPath = "/home/flooweur/WoodPeckerOS";

  # How many pre-rebuild Btrfs snapshots to keep.
  snapshotsToKeep = 20;
}
