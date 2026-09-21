# Hush CLI

A read-only Go client for coding agents. It decrypts selected Profile secrets locally and supplies them to a command as environment variables. Every execution requires the service; there is no offline vault cache.

## Platforms and installation

The release build produces `linux/amd64`, `linux/arm64`, and `darwin/arm64` archives containing a standalone `hush` executable, plus `SHA256SUMS`. Linux uses `CGO_ENABLED=0` and needs no system dynamic libraries, desktop, or keychain. HTTPS still requires trusted CA certificates. The macOS runtime matrix covers Apple Silicon on macOS 14, 15, and 26; the binaries are not Developer ID signed or notarized.

Download the matching archive and checksums from [GitHub Releases](https://github.com/txchen/hush/releases), verify the checksum, then extract and install `hush` into a directory on your `PATH`. For example, for a local development build on Linux x86_64:

```sh
python3 scripts/build-cli.py --version dev
cd dist/cli/dev
sha256sum --check SHA256SUMS
tar -xzf hush_dev_linux_amd64.tar.gz
mkdir -p "$HOME/.local/bin"
install -m 0755 hush "$HOME/.local/bin/hush"
```

On macOS use `shasum -a 256 -c SHA256SUMS` and the `darwin_arm64` archive. No Homebrew formula, automatic updater, or install script is required. Keep the Go toolchain and version argument fixed to reproduce archive bytes.

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

## Development and validation

From the repository root:

```sh
(cd apps/cli && go test -race ./... && go vet ./...)
python3 scripts/build-cli.py --version dev
```

Go 1.26+ is required for the standard library HPKE API; CI pins Go 1.26.5. Python 3 is needed only to build release archives. The CLI module is independent of npm and the Go interoperability verification module. Tests consume the shared public protocol fixture, use local HTTPS API fixtures with real cryptography, and exercise execution through subprocesses.

`.github/workflows/cli.yml` runs tests on native Linux x86_64/ARM64 and macOS ARM64 runners, static tests in Alpine on both Linux architectures, and builds all archives after tests succeed. Cross-compilation alone does not establish runtime compatibility; check the actual CI results before publishing. The workflow uploads build artifacts and does not publish releases or deploy Cloudflare resources.
