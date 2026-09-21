# Hush

A personal encrypted secret vault for developer and coding-agent workflows. The service stores ciphertext and public metadata; clients retain all secret decryption keys.

The implementation includes the **Cloudflare Worker API** and **Vue Web admin**. The Go CLI is a follow-up application. CLI device credentials are read-only; all user-initiated changes belong to the Web admin workflow.

## Repository

```text
apps/service/           Hono API, D1 migrations, Workers integration tests
apps/web/               Vue Web admin and browser tests
contracts/openapi.yaml  Generated API contract
contracts/crypto.md     Versioned client cryptographic protocol
contracts/fixtures/     Public interoperability test vectors
contracts/verify-go/    Go protocol verification, not the CLI application
scripts/               Contract generation and JavaScript vector verification
docs/adr/              Architecture decisions
docs/agents/           Repository guidance
CONTEXT.md             Domain glossary
.scratch/              Agreed service and Web implementation scopes
```

The Web admin uses Vue 3, TypeScript, Composition API, and Vite+, with `vue-tsc` for type checking. Its static assets are served on the API's origin. The future CLI will live at `apps/cli/` as an independent Go module. No React or pnpm is required.

## Development

Use Node.js 24+ and npm 11. Go 1.26+ is only needed for the independent cryptographic interoperability check.

```sh
npm ci
npm run check
npm test
npm run test:crypto
npm run test:crypto:go
npm run build
```

`build` builds the Web assets and runs a Wrangler dry run; it does not deploy. Tests run real local D1 through Cloudflare's Workers Vitest integration; authentication uses locally signed test JWTs and mocked public-key discovery. The production Worker has no authentication bypass.

Vite+ is installed locally and invoked by npm scripts. npm workspaces manages dependencies and the root lockfile. Version overrides align Vite/Vitest and the Cloudflare test pool's Miniflare/workerd with Wrangler; update these together and run all tests. Runtime bindings are generated with `npm run types -w @hush/service`.

To start the local Worker:

```sh
npm run db:migrate
npm run build -w @hush/web
npm run dev
```

The checked-in Access configuration is deliberately nonfunctional. Unconfigured requests fail closed with `503`; use integration tests for the fully automated local API workflow. Local manual requests require a valid JWT for your configured Access application. Do not put JWTs, service-token secrets, master passwords, or vault keys in repository files.

## Web admin

The Web admin supports vault initialization and unlock, secret and profile editing, device management, password changes, key rotation, and audit history. Encryption and password derivation run in the browser; Argon2id runs in a dedicated worker. Sessions lock after 15 minutes of inactivity. Optional browser trust stores a non-extractable device private key in IndexedDB.

The owner-only Database viewer shows schema and raw stored values for eight application tables, with 50-row pagination and JSON inspection. It does not decrypt values, accept arbitrary SQL, or edit rows.

Run `npm run dev:web` for the Vite development server, which proxies `/api` to the local Worker on port 8787. Worker authentication requirements still apply.

Browser tests use isolated HTTP fixtures with real browser cryptography:

```sh
npx playwright install chromium
npm run test:ui
```

## Cloudflare setup

1. Create a D1 database with `npx wrangler d1 create hush` from `apps/service/`, and put its ID in `wrangler.jsonc`.
2. Configure an Access self-hosted application for your Hush domain. Add a human Allow policy restricted to your owner email and a Service Auth policy for the machine tokens you explicitly provision.
3. Set `ACCESS_TEAM_DOMAIN` (hostname only), `ACCESS_AUDIENCE` (application AUD), `OWNER_EMAIL`, and `ADMIN_ORIGIN` (exact HTTPS origin, no trailing slash) in the Worker configuration. Add the domain route. Keep workers.dev and preview URLs disabled.
4. Apply migrations using `npx wrangler d1 migrations apply hush --remote`, then deploy with `npx wrangler deploy`. These are manual deployment steps; this implementation has not provisioned remote resources.
5. Use the Web admin to initialize the vault and enroll devices. Each CLI device generates a private key locally; only its public key and Access Client ID are entered in Web admin. The browser creates the device-wrapped VEK locally.

CLI requests send both `CF-Access-Client-Id` and `CF-Access-Client-Secret` to Access on each request. The Worker verifies the resulting Access JWT and binds its `common_name` to the enrolled Client ID. It never trusts a caller-supplied device ID. Human admin authority comes from the verified email, not a browser user-agent header.

## API and behavior

All endpoints are under `/api/v1`; see [OpenAPI](contracts/openapi.yaml) and [the cryptographic protocol](contracts/crypto.md). Regenerate the contract with `npm run contracts` after request schema changes.

- Owner writes require the configured `Origin`, `X-Hush-Request: 1`, and `If-Match: "<revision>"`. Initialization uses revision `"0"`. JSON endpoints require `Content-Type: application/json`; delete and soft-revoke endpoints have no body.
- Reads expose a vault-wide revision through `ETag`. All responses use `Cache-Control: no-store`.
- A stale write returns `409`. Fetch a fresh snapshot and recompute encryption; never blindly replay a rotation. After a network timeout, inspect current state before deciding whether a write committed.
- Secret IDs are client-generated lowercase UUIDs so clients can bind encryption to the record before uploading. Secret versions start at 1 and advance on every replacement and rotation.
- Profiles map selected secrets to unique environment variable names. Remove mappings before deleting a referenced secret; the service rejects deletion with `secret_in_use`.
- Soft revoke clears the device wrap and blocks its future API reads. Browser trust revocation does not revoke the owner's Access identity. A user who can authenticate and recover with the master password can enroll again.
- Rotation submits all current secret ciphertexts, a new master wrap, and exactly one new wrap for each remaining active device. Revocation and new state publish in one transaction. Already soft-revoked devices are automatically excluded.
- Audit records describe service operations, never local plaintext reveals. Device last-seen records successful ciphertext/key fetches. Neither audit nor activity updates advances the vault revision.

## Limits and trust boundary

The service supports 500 secrets, 50 active devices, 500 total device records including revocation tombstones, 100 profiles, and 500 mappings per profile. Secret envelopes are at most 16 KiB; the ciphertext field is capped at 12,200 decoded bytes including the 16-byte tag (12,184 plaintext bytes). Rotation bodies are capped at 10 MiB and other JSON bodies at 1 MiB. Body size is enforced while streaming, even without Content-Length.

Names, mappings, timestamps, and device public keys are public metadata. The Worker checks strict envelope structure, lengths, versions, and known nonce reuse; it cannot prove that an uploaded blob is correctly encrypted or wraps the same VEK. Authorized clients must implement [crypto.md](contracts/crypto.md) correctly. Secret encryption code and fixture private keys are not part of the Worker bundle.

VEK rotation cannot retract previously copied secrets. Hosted frontend delivery remains trusted: a compromised frontend can misuse browser keys. `hush exec` is intended to reduce accidental exposure, not contain an agent with arbitrary local execution privileges.

The local maximum-capacity test validates transaction behavior, not production latency or Cloudflare plan quotas. Confirm production performance on the target account before operational use.
