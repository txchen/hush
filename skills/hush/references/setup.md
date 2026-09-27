# Install and connect Hush

Read this only when the CLI is missing or the user asks to connect a machine. A working installation and connection need no new enrollment. Confirm the intended service URL and configuration directory before creating an identity.

## Install the CLI

Hush supports Linux x86_64, Linux ARM64, and Apple Silicon macOS. Prefer an existing installation; check `command -v hush`, `hush version`, and `hush --help`.

Install the latest GitHub Release with:

```sh
curl -fsSL https://raw.githubusercontent.com/txchen/hush/main/install.sh | bash
hush version
```

The installer verifies SHA-256 and installs into `~/.local/bin`; add that directory to `PATH` if prompted. It requires Bash, curl, tar, and `sha256sum` or `shasum`, with no Node.js or Go dependency. For a specific release or directory, set `HUSH_VERSION=v0.0.1` or `HUSH_INSTALL_DIR=/absolute/path` on the `bash` side of the pipe. Reuse the original install directory when upgrading.

For manual installation, follow the [standalone installation guide](https://github.com/txchen/hush/blob/main/apps/cli/README.md#standalone-binary): download the matching archive and `SHA256SUMS` from [Hush Releases](https://github.com/txchen/hush/releases), verify the selected archive before extracting, and install the executable on `PATH`. If no release binary exists, build from source using the [development guide](https://github.com/txchen/hush/blob/main/docs/development.md#build-cli-binaries).

Upgrading the executable retains credentials. Do not run `logout` or enroll a new device during an upgrade.

## Connect a machine

The owner must have deployed a vault and initialized it in Web admin. Each CLI installation needs its own Cloudflare Access Service Token and device registration.

1. Obtain the HTTPS service origin, a device name, and the Access Client ID from the user. Have the owner include this machine's token in the application's **Service Auth** policy. Keep the Client Secret in the user's secure provisioning channel; do not request it in chat.
2. When setup is requested, initialize the local identity with the supplied public parameters:

   ```sh
   hush init --url https://hush.example.com --name agent-server --client-id YOUR_ID.access
   ```

   Replace the example values. If a custom directory was selected, prepend `--config-dir /private/path/hush` before `init` and every subsequent subcommand. Initialization is local and does not contact the service.

3. Give the owner the returned public enrollment fields: `id`, `name`, `public_key`, and `access_client_id`. Have them enter these in Web admin's **Devices → Register CLI device** form. Wait for registration before login. Matching initialization can reprint an existing identity; conflicting settings are rejected and should not be repaired by deleting credentials.
4. Have the user run `hush login` in a terminal and enter the Access Client Secret at the hidden prompt. For explicitly requested unattended provisioning, a secret manager may pipe the token directly into `hush login --secret-stdin`. Avoid token literals in shell commands, process arguments, logs, or history. Hush never needs the owner's master password for CLI enrollment.
5. Verify `hush status --json` succeeds with `status: "connected"`, then list Profiles with `hush profile list --json`.

The configuration directory represents one connection and device identity. It must belong to the current user with mode `0700`; credential files use `0600`. Linux defaults to `$XDG_CONFIG_HOME/hush` or `$HOME/.config/hush`; macOS defaults to `$HOME/Library/Application Support/hush`. In containers, use a trusted CA bundle and a securely persisted directory owned by the runtime user. Do not share a writable credential directory between OS users.

If connection remains blocked, identify the missing owner/user step and continue independent work that does not require these credentials. Preserve the existing identity while the owner fixes token validity, Service Auth policy, or device registration.
