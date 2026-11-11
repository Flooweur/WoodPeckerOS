# The only file you should need to edit for your own machine.
# Time zone, locale and keyboard were confirmed against the Phase 0 install.
{
  # Human admin account (not the agent).
  adminUser = "flooweur";

  timeZone = "Europe/Paris";
  locale = "en_US.UTF-8";
  consoleKeyMap = "fr";

  # VMware "LSI Logic" SCSI disk. `lsblk` in the installer shows the real name.
  disk = "/dev/sda";

  # VMware host-only network (VMnet1 on the Windows host). SSH is only
  # accepted from this subnet.
  labSubnet = "192.168.222.0/24";

  # Addresses that can never be a security-tool target, whatever an engagement
  # says: the Windows host on both VMware networks, the NAT gateway/DNS, and
  # VMware's DHCP servers.
  permanentDeny = [
    "192.168.222.1"
    "192.168.222.254"
    "192.168.130.1"
    "192.168.130.2"
    "192.168.130.254"
  ];

  # Claude API spend limits enforced by the agent (USD). The monthly cap covers
  # chat and background work together; the per-turn cap stops one runaway reply.
  monthlyCapUsd = 50;
  perTurnCapUsd = 2;

  # Where this repo is cloned inside the VM.
  repoPath = "/home/flooweur/WoodPeckerOS";

  # How many pre-rebuild Btrfs snapshots to keep.
  snapshotsToKeep = 20;
}
