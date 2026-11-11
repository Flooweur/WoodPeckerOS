# LOCKED CORE. A fingerprint of everything in the evaluated system that grants
# or guards privilege. The executor evaluates it for the running configuration
# and for a configuration Woody proposes; if any entry differs, the change
# needs human approval, whichever file it was written in.
#
# This catches a change made *indirectly*: a harmless-looking module that
# overrides the firewall, adds a root service, or puts a user in `wheel`.
#
# It is a tripwire, not a proof. Known gap: a package added to the system path
# can carry its own D-Bus or polkit files. See docs/SELFMOD.md.
{ lib, config }:
let
  # Make any value safe to serialise: no derivations, functions or paths.
  clean = v:
    if lib.isDerivation v then toString v
    else if builtins.isAttrs v then lib.mapAttrs (_: clean) v
    else if builtins.isList v then map clean v
    else if builtins.isFunction v then "<function>"
    else if builtins.isPath v then toString v
    else v;

  hash = v: builtins.hashString "sha256"
    (builtins.unsafeDiscardStringContext (builtins.toJSON (clean v)));

  # The one unit whose program Woody may change freely: its own agent.
  # Its sandbox settings are still fingerprinted below.
  exemptUnits = [ "woody-agent.service" ];

  # Reload/restart triggers only say "some input changed"; the inputs that
  # matter are fingerprinted directly, and D-Bus's trigger changes whenever
  # any package is installed.
  stripTriggers = text:
    lib.concatStringsSep "\n" (lib.filter
      (line: !(lib.hasPrefix "X-Restart-Triggers=" line || lib.hasPrefix "X-Reload-Triggers=" line))
      (lib.splitString "\n" text));

  unitHash = u: hash {
    text = if (u.text or null) == null then null else stripTriggers u.text;
    enable = u.enable or true;
    wantedBy = u.wantedBy or [ ];
    requiredBy = u.requiredBy or [ ];
    aliases = u.aliases or [ ];
  };

  agent = config.systemd.services.woody-agent;

  # /etc entries that configure privilege, login, or code run by root or by
  # the administrator's shell.
  sensitiveEtc = [
    "sudoers" "doas.conf" "ssh/" "pam.d/" "security/" "polkit-1/" "passwd" "group" "shadow"
    "subuid" "subgid" "nix/" "udev/" "modprobe.d/" "sysctl.d/" "profile" "bashrc" "bash_logout"
    "zshrc" "zshenv" "zprofile" "environment" "hosts" "nsswitch.conf" "greetd/"
    "systemd/system.conf" "systemd/user.conf" "systemd/logind.conf" "systemd/journald.conf"
    "crontab" "cron.d/" "ld-nix.so.preload" "ld.so.preload"
  ];
  isSensitiveEtc = name: lib.any (p: name == p || lib.hasPrefix p name) sensitiveEtc;

  fwFields = f: {
    allowedTCPPorts = f.allowedTCPPorts or [ ];
    allowedUDPPorts = f.allowedUDPPorts or [ ];
    allowedTCPPortRanges = f.allowedTCPPortRanges or [ ];
    allowedUDPPortRanges = f.allowedUDPPortRanges or [ ];
  };
  fw = config.networking.firewall;
in
{
  # Every systemd unit: services, sockets, timers, mounts, paths.
  units = lib.mapAttrs (_: unitHash) (removeAttrs config.systemd.units exemptUnits);
  userUnits = lib.mapAttrs (_: unitHash) config.systemd.user.units;
  unitPackages.all = hash (map toString config.systemd.packages);

  # The agent's sandbox and environment (everything except which build runs).
  agentSandbox.woody-agent = hash {
    serviceConfig = removeAttrs agent.serviceConfig [ "ExecStart" ];
    environment = agent.environment;
    wantedBy = agent.wantedBy;
  };

  users = lib.mapAttrs
    (_: u: hash {
      inherit (u) uid group extraGroups isNormalUser isSystemUser home;
      shell = toString u.shell;
      password = u.password or null;
      hashedPassword = u.hashedPassword or null;
      initialPassword = u.initialPassword or null;
      initialHashedPassword = u.initialHashedPassword or null;
      hashedPasswordFile = u.hashedPasswordFile or null;
      keys = u.openssh.authorizedKeys.keys;
      keyFiles = map toString u.openssh.authorizedKeys.keyFiles;
    })
    config.users.users;
  groups = lib.mapAttrs (_: g: hash { inherit (g) gid members; }) config.users.groups;
  userPolicy.mutableUsers = hash config.users.mutableUsers;

  sudo.config = hash {
    enable = config.security.sudo.enable;
    text = config.security.sudo.configFile or null;
    wheelNeedsPassword = config.security.sudo.wheelNeedsPassword;
    extraRules = config.security.sudo.extraRules;
    extraConfig = config.security.sudo.extraConfig;
    doas = config.security.doas.enable;
  };
  setuidWrappers = lib.mapAttrs
    (_: w: hash {
      source = toString w.source;
      inherit (w) owner group setuid setgid permissions;
      capabilities = w.capabilities or "";
    })
    config.security.wrappers;
  polkit.config = hash {
    enable = config.security.polkit.enable;
    extraConfig = config.security.polkit.extraConfig;
    adminIdentities = config.security.polkit.adminIdentities;
  };
  pam = lib.mapAttrs (_: s: hash s.text) config.security.pam.services;

  firewall.config = hash ({
    enable = fw.enable;
    trustedInterfaces = fw.trustedInterfaces or [ ];
    extraInputRules = fw.extraInputRules or "";
    extraForwardRules = fw.extraForwardRules or "";
    extraCommands = fw.extraCommands or "";
    interfaces = lib.mapAttrs (_: fwFields) (fw.interfaces or { });
    nftables = config.networking.nftables.enable;
    ruleset = config.networking.nftables.ruleset or "";
    tables = lib.mapAttrs (_: t: { inherit (t) enable family content; }) (config.networking.nftables.tables or { });
  } // fwFields fw);

  ssh.config = hash {
    enable = config.services.openssh.enable;
    ports = config.services.openssh.ports;
    openFirewall = config.services.openssh.openFirewall;
    settings = config.services.openssh.settings;
    extraConfig = config.services.openssh.extraConfig;
  };

  # Code that runs as root when the system is activated or booted. Two entries
  # are left out: "etc" changes whenever any /etc file does (the files that
  # matter are fingerprinted under `etc`), and "script" is the concatenation
  # of all the others.
  activation = lib.mapAttrs
    (_: s: hash (if builtins.isString s then s else s.text))
    (removeAttrs config.system.activationScripts [ "etc" "script" ]);
  tmpfiles.config = hash {
    rules = config.systemd.tmpfiles.rules;
    settings = config.systemd.tmpfiles.settings;
  };
  udev.config = hash {
    extraRules = config.services.udev.extraRules;
    packages = map toString config.services.udev.packages;
  };
  kernel.config = hash {
    params = config.boot.kernelParams;
    modules = config.boot.kernelModules;
    blacklist = config.boot.blacklistedKernelModules;
    modprobe = config.boot.extraModprobeConfig;
    sysctl = config.boot.kernel.sysctl;
    postBoot = config.boot.postBootCommands;
  };

  # Code that runs in every shell, including the administrator's.
  shell.config = hash {
    shellInit = config.environment.shellInit;
    loginShellInit = config.environment.loginShellInit;
    interactiveShellInit = config.environment.interactiveShellInit;
    extraInit = config.environment.extraInit;
    aliases = config.environment.shellAliases;
    variables = config.environment.variables;
    sessionVariables = config.environment.sessionVariables;
    bashShellInit = config.programs.bash.shellInit;
    bashLoginShellInit = config.programs.bash.loginShellInit;
    bashInteractiveShellInit = config.programs.bash.interactiveShellInit;
  };

  nix.config = hash {
    settings = config.nix.settings;
    overlays = builtins.length config.nixpkgs.overlays;
  };

  etc = lib.mapAttrs
    (_: e: hash {
      source = toString e.source;
      inherit (e) enable target mode;
      user = e.user or null;
      group = e.group or null;
    })
    (lib.filterAttrs (name: _: isSensitiveEtc name) config.environment.etc);
}
