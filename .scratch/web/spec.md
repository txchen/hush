# Web Admin Implementation Scope

Status: Implemented; local validation complete. Deployment deferred.

## Confirmed decisions

- Build the Web admin with Vue 3, TypeScript, Composition API, single-file components, and Vite+ in the existing npm workspace.
- Implement initialization, unlock, encrypted secret CRUD, profile management, device enrollment and revocation, master-password change, VEK rotation, and a simple audit list.
- Offer `Trust this browser` during initial unlock, unchecked by default. Untrusted sessions retain vault keys only in memory; trusted browsers retain a local device private key for subsequent unlocks.
- Require master-password re-entry for password changes and VEK rotation.
- Lock after 15 minutes of inactivity and provide a manual Lock action. Clear session key references and plaintext on lock; JavaScript cannot guarantee physical memory erasure.
- Hide revealed secrets immediately on navigation or when the document becomes hidden. A trusted browser can unlock using its retained device key; locking is not equivalent to fresh human authentication.
- Use compact navigation, tables, and editing panels with restrained spacing. Avoid oversized empty areas, decorative copy, and redundant explanations.
- Keep all interface text and repository content in English. Support system light/dark preferences.
- Use a warm paper, graphite, and restrained terracotta palette; the initial green-gray palette was rejected as too generic. The dark theme uses warm charcoal tones.
- Mask secret values by default and provide explicit Reveal and Copy actions.
- Add a SQL table viewer that exposes what is actually persisted in D1/SQLite.
- Do not deploy or provision production resources during this work.

## Confirmed database viewer

- Add a `Database` navigation entry restricted to the verified owner.
- Provide read-only access to the eight Hush application tables: `vault`, `secrets`, `profiles`, `devices`, `device_activity`, `audit_log`, `secret_nonces`, and `master_nonces`.
- Show actual column names, types, stored values, and paginated rows. Expand JSON fields for inspection and provide an exact raw-value view/copy action.
- Display ciphertext and wrapped keys as stored, without decrypting or replacing them with presentation-layer values.
- Implement fixed, bounded server-side queries against an allowlist of application tables. No arbitrary SQL execution or direct row editing in this version.
- Deny all viewer endpoints to CLI device sessions, since database rows include master and other-device wrapped keys.

## Validation

- Seven browser tests passed, covering initialization, browser trust, encrypted edits, conflicts, profiles, raw database inspection, rotation, password changes, session locking, and responsive layouts.
- Type checking, formatting, and lint checks passed.
- Removed the fixed encryption badge, revision display, footer, and redundant page descriptions after UI review.
