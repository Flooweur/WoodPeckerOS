# Recall by meaning: a small embedding model that runs on this machine.
#
# Woody's memory is searched by words. With this service it is also searched
# by meaning: a question about a "trip" finds a memory about a "holiday", in
# French as well as in English (docs/MIND.md, agent/src/core/embed.ts).
#
#   /run/woody-embed/embed.sock   the service, on a Unix socket that only its
#                                 own group can open. Woody's user is a member.
#
# The model is bge-m3 (BAAI, MIT licence), in the conversion published by
# ggml-org, the organisation that maintains llama.cpp, the program that runs
# it. Nix downloads the file once and checks it against the hash below.
#
# The service has no network at all, no rights, and can write nowhere. It is
# given texts and returns lists of numbers; nothing else goes in or out.
#
# This file is a locked path (nix/locked/executor.nix): which model file the
# machine downloads and runs changes only with your approval.
{ pkgs, ... }:
let
  model = pkgs.fetchurl {
    name = "bge-m3-q8_0.gguf";
    url = "https://huggingface.co/ggml-org/bge-m3-Q8_0-GGUF/resolve/9eba04c5d75ba5a1595e45de734d36bef4e5cb98/bge-m3-q8_0.gguf";
    sha256 = "aa473d51f451a22f0fcf39ba3330c14bed38a385712b1113440f69df4047a173";
  };
  socket = "/run/woody-embed/embed.sock";
in
{
  users.groups.woody-embed = { };
  users.users.woody-embed = {
    isSystemUser = true;
    group = "woody-embed";
    description = "Local embedding model (recall by meaning)";
  };
  # Woody's own user may open the service's socket.
  users.users.woody.extraGroups = [ "woody-embed" ];

  systemd.services.woody-embed = {
    description = "Local embedding model for Woody's recall by meaning";
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      # --pooling cls: bge-m3's vector for a text is taken at its first token.
      # The batch sizes let a whole text of up to 2048 tokens be read at once.
      ExecStart = builtins.concatStringsSep " " [
        "${pkgs.llama-cpp}/bin/llama-server"
        "--model ${model}"
        "--embedding"
        "--pooling cls"
        "--ctx-size 2048"
        "--batch-size 2048"
        "--ubatch-size 2048"
        "--parallel 1"
        "--no-ui"
        "--host ${socket}"
      ];
      User = "woody-embed";
      Group = "woody-embed";
      RuntimeDirectory = "woody-embed";
      RuntimeDirectoryMode = "0750";
      # The socket is created for the owner and the group only.
      UMask = "0007";
      Restart = "on-failure";
      RestartSec = 5;
      # The model takes about 700 MB of memory; this is a ceiling, not a need.
      MemoryMax = "3G";

      # No network of any kind, no rights, nothing writable.
      PrivateNetwork = true;
      NoNewPrivileges = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      PrivateTmp = true;
      PrivateDevices = true;
      ProtectKernelTunables = true;
      ProtectKernelModules = true;
      ProtectControlGroups = true;
      RestrictSUIDSGID = true;
      LockPersonality = true;
      CapabilityBoundingSet = "";
      RestrictAddressFamilies = [ "AF_UNIX" ];
      SystemCallArchitectures = "native";
    };
  };

  # The agent is told where the service is. Without these two values it
  # searches memory by words only.
  systemd.services.woody-agent = {
    after = [ "woody-embed.service" ];
    wants = [ "woody-embed.service" ];
    environment = {
      WOODY_EMBED_URL = "unix:${socket}";
      # The name stored with every vector: vectors of another model are never compared with these.
      WOODY_EMBED_MODEL = "bge-m3-q8_0";
    };
  };
}
