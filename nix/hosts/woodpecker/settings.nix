# The only file you should need to edit for your own machine.
# Time zone, locale and keyboard were confirmed against the Phase 0 install.
{
  # Human admin account (not the agent).
  adminUser = "flooweur";

  # SSH public keys that may sign in as the admin account (from the
  # host-only network only). The first one belongs to Claude Code on the
  # Windows host, which builds and tests this system; its private half
  # never leaves that PC. Remove the line to take that access away.
  adminKeys = [
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGNNTpfGLuYDJnUFkMusHXjkbHgM1JQ2XE4sLExBf2RQ woodpecker-review"
  ];

  # Let the admin account use sudo without typing its password. Decided on
  # 2026-11-12 so that changes can be tested in the VM over SSH. It concerns
  # the admin account only: Woody's own user has no sudo at all. Set it to
  # false to be asked for the password again.
  adminSudoWithoutPassword = true;

  timeZone = "Europe/Paris";
  locale = "en_US.UTF-8";
  consoleKeyMap = "fr";

  # VMware "LSI Logic" SCSI disk. `lsblk` in the installer shows the real name.
  disk = "/dev/sda";

  # VMware host-only network (VMnet1 on the Windows host). SSH is only
  # accepted from this subnet.
  hostOnlySubnet = "192.168.222.0/24";

  # The Windows host's own address on the host-only network. The HUD is
  # served to this address only (never to another machine on that network), over
  # HTTPS on the port below.
  hostAddress = "192.168.222.1";
  hudHostPort = 7843;

  # Ask for the kiosk user's password before the HUD opens on the VM's own
  # screen. Set that password first: sudo passwd kiosk
  kioskLogin = true;

  # Addresses Woody's web fetches can never reach, whatever a name resolves
  # to: the Windows host on both VMware networks, the NAT gateway/DNS, and
  # VMware's DHCP servers.
  permanentDeny = [
    "192.168.222.1"
    "192.168.222.254"
    "192.168.130.1"
    "192.168.130.2"
    "192.168.130.254"
  ];

  # The workbench, where Woody runs programs (nix/locked/workbench.nix).
  # Its disk has a fixed size, in gigabytes; a run can fill it and nothing else.
  # The size is used when the disk is first made: to change it later, delete
  # /var/lib/woody-bench/bench.img (and what is in it) and rebuild.
  workbenchSizeGb = 10;
  # The DNS servers a run that was given the network may ask. This is the
  # network's resolver (see /etc/resolv.conf): change it when the machine moves.
  workbenchDns = [ "192.168.130.2" ];

  # Claude API spend limits enforced by the agent (USD). The monthly cap covers
  # chat and background work together; the per-turn cap stops one runaway reply.
  monthlyCapUsd = 100;
  perTurnCapUsd = 2;

  # Woody's own share of the monthly cap, as a fraction: what it may spend on
  # its interests and its own projects, in its own time. 0 gives it none.
  ownShare = 0.25;

  # Woody's day, in the machine's local time. By day it is active; from
  # nightStart to dayStart it sleeps unless you are there or have work for it.
  # These are the defaults: you can change the hours from the HUD ("Its own life").
  dayStart = "07:00";
  nightStart = "23:00";

  # Where this repo is cloned inside the VM.
  repoPath = "/home/flooweur/WoodPeckerOS";

  # How many pre-rebuild Btrfs snapshots to keep.
  snapshotsToKeep = 20;
}
