# Base system: boot, Nix settings, locale, the admin user, SSH, firewall.
{ config, lib, pkgs, self, settings, ... }:
let
  # Short git commit of the config this system was built from, shown in the
  # boot menu next to each generation ("-dirty" if there were uncommitted changes).
  gitRev = self.shortRev or self.dirtyShortRev or "nogit";
in
{
  ##### Boot ###############################################################
  # GRUB installed for both BIOS and UEFI (disko tells it which disk).
  boot.loader.grub = {
    enable = true;
    efiSupport = true;
    efiInstallAsRemovable = true;
    configurationLimit = 30;      # generations kept in the boot menu
  };
  boot.loader.timeout = 3;

  ##### Generations are labelled with the git commit ######################
  system.nixos.tags = [ gitRev ];
  system.configurationRevision = self.rev or self.dirtyRev or null;

  ##### Nix ################################################################
  nix.settings = {
    experimental-features = [ "nix-command" "flakes" ];
    auto-optimise-store = true;
    trusted-users = [ "root" ];
  };
  nix.gc = {
    automatic = true;
    dates = "weekly";
    options = "--delete-older-than 30d";
  };

  ##### Identity, locale ###################################################
  networking.hostName = "woodpecker";
  time.timeZone = settings.timeZone;
  i18n.defaultLocale = settings.locale;
  console.keyMap = settings.consoleKeyMap;

  ##### Network ############################################################
  networking.networkmanager.enable = true;
  networking.nftables.enable = true;
  networking.firewall = {
    enable = true;
    # Nothing is open to the NAT side. SSH only from the host-only network.
    extraInputRules = ''
      ip saddr ${settings.hostOnlySubnet} tcp dport 22 accept
    '';
  };

  services.openssh = {
    enable = true;
    openFirewall = false;
    settings = {
      PermitRootLogin = "no";
      # Password login is acceptable for now because SSH is reachable only
      # from the host-only network. Switch to keys in a later phase.
      PasswordAuthentication = true;
    };
  };

  ##### Users ##############################################################
  users.users.${settings.adminUser} = {
    isNormalUser = true;
    description = "WoodPecker administrator";
    extraGroups = [ "wheel" "networkmanager" ];
    # Only used when the account is first created. Change it right after
    # the first login with `passwd`.
    initialPassword = "woodpecker";
    # Keys listed in settings.nix may sign in over SSH without a password.
    openssh.authorizedKeys.keys = settings.adminKeys;
  };

  # Whether the admin account (the only member of "wheel") must type its
  # password for sudo. See adminSudoWithoutPassword in settings.nix.
  security.sudo.wheelNeedsPassword = !settings.adminSudoWithoutPassword;

  ##### Memory #############################################################
  zramSwap.enable = true;

  ##### Tools for the human ################################################
  programs.git.enable = true;
  environment.systemPackages = with pkgs; [
    btrfs-progs
    e2fsprogs     # lsattr / chattr
    htop
    nano
    tree
    wget
  ];

  # Version of NixOS this machine was first installed with. Do not change.
  system.stateVersion = "26.05";
}
