# Hush CLI

Hush decrypts selected Profile secrets locally and supplies them to a command as environment variables.

Requires Node.js 24+ and Linux x64, Linux ARM64, or Apple Silicon macOS.

```sh
npm install -g @txchen/hush
hush version
```

Upgrade with `npm install -g @txchen/hush@latest`. Existing device credentials are retained.

The matching Go binary is included through a platform-specific optional dependency. Keep optional dependencies enabled; no install scripts or additional binary downloads are needed. The launcher replaces itself with the native executable, preserving signals, terminal I/O and exit status.

For setup, enrollment and usage, see the [CLI guide](https://github.com/txchen/hush/blob/main/apps/cli/README.md). Standalone binaries that do not require Node.js are available from [GitHub Releases](https://github.com/txchen/hush/releases).

For agent instructions, use the [Hush skill](https://github.com/txchen/hush/tree/main/skills/hush). Install the complete skill directory separately from this CLI package.
