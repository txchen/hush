# Hush CLI

A read-only Go client for coding agents. It decrypts selected Profile secrets locally and supplies them to a command as environment variables. Every execution requires the service; there is no offline vault cache.

## Installation

With Node.js 24+ and npm:

```sh
npm install -g @txchen/hush
hush version
```

npm selects the prebuilt binary for Linux x86_64, Linux ARM64, or Apple Silicon macOS. Keep optional dependencies enabled; installation works with `--ignore-scripts` and requires no Go compiler or separate binary download. If the platform package is missing, reinstall with `npm install -g @txchen/hush --include=optional`. Intel macOS and Windows are not supported.

Upgrade with `npm install -g @txchen/hush@latest`, or select a specific version with `npm install -g @txchen/hush@<version>`. Upgrades retain the existing device identity and credentials. If `hush version` still shows an older standalone installation, check `command -v hush` and remove the old executable or adjust `PATH`.

Before enrollment, [deploy Hush and initialize your vault](../../README.md#deploy-your-vault), or obtain the service hostname from its owner.

### Standalone binary

The release build produces `linux/amd64`, `linux/arm64`, and `darwin/arm64` archives containing a standalone `hush` executable, plus `SHA256SUMS`. Linux uses `CGO_ENABLED=0` and needs no system dynamic libraries, desktop, or keychain. HTTPS still requires trusted CA certificates. The macOS runtime matrix covers Apple Silicon on macOS 14, 15, and 26; the binaries are not Developer ID signed or notarized.

Download the matching archive and checksums from [GitHub Releases](https://github.com/txchen/hush/releases). The following commands install version `0.0.1`; set `HUSH_TARGET` for your machine:

| Machine           | `HUSH_TARGET`  |
| ----------------- | -------------- |
| Linux x86_64      | `linux_amd64`  |
| Linux ARM64       | `linux_arm64`  |
| Apple Silicon Mac | `darwin_arm64` |

Run in an empty download directory:

```sh
HUSH_VERSION=0.0.1
HUSH_TARGET=linux_amd64
HUSH_ARCHIVE="hush_${HUSH_VERSION}_${HUSH_TARGET}.tar.gz"
HUSH_RELEASE="https://github.com/txchen/hush/releases/download/v${HUSH_VERSION}"
curl -fLO "$HUSH_RELEASE/$HUSH_ARCHIVE"
curl -fLO "$HUSH_RELEASE/SHA256SUMS"
awk -v name="$HUSH_ARCHIVE" '$2 == name { print; found = 1 } END { if (!found) exit 1 }' SHA256SUMS > CHECKSUM
```

Verify the selected archive before extracting it. On Linux:

```sh
sha256sum --check CHECKSUM
```

On macOS:

```sh
shasum -a 256 -c CHECKSUM
```

After the checksum reports **OK**, install:

```sh
tar -xzf "$HUSH_ARCHIVE"
mkdir -p "$HOME/.local/bin"
install -m 0755 hush "$HOME/.local/bin/hush"
export PATH="$HOME/.local/bin:$PATH"
hush version
```

Add `$HOME/.local/bin` to your shell's startup configuration if it is not already on `PATH`. The prebuilt CLI needs neither Go nor Node.js. See [development](../../docs/development.md#build-cli-binaries) to build from source.

## One-time device enrollment

1. Have the owner create a distinct Cloudflare Access Service Token for this machine and include it in the application's Service Auth policy. Keep its Client Secret private.
2. Generate a local device key and print public registration information:

   ```sh
   hush init --url https://hush.example.com --name agent-server --client-id YOUR_ID.access
   ```

   The JSON contains `id`, `name`, `public_key`, and `access_client_id`. Copy these into Web admin's **Devices → Register CLI device** form. Initialization does not contact the service. Repeating the same initialization reprints the existing public information without replacing the private key; conflicting settings are rejected.

3. After the owner registers the device, run:

   ```sh
   hush login
   ```

   Enter the Access Client Secret at the hidden terminal prompt. The CLI verifies service access and locally decrypts the device-wrapped VEK before saving the token and pinning the vault ID. A failed login preserves prior credentials. The CLI never asks for your master password.

4. Verify with `hush status --json`.

For automated provisioning, a secret manager can pipe the token into `hush login --secret-stdin`. This reads one token with an optional trailing newline; it never prompts. Do not put the token itself in command-line arguments or a shell command saved in history.

## Agent commands

For reusable agent instructions, use the [Hush skill](../../skills/hush/SKILL.md). Copy its complete directory into your agent's configured skills directory, including `references/`.

```sh
hush status --json
hush secret list --json
hush profile list --json
hush exec github -- gh api user
hush exec cloudflare -- wrangler deploy
```

Profile selection uses the exact Profile name. The owner creates Profiles and their environment mappings in Web admin. Lists return metadata only, even with `--json`; there are no `get`, `show`, or `copy` commands.

`exec` inherits the current working directory and environment. Only the selected Profile's mappings are added, overriding existing variables with the same name. Every selected value must decrypt successfully before execution; NUL-containing or invalid UTF-8 values are rejected because they cannot be supplied as supported environment strings. The target receives arguments literally, without an implicit shell. If a shell is wanted, request one explicitly, for example `hush exec github -- sh -c 'gh api user'`.

The CLI replaces itself with the target program. Standard streams, terminal access, process ID, signals, and the program's exit status therefore have native process semantics. Executables are resolved using the effective `PATH`; implicit current-directory lookup is rejected (use `./tool` explicitly). CLI failures write a diagnostic to stderr and exit 1. Routine commands never request user input. JSON is emitted to stdout only on successful metadata commands; errors are plain stderr diagnostics.

The CLI does not print secret values or redact child output. A command such as `hush exec github -- env` can expose injected secrets. This tool reduces accidental exposure in agent workflows; it does not sandbox an agent with arbitrary local execution privileges.

## Configuration and local security

The default directory is `$XDG_CONFIG_HOME/hush` or `$HOME/.config/hush` on Linux, and `$HOME/Library/Application Support/hush` on macOS. Use a global flag **before** the command for an explicit directory:

```sh
hush --config-dir /private/path/hush init --url https://hush.example.com --name agent --client-id YOUR_ID.access
hush --config-dir /private/path/hush exec github -- gh api user
```

Each directory represents one vault connection and device identity. The directory must belong to the current user and have mode `0700`; `credentials.json` and the mutation lock use `0600`. Unsafe permissions, credential symlinks, and hard-linked credential files are rejected. Updates are serialized and atomically replace the credential file.

`credentials.json` contains the unencrypted device private key and Access credentials. Anyone who obtains it can impersonate this device. Keep it out of repositories, shared volumes, logs, and broadly accessible backups. No plaintext VEK, secret value, or vault-content cache is intentionally persisted. Go strings, runtime allocations, OS swap, and child environments do not provide guaranteed physical erasure.

```sh
hush logout
```

Logout deletes local credentials but does not revoke a copied credential or stop an already running command. Revoke the device in Web admin to deny future API access. Re-enrolling after logout generates a new identity; provision a new Access Client ID if the old one is still registered or tombstoned. Removal is not secure disk erasure. Credential metadata and the empty `.lock` file may remain; the secret-bearing file is removed.

## Containers and failure handling

For Alpine or other minimal containers, install a trusted CA bundle and supply a writable credential directory owned by the runtime UID with the required modes. Perform enrollment once and persist that directory securely. A read-only credential mount is sufficient for routine commands after login, but setup/login/logout require writes.

Service outages, expired Access tokens, revoked devices, TLS errors, malformed responses, and failed cryptographic authentication prevent command execution. HTTP redirects are not followed, avoiding credential forwarding. Each request has a 15-second timeout within a 45-second operation deadline. When reads straddle a vault mutation, `exec` refetches fresh inputs up to three times; it never mixes key and Profile snapshots with different revisions. Revocation blocks future reads but cannot retract keys or plaintext already obtained by an in-flight or running command.

If Access redirects to a human login page, check the **Service Auth** policy. If device unwrap fails, check that Web admin registered this installation's public key. If file permissions fail, inspect ownership and restore the private directory/file modes; do not share one writable configuration between OS users.

## Further reading

- [Deployment and first use](../../README.md)
- [Encryption flow](../../docs/encryption.md)
- [Development, tests, and source builds](../../docs/development.md)
