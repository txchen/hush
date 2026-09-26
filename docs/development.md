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
- `build` builds the Web assets and performs a Worker deployment **dry run**. It does not publish anything.

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

Tag builds derive the version from `v<version>` and upload archives and npm tarballs after service/Web and native platform tests pass. A second matrix installs the npm tarballs on every supported runner. The workflow does not create a GitHub Release or deploy Cloudflare resources. Release binaries should come from the successful tag run, with their checksums verified before publishing.

## Package and publish the CLI to npm

```sh
python3 scripts/build-cli.py --version 0.0.0-test
npm run pack:cli -- --version 0.0.0-test
npm run test:cli:npm
node scripts/publish-cli-npm.mjs 0.0.0-test --dry-run
```

Packaging verifies `SHA256SUMS` and embeds those exact binaries in three platform packages, then creates the `@txchen/hush` entry package with exact-version optional dependencies. Generated packages and tarballs live in `dist/npm/<version>/`, outside the application's npm workspaces. Versions must be canonical SemVer without build metadata. Set `HUSH_NPM_VERSION=<version>` when testing a version other than `0.0.0-test`.

The install test uses a disposable local registry and global prefix. It checks platform selection, installation with scripts disabled, the real binary's version, and launcher PID, arguments, environment, standard streams, signals, exit status, and missing/mismatched platform packages. It does not change the developer's global installation. The Node.js 24+ launcher uses [`process.execve`](https://nodejs.org/docs/latest-v24.x/api/process.html#processexecvefile-args-env) to replace itself with Go; this API is experimental, so CI tests the process behavior on all supported runners.

For the first release:

1. Create a `v<version>` tag and wait for CI, including `npm-test`, to pass. Download the `hush-npm` artifact into `dist/npm/<version>/` from that run.
2. Log into npm as an account that owns `@txchen`, and run `node scripts/publish-cli-npm.mjs <version>`. This publishes the three platform tarballs before the entry package. Stable versions use `latest`; prereleases use `next`. Repeating the command skips versions already published with identical integrity and refuses to overwrite different contents.
3. Configure an npm [trusted publisher](https://docs.npmjs.com/trusted-publishers/) for each of `@txchen/hush`, `@txchen/hush-linux-x64`, `@txchen/hush-linux-arm64`, and `@txchen/hush-darwin-arm64`: GitHub owner `txchen`, repository `hush`, workflow filename `cli.yml`, no environment name.
4. Enable subsequent tag publishing with `gh variable set NPM_PUBLISH_ENABLED --body true`. The `npm-publish` job uses OIDC and requires no stored npm token. Leave this variable unset until all four trusted publishers are configured.

Subsequent `v<version>` tags publish only after all checks pass. If a publication stops partway through, rerun the failed publish job using the original artifacts. The standalone GitHub Release archives remain available as a distribution channel without Node.js.

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

Vite+ is installed locally and invoked through npm scripts. Root overrides align Vite/Vitest and the Cloudflare Workers test pool's Miniflare/workerd with Wrangler; update these together and rerun relevant checks.

After binding changes, regenerate runtime types with:

```sh
npm run types -w @hush/service
```

Keep credentials out of source files, fixtures, and logs. Cryptographic fixtures contain deliberately public test keys. Preserve their warning and never reuse them in real vaults.

For the reasons behind the current design, read the [architecture decisions](adr/) and [domain glossary](../CONTEXT.md). The old pre-implementation design proposal has been removed; current behavior is documented in the user guides, protocol, and implementation scopes.
