# Hush — Secret Vault Design Specification

> Implementation update: [Service Implementation Scope](.scratch/service/spec.md) records subsequent agreed decisions and takes precedence where this original design differs. In particular, CLI device access is read-only, and all user-initiated service mutations, including device enrollment and vault recovery setup, belong to the Web admin workflow.

## 1. Overview

`hush` is a lightweight zero-knowledge secret-management system for developer and coding-agent workflows.

Primary goals:

- Secrets should not be placed directly into LLM prompts or normal agent context.
- Secrets should be centrally stored and synchronized through Cloudflare.
- Cloudflare must not possess enough information to decrypt user secrets.
- A user should be able to recover the vault on a new machine using only a master password.
- Trusted devices should not require the master password for normal daily use.
- Individual devices should be independently revocable.
- The CLI should support a simple workflow such as:

```bash
hush exec github -- gh api user
hush exec cloudflare -- wrangler deploy
```

- A hosted Web UI should allow secret management while keeping encryption and decryption client-side.

The design intentionally avoids heavyweight dependencies such as Vault, SOPS, Infisical, local proxies, or a required daemon.

---

## 2. Core Cryptographic Model

The system has three main cryptographic concepts:

1. **Master Password** — remembered by the user and never uploaded.
2. **Vault Encryption Key (VEK)** — a random 256-bit key that encrypts all secrets.
3. **Trusted Device Keypair** — an optional per-device keypair used so trusted devices can unlock the VEK without asking for the master password every time.

Conceptually:

```text
                     VEK
                 /    |     \
                /     |      \
Master Password       |       Trusted Devices
      |                |        A / B / C
   Argon2id            |          |
      |                |          |
     KEK --------------+----------+
                unwrap same VEK
                       |
                       v
                 decrypt secrets
```

Cloudflare stores only ciphertext, metadata, and wrapped copies of the VEK.

Cloudflare never receives:

- the master password;
- the password-derived KEK;
- plaintext VEK;
- trusted-device private keys;
- plaintext secrets.

---

## 3. High-Level Architecture

```text
                         Cloudflare

                +------------------------+
                | Cloudflare Access      |
                |                        |
                | Web login / Service    |
                | Tokens                 |
                +-----------+------------+
                            |
                            v
                +------------------------+
                | Hush Worker API         |
                |                        |
                | auth / ACL             |
                | device management      |
                | encrypted CRUD         |
                | audit metadata         |
                +-----------+------------+
                            |
                            v
                +------------------------+
                | D1                     |
                |                        |
                | encrypted secrets      |
                | protected VEK          |
                | device public keys     |
                | device-wrapped VEKs    |
                | profiles / metadata    |
                +------------------------+

                   NO PLAINTEXT VEK
                   NO PRIVATE KEYS
                   NO PLAINTEXT SECRETS

        +-------------------+   +-------------------+
        | Device A          |   | Device B          |
        | hush CLI / Web     |   | hush CLI / Web     |
        | private key A     |   | private key B     |
        +-------------------+   +-------------------+
```

---

## 4. Algorithms

### 4.1 VEK

Each vault has one random 256-bit symmetric key:

```text
VEK = random 32 bytes
```

Recommended secret-encryption primitive:

- **XChaCha20-Poly1305**, or
- **AES-256-GCM**.

The implementation should use a mature library and must not invent custom cryptographic primitives.

Each secret is encrypted independently:

```text
plaintext secret
      |
      | AEAD encrypt with VEK
      v
nonce + ciphertext + authentication tag
      |
      v
     D1
```

Recommended AEAD AAD:

```text
vault_id || secret_id || secret_version || vek_version
```

This prevents ciphertext from being silently moved between records or versions.

---

### 4.2 Master Password -> KEK

The master password itself is never used directly as an encryption key.

Use **Argon2id** with a random salt to derive a Key Encryption Key (KEK):

```text
Master Password
      +
random salt
      |
      v
   Argon2id
      |
      v
     KEK
```

The salt and Argon2 parameters are public and may be stored in D1.

The KEK is used only to encrypt/decrypt the VEK.

```text
VEK
 |
 | AEAD encrypt with KEK
 v
protected_VEK_master
 |
 v
D1
```

This means changing the master password only requires re-wrapping the VEK; all secret records do not need to be re-encrypted.

---

### 4.3 Trusted Device Keypairs

Every trusted device may generate its own asymmetric keypair.

Recommended primitive:

- **X25519** for key agreement, combined with a standard KDF + AEAD wrapping construction; or
- another well-reviewed public-key wrapping construction provided by a mature library.

Conceptually:

```text
Device A:
  public_A
  private_A

Device B:
  public_B
  private_B
```

Private keys remain on the device.

Public keys are stored in D1.

Each trusted device gets its own encrypted copy of the VEK:

```text
VEK
 |
 +-- wrap for public_A --> wrapped_VEK_A
 |
 +-- wrap for public_B --> wrapped_VEK_B
```

A trusted device therefore unlocks the vault without needing the master password:

```text
wrapped_VEK_A
      |
      | private_A
      v
     VEK
      |
      v
 decrypt secrets
```

The plaintext VEK should normally exist only in process memory while needed.

---

## 5. Initial Vault Creation

`hush init` performs:

1. Ask the user to create a master password.
2. Generate a random Argon2id salt.
3. Derive KEK from the master password.
4. Generate random 256-bit VEK.
5. Encrypt VEK with KEK -> `protected_VEK_master`.
6. Generate the first device keypair.
7. Wrap VEK for the first device -> `wrapped_VEK_device`.
8. Upload to Cloudflare:
   - Argon2id salt and parameters;
   - `protected_VEK_master`;
   - device public key;
   - `wrapped_VEK_device`;
   - metadata.
9. Store the device private key locally in the OS credential store.
10. Discard plaintext KEK and VEK from memory when practical.

The master password is never uploaded or persisted by Hush.

---

## 6. Adding a New Device

The new design does **not require an existing trusted device to approve a new device**.

A new machine can bootstrap directly from the master password.

Example:

```bash
hush login
```

Flow:

1. Authenticate to the Hush API through Cloudflare Access.
2. Download:
   - Argon2id salt and parameters;
   - `protected_VEK_master`.
3. User enters the master password locally.
4. Derive KEK locally with Argon2id.
5. Decrypt `protected_VEK_master` -> VEK.
6. Generate a new device keypair.
7. Store the new device private key locally.
8. Wrap VEK for the new device public key.
9. Upload:
   - device public key;
   - `wrapped_VEK_device`;
   - device metadata.
10. Discard KEK and plaintext VEK when practical.

After this initial login, the machine is a trusted device and normally no longer asks for the master password.

---

## 7. Normal Trusted-Device Unlock

Normal commands should not prompt for the master password.

Example:

```bash
hush exec github -- gh api user
```

Flow:

```text
device private key
       |
       v
wrapped_VEK_device
       |
       v
      VEK
       |
       v
decrypt selected secrets
       |
       v
spawn child process
```

The master password is only needed for bootstrap/recovery or optional high-risk confirmation.

---

## 8. Recovery

The **master password is the root recovery mechanism**.

A separate recovery key is not required in V1.

If every trusted device is lost:

```text
new machine
   |
enter master password
   |
Argon2id -> KEK
   |
unwrap protected_VEK_master
   |
recover VEK
   |
register new trusted device
```

Therefore the vault remains recoverable as long as:

- the Cloudflare account/data remains accessible; and
- the user remembers the master password.

A future optional offline recovery code may be added, but is not required for the core design.

---

## 9. Device Revocation

There are two levels of revocation.

### 9.1 Soft Revoke

```bash
hush device revoke <device-id>
```

The Worker:

- marks the Hush device as revoked;
- stops returning its device-wrapped VEK;
- optionally deletes its wrapped VEK record;
- rejects device-scoped API operations;
- optionally triggers revocation of the corresponding Cloudflare Access Service Token.

This prevents future normal access through the service.

However, a device that previously copied the plaintext VEK may still possess it.

---

### 9.2 Hard Revoke / VEK Rotation

For a lost, stolen, or potentially compromised device:

```bash
hush device revoke <device-id> --rotate
```

A trusted client or the Web UI performs:

1. Recover current `VEK1`.
2. Generate new random `VEK2`.
3. Decrypt all secret records using `VEK1`.
4. Re-encrypt all secrets using `VEK2`.
5. Re-wrap `VEK2` with the master-password-derived KEK -> new `protected_VEK_master`.
6. Re-wrap `VEK2` for every remaining trusted device.
7. Do not create a new wrapped VEK for the revoked device.
8. Increment `vek_version`.
9. Atomically/transactionally publish the new ciphertext and wrapped keys where practical.
10. Revoke the target device's Cloudflare Access credential if applicable.

After rotation, a device holding only `VEK1` cannot decrypt the new vault state.

Important limitation:

> Rotation protects future encrypted vault state. It cannot retract secrets that the compromised device already decrypted or copied.

For especially sensitive credentials, a hard revoke may also be followed by rotating the underlying service credential itself.

---

## 10. Master Password Change

Changing the master password should be cheap.

Flow:

1. Derive old KEK from old master password.
2. Unwrap VEK.
3. Generate a new random salt.
4. Derive new KEK from new master password.
5. Re-encrypt the same VEK under the new KEK.
6. Replace `protected_VEK_master` and KDF metadata.

No secret ciphertext needs to change.

---

## 11. Cloudflare Access

Cloudflare Access protects the service perimeter.

```text
Internet
   |
   v
Cloudflare Access
   |
   v
Hush Worker
```

### 11.1 Hosted Web UI

Use normal Cloudflare Access human authentication, such as Google or another configured identity provider.

### 11.2 CLI / Headless Devices

Each machine should receive its own Cloudflare Access Service Token.

The CLI sends:

```http
CF-Access-Client-Id: ...
CF-Access-Client-Secret: ...
```

Each device should receive a unique Service Token so it can be revoked independently.

The service token should be stored using the operating system credential store.

This creates two independent layers:

```text
Layer 1: Cloudflare Access
         Can this client reach Hush at all?

Layer 2: Hush cryptographic identity
         Can this device unwrap the VEK?
```

---

## 12. CLI Design

Suggested V1 interface:

```bash
hush init
hush login
hush logout

hush secret add GITHUB_TOKEN
hush secret edit GITHUB_TOKEN
hush secret rm GITHUB_TOKEN
hush secret list

hush show GITHUB_TOKEN
hush copy GITHUB_TOKEN

hush profile create github
hush profile add github GITHUB_TOKEN
hush profile list

hush exec github -- gh api user
hush exec cloudflare -- wrangler deploy

hush device list
hush device rename <device-id> <name>
hush device revoke <device-id>
hush device revoke <device-id> --rotate

hush password change

hush ui
```

### 12.1 Human-only secret access

For human convenience, Hush may provide:

```bash
hush show GITHUB_TOKEN
hush copy GITHUB_TOKEN
```

These commands are **interactive-only** and are not programmatic secret APIs.

`hush show` should:

- require an interactive TTY on both stdin and stdout;
- refuse to run when output is piped, redirected, or used from a non-interactive agent/CI process;
- optionally require local user verification for sensitive configurations;
- display the plaintext only temporarily where practical;
- never support machine-readable modes such as `--raw`, `--json`, or equivalent.

`hush copy` should:

- also require an interactive session;
- copy the plaintext directly to the OS clipboard without printing it;
- optionally clear the clipboard after a short timeout.

There should intentionally be **no script-friendly plaintext retrieval command** such as:

```bash
hush get GITHUB_TOKEN
```

or any equivalent API that writes a secret directly to stdout. This prevents coding agents from trivially requesting a secret and having it enter LLM context. Programmatic use should go through `hush exec`.

This is a usability guardrail, not a hard security boundary: an execution environment with arbitrary local control may still attempt to exfiltrate secrets through `hush exec`.

---

## 13. `hush exec`

The primary coding-agent workflow is:

```bash
hush exec <profile> -- <command> [args...]
```

Example profiles:

```text
github:
  GITHUB_TOKEN

cloudflare:
  CLOUDFLARE_API_TOKEN
  CLOUDFLARE_ACCOUNT_ID
```

Execution flow:

```text
hush exec github -- gh api user
        |
        v
fetch encrypted profile secrets
        |
        v
unwrap VEK using trusted device key
        |
        v
decrypt required secrets only
        |
        v
spawn child process with selected env vars
        |
        v
wait for child
        |
        v
discard plaintext buffers / VEK
```

Only secrets assigned to the selected profile should be injected.

Do not inject every vault secret globally.

### Security limitation

A coding agent with arbitrary shell control can deliberately execute:

```bash
hush exec github -- env
```

or otherwise print the injected secret.

Therefore `hush exec` is designed primarily to prevent **normal or accidental exposure to LLM context**, not to provide strong isolation from a malicious execution environment.

A future broker/proxy mode would be required for that stronger security property.

---

## 14. Local Device Private-Key Storage

Trusted-device private keys should not normally be stored as plaintext files.

Preferred storage:

- macOS: Keychain;
- Windows: Credential Manager / DPAPI-backed storage;
- Linux: Secret Service / system keyring where available.

The implementation should hide this behind a small credential-store abstraction.

The VEK itself should not normally be persisted to disk.

---

## 15. Hosted Web UI

The browser can also act as a trusted device.

### First Login on a Browser

1. Authenticate through Cloudflare Access.
2. Download master KDF metadata and `protected_VEK_master`.
3. Prompt for the master password locally.
4. Derive KEK in the browser.
5. Recover VEK locally.
6. Generate a browser device keypair.
7. Store the browser private key locally.
8. Wrap VEK for the browser device.
9. Upload the browser public key and wrapped VEK.
10. Discard the master-password-derived KEK.

After this, the browser is trusted and normally opens the vault without asking for the master password again.

---

## 16. Browser Key Storage

Use WebCrypto when practical.

Prefer a non-extractable private `CryptoKey`:

```text
extractable = false
```

Store the key/reference in IndexedDB.

Do not store raw device private-key material in:

```text
localStorage
sessionStorage
cookies
```

Important limitation:

A malicious same-origin script may still be able to use a non-extractable key for cryptographic operations. `extractable: false` prevents direct export, but does not protect against malicious JavaScript running in the trusted origin.

---

## 17. Web UI Secret Operations

### Add/Edit Secret

```text
user enters plaintext
      |
      v
browser unwraps VEK locally
      |
      v
browser encrypts secret locally
      |
      v
POST ciphertext + nonce + metadata
      |
      v
Worker -> D1
```

Cloudflare never receives the plaintext secret.

### Read Secret

```text
D1 ciphertext
      |
      v
Worker
      |
      v
browser
      |
      v
local VEK decrypt
```

Secrets should be masked by default.

Suggested actions:

- Reveal
- Copy
- Edit
- Delete

Revealed values should automatically hide again after a short timeout.

---

## 18. Web UI Device Management

The hosted Web UI can manage devices.

Example page:

```text
Devices

MacBook Pro CLI       Active
Chrome / MacBook      Active
Linux Server          Active
Old Laptop            Revoked
```

Actions:

- rename;
- soft revoke;
- hard revoke + rotate;
- show last-seen metadata.

### Hard Revoke from the Web UI

A trusted browser already has access to the current VEK and can technically perform rotation.

For defense in depth, the UI should preferably require **re-entering the master password** before destructive/high-risk operations such as:

- hard revoke + VEK rotation;
- changing master password;
- resetting all devices;
- other future root-security operations.

All cryptographic work still occurs locally in the browser.

The master password is never sent to Cloudflare.

---

## 19. Hosted Web UI Trust Limitation

The hosted Web UI has an important limitation that the native CLI does not.

Cloudflare does not possess the VEK, but it does host/deliver the JavaScript that performs local decryption.

A malicious or compromised frontend deployment could theoretically serve JavaScript that:

1. uses the browser device key;
2. unwraps the VEK;
3. decrypts secrets;
4. exfiltrates them.

Therefore:

> The backend is zero-knowledge with respect to stored data, but the hosted frontend delivery path remains part of the trust boundary.

This must be documented clearly.

---

## 20. Local Web UI

For higher-trust administration, support:

```bash
hush ui
```

Example:

```text
http://127.0.0.1:8472
```

Architecture:

```text
Browser
   |
   v
localhost hush process
   |
   | crypto + local device key
   v
Cloudflare Worker
```

This avoids relying on remotely delivered JavaScript for sensitive cryptographic operations.

It is especially suitable for:

- hard revoke / VEK rotation;
- master-password change;
- device administration;
- future recovery/security operations.

---

## 21. Suggested Web UI Pages

V1 needs only a few pages.

### Secrets

```text
GitHub
  GITHUB_TOKEN            ************

Cloudflare
  CLOUDFLARE_API_TOKEN    ************
```

Actions:

- Add
- Edit
- Delete
- Reveal
- Copy

### Profiles

```text
github
  GITHUB_TOKEN

cloudflare
  CLOUDFLARE_API_TOKEN
  CLOUDFLARE_ACCOUNT_ID
```

### Devices

- Active devices
- Revoked devices
- Rename
- Revoke
- Revoke + Rotate

### Settings

- Change master password
- Argon2id parameters
- Vault/VEK version
- Security information
- Audit metadata

---

## 22. Suggested D1 Schema

Exact schema can be refined during implementation.

```sql
CREATE TABLE vaults (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    vek_version INTEGER NOT NULL,

    kdf_type TEXT NOT NULL,
    kdf_salt BLOB NOT NULL,
    kdf_params TEXT NOT NULL,

    protected_vek_master BLOB NOT NULL,
    protected_vek_master_nonce BLOB NOT NULL,

    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    public_key BLOB NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER
);

CREATE TABLE device_vault_keys (
    device_id TEXT NOT NULL,
    vault_id TEXT NOT NULL,
    vek_version INTEGER NOT NULL,
    wrapped_vek BLOB NOT NULL,
    PRIMARY KEY (device_id, vault_id, vek_version)
);

CREATE TABLE secrets (
    id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL,
    name TEXT NOT NULL,
    ciphertext BLOB NOT NULL,
    nonce BLOB NOT NULL,
    vek_version INTEGER NOT NULL,
    version INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(vault_id, name)
);

CREATE TABLE profiles (
    id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL,
    name TEXT NOT NULL,
    UNIQUE(vault_id, name)
);

CREATE TABLE profile_secrets (
    profile_id TEXT NOT NULL,
    secret_id TEXT NOT NULL,
    env_name TEXT NOT NULL,
    PRIMARY KEY (profile_id, secret_id)
);

CREATE TABLE audit_log (
    id TEXT PRIMARY KEY,
    vault_id TEXT NOT NULL,
    device_id TEXT,
    action TEXT NOT NULL,
    resource_type TEXT,
    resource_id TEXT,
    created_at INTEGER NOT NULL
);
```

The implementation may choose to pack nonce + ciphertext + algorithm/version metadata into a versioned binary envelope rather than separate DB columns.

---

## 23. Worker Responsibilities

The Worker should handle:

- Cloudflare Access identity verification;
- Hush device authorization;
- encrypted secret CRUD;
- profile management;
- device registration and revocation state;
- protected master-wrapped VEK storage;
- device-wrapped VEK storage;
- VEK version metadata;
- optimistic concurrency/version checks;
- audit metadata.

The Worker must **not**:

- receive the master password;
- derive or receive the master-password KEK;
- possess plaintext VEK;
- possess device private keys;
- decrypt secrets;
- accept plaintext secret values.

---

## 24. Audit Log Limitations

Because decryption happens locally, the server cannot reliably know when a plaintext secret is actually viewed.

The Worker can log events such as:

```text
encrypted secret fetched
secret ciphertext updated
secret deleted
device registered
device revoked
VEK version rotated
master-wrapped VEK replaced
profile changed
```

It should not claim to know that a secret was actually revealed if that occurred entirely client-side.

---

## 25. Security Boundaries

### Strongly Protected Against

- Cloudflare employees/backend reading plaintext secrets from stored data;
- D1/database dumps;
- Cloudflare compromise that exposes only persisted backend state;
- accidental secret inclusion in normal prompts;
- unauthorized public callers blocked by Cloudflare Access;
- ordinary use of a revoked device after its API credentials/access are removed;
- permanent vault loss caused merely by losing all trusted devices, as long as the master password is remembered.

### Not Fully Protected Against

- weak master passwords and offline password guessing after a full database dump;
- a compromised authorized device;
- root/admin malware reading process memory;
- an agent deliberately using `hush exec` to print injected environment variables;
- malicious hosted frontend JavaScript;
- a device that already copied VEK before revocation;
- secrets already decrypted/exfiltrated before a hard revoke.

### Important Master Password Requirement

Because an attacker with a D1 dump can attempt offline guesses against `protected_VEK_master`, the master password must have high entropy and Argon2id parameters must be deliberately chosen to make guessing expensive while remaining usable on supported devices.

---

## 26. Recommended Implementation Direction

### CLI

Recommended language: **Go**.

Reasons:

- easy static binaries;
- good cross-platform support;
- straightforward process execution;
- good OS credential-store integration options;
- mature cryptographic libraries;
- simple deployment for coding agents.

### Backend

- Cloudflare Worker
- D1
- Cloudflare Access

### Web UI

Any modern static frontend is acceptable.

All secret cryptography must happen in the browser or local `hush` process, never in Worker code.

---

## 27. V1 Scope

### Required

- single user / single vault;
- master-password bootstrap;
- Argon2id KEK derivation;
- random VEK;
- master-wrapped VEK;
- trusted-device keypairs;
- device-wrapped VEK;
- Cloudflare Access;
- Worker + D1 backend;
- secret CRUD;
- profiles;
- `hush exec`;
- device registration;
- device revoke;
- hard revoke + VEK rotation;
- master-password change;
- hosted Web UI.

### Strongly Desirable

- `hush ui` local administrative Web UI;
- per-device Cloudflare Access Service Token;
- output redaction where practical;
- transactional/version-safe VEK rotation.

### Defer

- organizations / multi-user sharing;
- per-secret ACLs;
- automatic remote credential rotation;
- broker/proxy mode;
- SSH-agent integration;
- Kubernetes integrations;
- hardware security keys/passkeys;
- advanced audit reporting;
- offline recovery code.

---

## 28. Core Design Summary

```text
Master Password
    |
 Argon2id
    |
   KEK
    |
    +------ unwrap protected_VEK_master ------+
                                               |
Trusted Device Private Key                     |
    |                                          |
    +------ unwrap wrapped_VEK_device ---------+
                                               |
                                              VEK
                                               |
                                  encrypt/decrypt all secrets
```

The important properties are:

1. **The master password is the root recovery credential and exists only in the user's head/input session.**
2. **The VEK is random and encrypts the actual vault contents.**
3. **Trusted devices get their own wrapped VEK so normal use requires no master-password prompt.**
4. **A new device can bootstrap independently using the master password; no old device must remain online.**
5. **Cloudflare stores only ciphertext and public metadata and cannot decrypt the vault from persisted backend data alone.**
6. **Soft revoke removes service access; hard revoke rotates the VEK to invalidate any old VEK a lost device may have retained.**
7. **Cloudflare Access protects the API perimeter, while client-side cryptography protects the data itself.**
8. **`hush exec` minimizes accidental LLM exposure but is not a security boundary against a malicious local execution environment.**
