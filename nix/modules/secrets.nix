# Secrets management with sops-nix.
#
# The VM generates its own age key on first boot. Secrets are stored encrypted
# in git and decrypted at activation into /run/secrets, readable only by the
# service that needs them. No secrets are defined yet; the Claude API key is
# the first one, added in Phase 2.
{ ... }:
{
  sops.age = {
    keyFile = "/var/lib/sops-nix/key.txt";
    generateKey = true;
  };
}
