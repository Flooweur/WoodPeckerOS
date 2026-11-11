# Woody's own module: the place where Woody adds packages and settings.
#
# This file is not part of the locked core, so a change here can be applied
# without human approval, provided it does not alter anything in the
# privilege fingerprint (nix/locked/fingerprint.nix): services, users, sudo,
# the firewall, SSH and so on. If it does, the change waits for approval.
{ pkgs, ... }:
{
  environment.systemPackages = [
  ];
}
