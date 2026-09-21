# Service Implementation Scope

Status: Service implementation complete; local validation passed. Production deployment and client applications remain follow-up work.

The baseline product specification is [Hush Secret Vault Design](../../hush-secret-vault-design.md). This document records implementation decisions agreed during the service design interview.

Where this document differs from the baseline, these later decisions take precedence, especially the read-only CLI and Web-admin-only mutation workflow.

## Confirmed scope

- Implement the Cloudflare Worker and D1 service before the Go CLI and hosted Web UI.
- Include Access identity verification, vault initialization, device enrollment and revocation, encrypted secret CRUD, profiles, master-wrapped VEK replacement, VEK rotation, optimistic concurrency, audit metadata, and local integration tests.
- Support one owner and one vault, typically containing tens to hundreds of secrets rather than thousands.
- Provision each machine's Access Service Token manually.
- Separate owner administration from lower-privilege device sessions; see [ADR-0001](../../docs/adr/0001-separate-owner-and-device-authority.md).
- Keep repository content in English.
- Revoking a browser device removes its Hush device trust, not the owner's Access identity. An owner who can authenticate again and supply the master password can enroll a new device. Blocking owner authentication is managed through Access and the identity provider.
- Secret names, profile names, environment variable mappings, and device metadata may be stored in plaintext. Secret values and the VEK remain client-encrypted.
- Limit the vault to 500 secrets, each with an encrypted envelope of at most 16 KiB, and rotation requests to 10 MiB. Validate the storage and transaction implementation against these product limits.
- Identify the owner using a deployment-configured email matched against a verified human Access identity.
- Make CLI device sessions read-only. Secret/profile changes, initialization, recovery enrollment, device management, password changes, and VEK rotation belong to the Web admin workflow.
- CLI enrollment begins with local key generation and export of public enrollment information. The Web admin registers the device and uploads its wrapped VEK. Private keys never leave the CLI device.
- Use a vault revision for optimistic concurrency. Every vault-content, device, or key-wrapping mutation checks the expected revision and advances it atomically; stale writes return HTTP 409. Audit and last-seen updates do not advance the revision.
- Publish rotation atomically against the expected vault revision, replacing every current secret ciphertext and the master/device key wraps for the remaining active devices. Reject incomplete or stale submissions.
- Cryptographic protocol details are delegated to the implementer. Document a versioned interoperable format and validate it with cross-language test vectors; do not implement secret decryption in the Worker.

## Repository layout

- `apps/service/`: TypeScript Worker, D1 migrations, runtime configuration, and service tests.
- `apps/cli/`: future independent Go module; create when CLI implementation begins.
- `apps/web/`: future hosted Web admin; create when UI implementation begins.
- `contracts/`: API contract, cryptographic wire-format documentation, and interoperability fixtures.
- `docs/adr/`: consequential architecture decisions.
- `CONTEXT.md`: shared domain glossary.

## Frontend and tooling direction

- Use Vue for the future Web admin, replacing the earlier React proposal.
- Follow Vue's official TypeScript guidance: Vue 3 single-file components, Composition API, `<script setup lang="ts">`, strict TypeScript, and explicit `vue-tsc` validation.
- Workspace tooling: npm workspaces with one root `package-lock.json`, and a project-local Vite+ dependency. pnpm is not required. Keep the Go module independent.
- Configure npm explicitly as the package manager; Vite+ otherwise defaults to pnpm when it cannot detect one.
- Keep Wrangler responsible for Worker development and deployment. Verify Vite+/Vitest compatibility with Cloudflare's Workers test integration before selecting exact versions.
- Sources: https://vuejs.org/guide/typescript/overview, https://vuejs.org/guide/quick-start, https://www.viteplus.dev/guide/local-cli, https://www.viteplus.dev/guide/install, https://docs.npmjs.com/cli/v11/using-npm/workspaces/.

## Implementation validation

- Verify Access signatures, issuer, audience, expiry, owner identity, and service-token/device bindings.
- Test that device sessions cannot call mutation endpoints or obtain master/other-device wrapped keys.
- Test enrollment, revocation, encrypted CRUD, profile mappings, capacity limits, and rejection of unknown/plaintext-value fields.
- Test concurrent writes, incomplete rotations, transaction rollback, and successful rotation at supported capacity.
- Check that logs and audit events contain metadata only, and that audit events do not claim client-side decryption occurred.
- Deliver service code and local validation first. Hosted Web UI, Go CLI implementation, and production deployment are separate follow-up work.

## Delivered

- Hono/TypeScript Worker with verified Access identity, owner-only writes, read-only device sessions, encrypted CRUD, profiles, device enrollment/rename/revoke, master wrapping replacement, atomic rotation, and metadata audit.
- D1 migrations and revision-guarded transactional publication, including persistent secret/master nonce ledgers.
- Generated OpenAPI contract, fixed format-1 cryptographic protocol, and independent JavaScript/Go interoperability verification.
- 29 Workers integration tests, including concurrent initialization/writes, revoked-device denial, unknown/plaintext-field rejection, streamed body limits, complete transaction rollback, and 500 near-limit secret envelopes in one rotation.
- Passing type checks, Vite+ format/lint checks, API-contract freshness check, JavaScript and Go crypto verification, local Wrangler migration, and Worker dry-run build.
- Setup and deployment instructions in the root README. Remote resources have not been created or deployed; the checked-in Access configuration fails closed until configured.
