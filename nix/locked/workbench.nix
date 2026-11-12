# LOCKED CORE. The workbench: where Woody runs real programs.
#
#   /var/lib/woody-work           the workbench's own disk, of a fixed size
#     files/                      what a run works on; Woody reads and writes here too
#     files/in, files/out         where you put files for Woody, and where it leaves results
#     home/                       caches and settings of the programs it uses
#     run/                        the script of the run in progress (written by the executor)
#
# A run is started by the executor (the action work.run, executor/src/work.rs)
# as the user "woody-work", in a unit of its own that sees nothing of the
# machine but this disk and the installed programs. See docs/WORKBENCH.md.
#
# Three things here keep a run where it belongs:
#  * the user has no rights and belongs to no other group;
#  * the disk is a file of a fixed size, mounted here: a run that writes
#    without end fills the workbench, not the machine;
#  * the firewall rule below: a run that was given the network reaches public
#    addresses on ports 80 and 443, and the DNS server, and nothing else. Not
#    this machine, not the Windows host, not the home network.
{ config, lib, pkgs, settings, ... }:
let
  root = "/var/lib/woody-work";
  # The image lives in its own Btrfs subvolume, so that the snapshots taken
  # before each rebuild do not carry copies of it.
  imageDir = "/var/lib/woody-bench";
  image = "${imageDir}/bench.img";

  prepare = pkgs.writeShellScript "woody-work-bench" ''
    set -eu
    mkdir -p ${root}
    if ! mountpoint -q ${root}; then
      if [ ! -e ${image} ]; then
        if [ ! -d ${imageDir} ]; then
          btrfs subvolume create ${imageDir} >/dev/null 2>&1 || mkdir -p ${imageDir}
        fi
        chmod 700 ${imageDir}
        touch ${image}
        # No copy-on-write for the image: it is rewritten in place all the time.
        chattr +C ${image} 2>/dev/null || true
        truncate -s ${toString settings.workbenchSizeGb}G ${image}
        mkfs.ext4 -q -m 0 -L woody-work ${image}
      fi
      mount -o loop,nosuid,nodev,noatime ${image} ${root}
    fi
    chown root:woody-work ${root}
    chmod 0750 ${root}
    # Shared by the workbench's user and its group (Woody, and the HUD for your uploads).
    install -d -o woody-work -g woody-work -m 2770 ${root}/files ${root}/files/in ${root}/files/out
    install -d -o woody-work -g woody-work -m 0700 ${root}/home ${root}/home/tmp
    # Scripts of runs are written by the executor and only read by the run.
    install -d -o root -g root -m 0755 ${root}/run
    rm -f ${root}/run/*.sh
  '';

  dns = lib.concatStringsSep ", " settings.workbenchDns;
in
{
  # The identity a run has: no home outside the workbench, no other group, no rights.
  users.groups.woody-work = { };
  users.users.woody-work = {
    isSystemUser = true;
    group = "woody-work";
    home = "${root}/home";
    description = "Woody's workbench (programs it runs)";
  };
  # Woody itself reads and writes the workbench's files. The reverse does not
  # hold: the workbench's user cannot open anything of Woody's.
  users.users.woody.extraGroups = [ "woody-work" ];

  boot.kernelModules = [ "loop" ];

  systemd.services.woody-work-bench = {
    description = "The workbench's disk";
    wantedBy = [ "multi-user.target" ];
    before = [ "woody-execd.service" "woody-agent.service" ];
    path = with pkgs; [ coreutils util-linux e2fsprogs btrfs-progs ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStart = "${prepare}";
    };
  };
  systemd.services.woody-execd = {
    after = [ "woody-work-bench.service" ];
    wants = [ "woody-work-bench.service" ];
  };
  systemd.services.woody-agent = {
    after = [ "woody-work-bench.service" ];
    wants = [ "woody-work-bench.service" ];
    environment.WOODY_BENCH_DIR = "${root}/files";
    # The agent's own files stay the only other thing it can write. The "-"
    # lets the agent start even if the workbench's disk is not there.
    serviceConfig.ReadWritePaths = [ "-${root}/files" ];
  };

  # The HUD gateway is how you give files to Woody and take its results
  # (hud/server/files.ts). It writes what you give into the "in" folder and
  # reads what you download; it never runs or opens what is there.
  users.users.woody-hud.extraGroups = [ "woody-work" ];
  systemd.services.woody-hud = {
    after = [ "woody-work-bench.service" ];
    wants = [ "woody-work-bench.service" ];
    environment.WOODY_BENCH_DIR = "${root}/files";
    serviceConfig = {
      SupplementaryGroups = [ "woody-work" ];
      ReadWritePaths = [ "-${root}/files" ];
    };
  };

  # What a run with the network can reach. A run without it has no network
  # device at all, so this rule only matters when the network was asked for.
  networking.nftables.tables.woody_work = {
    family = "inet";
    content = ''
      chain refuse {
        limit rate 6/minute log prefix "woody-work-drop: "
        counter drop
      }
      chain output {
        type filter hook output priority filter; policy accept;
        meta skuid != "woody-work" accept
        ip daddr { ${dns} } udp dport 53 accept
        ip daddr { ${dns} } tcp dport 53 accept
        oifname "lo" jump refuse
        ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/4, 240.0.0.0/4 } jump refuse
        ip6 daddr { ::/127, 64:ff9b::/96, fc00::/7, fe80::/10, ff00::/8 } jump refuse
        tcp dport { 80, 443 } accept
        jump refuse
      }
    '';
  };
}
