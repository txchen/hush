# CLI Implementation Scope

Status: Implemented and validated locally and in native multi-platform GitHub Actions. Production enrollment remains unverified.

## Confirmed requirements

- Implement the Go CLI for `linux/arm64`, `linux/amd64`, and `darwin/arm64`. No 32-bit targets are required.
- The primary users are coding agents. Registered clients must support unattended execution without an interactive password prompt.
- First-release commands cover device setup/enrollment information, connection status, secret/profile metadata listing, `hush exec <profile> -- <command> [args...]`, and clearing local credentials. Secret reveal/copy remains in the Web admin.
- Each execution fetches ciphertext online. Do not persist a vault-content cache or fall back to offline execution. If the service is unavailable, the CLI must fail without launching the requested command.
- The confidentiality threat model includes theft of the service database. Active compromise or malicious modification of the hosted frontend by the infrastructure provider is outside the current scope.
- Database theft must not directly expose secret values or plaintext vault keys. Offline master-password guessing remains a documented risk.
- Store device private keys and Access credentials in local files on all three platforms, with a private directory (`0700`) and credential files (`0600`). No OS keychain or interactive unlock is required. Possession of the credential files permits device impersonation; this trade-off is accepted for unattended agent use.
- `exec` inherits the calling environment and overrides matching variables with the selected Profile's mappings. Execute the command directly without an implicit shell. Preserve standard input/output/error, signal behavior, and the command's exit status. The CLI must not print secrets itself; child output is passed through without redaction.
- One-time manual enrollment is acceptable: generate the device key locally, export public registration information for Web admin, securely enter the manually provisioned Access credentials locally, and verify connectivity. Do not accept the Access token secret as a command-line argument. Routine use requires no master password.
- Distribute one archive per target containing the standalone `hush` binary, with SHA-256 checksums. Include reproducible build commands and CI workflows. Homebrew packaging, installation scripts, and automatic updates are outside the first release.
- `status`, `secret list`, and `profile list` support human-readable text and `--json` metadata output. Errors go to stderr with nonzero exit status. Routine agent commands must never prompt interactively.
- Support headless Linux servers and minimal containers, including Alpine. Linux binaries must not require system dynamic libraries, a desktop, or a keychain; containers must provide HTTPS CA certificates and an accessible credential directory. Support Apple Silicon on macOS versions still supported at implementation time.

## Consolidated command behavior

- Local setup generates a device keypair and exports public enrollment information. Separate credential entry and connectivity verification allow completion after manual Web enrollment. Repeating setup must not silently replace an existing device key.
- `hush status [--json]` reports local setup and online device connectivity without exposing credential material.
- `hush secret list [--json]` and `hush profile list [--json]` expose metadata only.
- `hush exec <profile> -- <command> [args...]` fetches the selected Profile and encrypted values, unwraps the device VEK locally, and decrypts all required values before launching the command. Authentication failures, revoked devices, unavailable service, inconsistent key versions, or decryption failures must not launch the command. Any retry for a concurrent rotation must be bounded and refetch consistent inputs.
- `hush logout` removes local device credentials; remote revocation remains an owner Web operation, as defined in ADR-0001.
- One vault connection per configuration directory; an explicit configuration-directory option allows separate connections on one machine.
- Secret reveal/copy, service mutations, master-password recovery, offline execution, and a local administrative UI are outside this release.

## Existing decisions carried forward

- Use an independent Go module under `apps/cli/`.
- CLI device sessions are read-only; owner mutations belong to the Web admin workflow, per ADR-0001 and the service scope.
- Generate the device private key locally and export only public enrollment information. The owner registers the device through Web admin.
- Use the existing format-1 cryptographic protocol and cross-language fixtures.

## Implementation and validation plan

- Implement focused Go modules for credential persistence, the read-only service client, format-1 decryption, and command execution under `apps/cli/`.
- Verify product decryption against the existing cross-language fixtures, including rejection of incorrect AAD and tampered ciphertext.
- Test credential permissions, setup reuse, local logout, token handling, and the absence of persisted plaintext vault keys or secret values.
- Test service authentication/revocation failures, malformed responses, unavailable service, and concurrent key-version changes. Verify failure paths never launch the requested child command or expose secrets in diagnostics.
- Test Profile-only injection, inherited environment overrides, exact argument handling without shell interpretation, standard streams, signals, and exit statuses.
- Build all three target archives and checksums. Add platform CI execution and a minimal Linux-container smoke test; report actual runtime coverage separately from successful cross-compilation.
- Document installation, one-time manual enrollment, agent usage, configuration directories, local credential storage, and troubleshooting in English. Run relevant existing repository checks to detect regressions.
- Deliver code, tests, workflows, documentation, and local artifacts. Publishing remote releases or deploying services is not part of this implementation.

## Delivered and verified

- Independent Go CLI with `init`, `login`, `status`, `secret list`, `profile list`, `exec`, `logout`, and `version`; explicit configuration directories and JSON metadata output.
- Private file credentials with permission/ownership validation, atomic replacement, mutation locking, repeatable public enrollment export, and locally verified device wrapping before saving login credentials.
- Bounded HTTPS reads, no redirects or raw response diagnostics, vault identity pinning at login, format-1 HPKE/AES-GCM decryption, and bounded retries for inconsistent snapshot revisions.
- Direct process replacement with Profile-only injection, inherited environment overrides, literal arguments, standard streams, exit codes, and signals.
- Linux x86_64 tests passed natively with the race detector and in an Alpine 3.23 container using the static test binary. Tests cover protocol fixtures, failure paths that must not execute commands, local credential lifecycle, and subprocess behavior. `go vet` passed.
- All three target archives and SHA-256 checksums built locally. Both Linux targets are statically linked; macOS output is an ARM64 Mach-O executable. Deterministic packaging was checked by rebuilding all targets and comparing checksums.
- Existing repository type/format/lint/contract checks, 30 service tests, three Web crypto tests, and JavaScript/Go interoperability checks passed.
- Native GitHub Actions tests passed on Linux x86_64/ARM64 and Apple Silicon macOS 14/15/26, including Alpine tests on both Linux architectures and service/Web checks. See [the initial CI run](https://github.com/txchen/hush/actions/runs/35645840653). Release tags build versioned archives after the same checks pass.
- Installation, one-time enrollment, agent usage, container setup, and troubleshooting are documented in `apps/cli/README.md`. The user subsequently authorized publishing the repository and CLI version `0.0.1`; Cloudflare deployment remains outside this work.

## References

- [Service scope](../service/spec.md)
- [Owner and device authority](../../docs/adr/0001-separate-owner-and-device-authority.md)
- [Cryptographic protocol](../../contracts/crypto.md)
- [Unattended CLI credential storage](../../docs/adr/0004-file-credentials-for-unattended-cli.md)
