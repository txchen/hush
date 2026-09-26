---
name: hush
description: Use when running commands with credentials managed by Hush, choosing a Hush Profile, connecting a machine to Hush, or troubleshooting Hush CLI access. Applies to requests such as "use Hush for the GitHub token" or "run this with the cloudflare profile". Does not cover developing or deploying the Hush vault service itself.
---

# Use Hush credentials

Hush decrypts secrets locally and supplies a Profile's environment mappings to a child command. Use it to run the user's requested tool without retrieving secret values into agent context or writing them to files. The CLI is read-only; the owner manages secrets, Profiles, and devices in Web admin.

## Select the connection and Profile

1. Check `command -v hush` and `hush version`. If unavailable, read [setup.md](references/setup.md#install-the-cli).
2. Use the user's specified configuration directory consistently. `--config-dir` is a global flag and must precede the subcommand:

   ```sh
   hush --config-dir /private/path/hush status --json
   ```

   Otherwise use the default connection. Do not search other users' credential directories or switch vaults to get around an access failure.

3. Run `hush status --json`. Proceed when it succeeds with `status: "connected"`; on failure, follow the failure guidance below.
4. Run `hush profile list --json`. The response contains a `profiles` array; each Profile has a `name` and `mappings` with `env_name` and `secret_id`. Choose the exact Profile name the user requested. If none was specified, choose a Profile whose mappings match the tool's required variables; ask which to use when the available metadata leaves multiple plausible choices.

Only list secret metadata with `hush secret list --json` when needed to understand a mapping. Names and IDs are metadata, not secret values. The CLI has no `get`, `show`, or `copy` command. If a Profile or required mapping is missing, ask the owner to create or update it in Web admin rather than inventing a CLI write command.

## Run the requested command

Wrap the tool directly, quoting the exact Profile name when necessary:

```sh
hush exec github -- gh api user
hush exec 'production cloudflare' -- wrangler deploy
hush --config-dir /private/path/hush exec github -- gh api user
```

These are syntax examples; execute only the action the user requested. Access to a Profile does not authorize additional deployments, writes, or other external actions.

`exec` inherits the current directory and environment; mapped variables override existing variables with the same names. Each invocation fetches and decrypts online. Credentials apply to that command and its descendants, so wrap each separate credential-dependent command. Profile selection controls which values are injected; it is not a server-side access restriction for the device.

Arguments after `--` are literal; Hush does not add a shell. Use `./tool` for a local executable. If the task requires a shell expression, place it inside the wrapped command and use single quotes so expansion happens after injection:

```sh
hush exec github -- sh -c 'gh api user && gh api rate_limit'
```

Hush preserves standard streams, terminal access, signals, and the target's exit status. Report the requested command's outcome; a successful connection check alone does not mean the task completed.

## Keep secret values out of agent context

Use the tool's environment-based authentication. Do not extract values with `env`, `printenv`, `echo`, shell tracing, or debug output, or interpolate them into command-line arguments, URLs, source files, or `.env` files. Hush does not redact child output; choose commands and logging modes that do not print authentication material.

Do not read or upload `credentials.json`: it contains the device private key and Access credentials. For diagnostics, use CLI status, metadata, and file ownership/permission metadata. If the user asks to reveal or copy a secret, direct them to Web admin rather than constructing an indirect reveal command.

## Handle failures

JSON is emitted only for successful metadata commands. Check the exit status before parsing stdout; CLI failures use plain stderr and exit 1. After the target starts, its own stderr and exit status are passed through, so exit 1 alone does not identify a Hush failure.

| Failure                                                          | Next action                                                                                                                                                             |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI unavailable or npm returns 404                               | Read [installation guidance](references/setup.md#install-the-cli); use a verified standalone binary when npm distribution is unavailable.                               |
| Missing credentials, not enrolled, or Access credentials missing | Read [device connection guidance](references/setup.md#connect-a-machine). Explain the required owner/user step; routine commands should not start an interactive login. |
| Access denied, expired token, or revoked device                  | Ask the owner to check device registration, the Access Service Auth policy, and token validity. A token refresh requires the user's existing provisioning channel.      |
| Missing Profile or mapping                                       | Ask the owner to update Web admin, then refetch Profile metadata.                                                                                                       |
| Unsafe credential permissions                                    | Inspect ownership and modes without reading contents. Expected directory/file modes are `0700`/`0600`; retain the current user's identity and avoid broadening access.  |
| TLS, service, or decryption failure                              | Report the diagnostic and the affected operation. Restore service/trust or have the owner verify registration; do not disable TLS checks or use cached plaintext.       |
| Target command failed                                            | Diagnose the tool's error. Do not replay an external mutation just because it returned a nonzero exit status; first determine whether it already took effect.           |

Hush prevents launching the target when fetching or decrypting inputs fails. It already retries inconsistent vault revisions internally. Avoid indefinite retries. Do not run `logout`, delete credentials, reinitialize a device, or change the service URL as an access-repair shortcut: those actions can remove or replace the enrolled identity. Perform identity changes only when the user requests them.

For detailed provisioning and operational troubleshooting, consult the [CLI guide](https://github.com/txchen/hush/blob/main/apps/cli/README.md).
