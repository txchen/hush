# Developing Hush

For deployment and use, start with the [README](../README.md). This guide covers source builds, tests, and implementation references.

## Repository layout

```text
apps/service/           Hono API, D1 migrations, Workers integration tests
apps/web/               Vue Web admin and browser tests
apps/cli/               Independent Go CLI module and tests
contracts/openapi.yaml  Generated API contract
contracts/crypto.md     Versioned cryptographic wire format
contracts/fixtures/     Public interoperability test vectors
contracts/verify-go/    Independent Go interoperability verifier
scripts/               Contract generation, crypto checks, CLI packaging
docs/adr/              Architecture decisions
CONTEXT.md             Domain glossary
.scratch/              Implementation scope and decision records
```

The Web admin uses Vue 3, TypeScript, Composition API, and Vite+. The service uses Hono on Workers with D1 storage. npm workspaces manages the Web and service dependencies with one root lockfile; the CLI and Go protocol verifier have independent Go modules.

## Requirements and checks

Use Node.js 24+, npm 11, and Go 1.26+. CLI release packaging also requires Python 3. CI pins its Go toolchain in [the workflow](../.github/workflows/cli.yml).

From the repository root:

```sh
npm ci
npm run check
npm test
npm run test:crypto
npm run test:crypto:go
npm run test:cli
npm run build
```

- `check` runs type checking, formatting/lint checks, and API-contract freshness checks.
- `test` builds the Web assets, then runs Workers integration tests and Web crypto tests.
- `test:crypto` and `test:crypto:go` independently verify the shared cryptographic vectors.
- `test:cli` runs Go tests with the race detector and `go vet`.
- `build` builds the Web assets and builds the Worker with `cf build`. It does not publish anything.

Workers tests use local D1, locally signed test JWTs, and mocked Access public-key discovery. Browser tests use isolated HTTP fixtures with real browser cryptography:

```sh
npx playwright install chromium
npm run test:ui
```

CLI tests use local HTTPS fixtures and the shared protocol vectors, and exercise argument/environment handling, streams, signals, and exit status through subprocesses. CI runs native tests on all supported architectures and static test binaries in Alpine on both Linux architectures.

## Run locally

```sh
npm run db:migrate
npm run build -w @hush/web
npm run dev
```

`db:migrate` uses the local database. The checked-in Access settings are placeholders and fail closed with `503`; the production Worker has no development authentication bypass. Manual API calls require a valid JWT for the configured Access application. Automated tests provide the supported isolated path for exercising authenticated flows without a deployed account.

For frontend development, `npm run dev:web` starts Vite and proxies `/api` to the local Worker on port 8787. Worker authentication still applies. Local serving alone does not reproduce the full production Access login flow.

## Build CLI binaries

```sh
npm run build:cli
# Or set an explicit version:
python3 scripts/build-cli.py --version 0.0.1
```

Artifacts go into `dist/cli/<version>/`: one archive per platform plus `SHA256SUMS`. Both Linux binaries use `CGO_ENABLED=0`. With the same source, toolchain, and version argument, the packaging script produces deterministic archives.

To build only for the current machine:

```sh
(cd apps/cli && go build -o ../../dist/native/hush ./cmd/hush)
./dist/native/hush version
```

Tag builds derive the version from `v<version>` and upload archives after service/Web and native platform tests pass. A second matrix exercises the installer with those exact archives on every supported runner. Successful tag builds then publish the archives and `SHA256SUMS` to GitHub Releases. CI does not deploy Cloudflare resources.

## Publish the CLI to GitHub Releases

Commit the release changes to `main`, then create and push a new version tag:

```sh
git tag -a v0.0.2 -m "Hush 0.0.2"
git push origin v0.0.2
```

Use a new version for each release. Tags must have the form `vX.Y.Z` or `vX.Y.Z-<prerelease>`. The `release` job uses GitHub's built-in token with `contents: write`; no npm account or registry token is needed. Prerelease tags produce GitHub prereleases and do not replace the latest stable release.

Users install or upgrade with:

```sh
curl -fsSL https://raw.githubusercontent.com/txchen/hush/main/install.sh | bash
```

The installer resolves the latest release through `SHA256SUMS`, then downloads its exact version's archive and verifies the checksum before execution or installation. `HUSH_VERSION=v0.0.2` selects a specific release; `HUSH_INSTALL_DIR=/absolute/path` overrides `~/.local/bin`. See the [CLI guide](../apps/cli/README.md#installation).

Run the offline installer tests with `npm run test:cli:install` (or `python3 scripts/test-cli-install.py`). They cover platform selection, version pinning, failed downloads, checksum failures, and preservation of an existing installation. To also install and execute a locally built native archive:

```sh
python3 scripts/build-cli.py --version 0.0.0-test
HUSH_TEST_ARCHIVE_DIR=dist/cli/0.0.0-test python3 scripts/test-cli-install.py
```

Tests use disposable directories and a local download fixture. They do not alter your installed CLI or credentials.

## API and concurrency

All endpoints are under `/api/v1`; see [OpenAPI](../contracts/openapi.yaml). Run `npm run contracts` after changing request schemas.

- Owner writes require the configured `Origin`, `X-Hush-Request: 1`, and `If-Match: "<revision>"`. Initialization uses revision `"0"`.
- JSON endpoints require `Content-Type: application/json`; delete and soft-revoke endpoints have no body.
- Reads expose the vault revision through `ETag`. API responses use `Cache-Control: no-store`.
- Every vault-content, device, or key-wrapping mutation checks and advances one revision atomically. Audit and last-seen updates do not advance it.
- Stale writes return `409`. Fetch a fresh snapshot and rebuild encryption; never blindly replay a rotation. After a network timeout, inspect current state before deciding whether a write committed.
- Rotation replaces every current secret and the master/device wraps for all remaining active devices in one transaction. Incomplete submissions are rejected.

The Worker validates envelope structure, versions, lengths, and known nonce reuse; it cannot prove that an uploaded blob wraps the intended VEK. Clients are responsible for implementing the [cryptographic protocol](../contracts/crypto.md). The product's resource limits are documented in [operations](operations.md#limits).

## Configuration and dependencies

Vite+ is installed locally and invoked through npm scripts. Root overrides align Vite/Vitest and the Cloudflare Workers test pool's Miniflare/workerd with the Wrangler bundler used by `cf`; update these together and rerun relevant checks.

After binding changes, regenerate runtime types with:

```sh
npm run types -w @hush/service
```

Keep credentials out of source files, fixtures, and logs. Cryptographic fixtures contain deliberately public test keys. Preserve their warning and never reuse them in real vaults.

For the reasons behind the current design, read the [architecture decisions](adr/) and [domain glossary](../CONTEXT.md). The old pre-implementation design proposal has been removed; current behavior is documented in the user guides, protocol, and implementation scopes.

## Cloudflare CLI configuration

Use `cf` for development, builds, type generation, migrations, and deployment. `cloudflare.config.ts` is the shared infrastructure configuration; `wrangler.config.ts` only configures the bundler used by `cf` (asset directory and type-generation behavior). Wrangler remains a local build dependency; no global Wrangler installation is required. Tests configure Miniflare directly and never load the production identity file.

Production commands require `--mode production` and an ignored `deployment.local.json`, copied from `deployment.example.json`. Generated `.cloudflare/` output is ignored because production builds may contain deployment metadata.

cf beta only discovers bundlers directly inside an application's `node_modules`. The root `postinstall` script links the hoisted Wrangler package into `apps/service/node_modules` when needed. This preserves npm's workspace layout while allowing service commands to use `cf`. Run deployment commands from `apps/service`. `npm run types -w @hush/service` writes ignored declarations under `apps/service/.cloudflare/types/`; type checking runs it automatically.
