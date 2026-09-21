# Hush Cryptographic Protocol, Format 1

This contract is shared by the future Vue and Go clients. All secret encryption and decryption runs on clients. The Worker handles opaque envelopes; it never receives the master password, KEK, plaintext VEK, or device private keys.

## Encoding

- Binary values use canonical unpadded base64url (RFC 4648 URL alphabet).
- IDs are lowercase UUID strings. Versions are positive safe JSON integers, written as unpadded decimal ASCII in AAD.
- AAD and HPKE info are UTF-8 strings formed by joining the listed fields with exactly one LF (`0x0a`), with **no trailing LF**. IDs cannot contain LF, making this encoding unambiguous.
- AES-GCM ciphertext includes the 16-byte authentication tag appended to the encrypted bytes. No separate tag field is used.
- Generate keys, salts, nonces, IDs, and HPKE ephemeral keys with a cryptographically secure random generator. Test fixtures are public and must never supply production randomness.

## Secret encryption

Generate a 32-byte random VEK. Encrypt each secret independently with AES-256-GCM, a fresh random 12-byte nonce, and a 16-byte authentication tag.

AAD fields:

```text
hush
1
secret
<vault_id>
<secret_id>
<secret_version>
<vek_version>
```

Envelope:

```json
{
  "format": 1,
  "algorithm": "AES-256-GCM",
  "nonce": "<12 bytes, base64url>",
  "ciphertext": "<ciphertext followed by 16-byte tag, base64url>"
}
```

Every replacement increments the secret version and uses fresh encryption, even if the plaintext is unchanged. Rotation increments both secret version and VEK version. The Worker retains a `(vek_version, nonce)` ledger, including after deletion, and rejects reuse. Clients must never reuse a VEK across distinct key versions.

The maximum ciphertext length is 12,200 bytes, including the tag. The canonical JSON envelope must also fit within 16 KiB. These limits support tokens, environment values, and small certificates rather than encrypted file storage.

## Master-password wrapping

Encode the password as UTF-8 **without trimming or Unicode normalization**. Clients must preserve exactly what the user entered. Derive a 32-byte KEK using Argon2id version 19, a random 16-byte salt, memory cost 65,536 KiB, 3 iterations, and parallelism 1. Format 1 pins these parameters; parameter negotiation requires a later protocol change. This fixes a reproducible 64 MiB client memory budget and avoids silently accepting cheaper KDF settings.

Encrypt the 32-byte VEK using AES-256-GCM with a fresh random 12-byte nonce. The result is exactly 48 ciphertext/tag bytes. Use the same envelope shape as above.

AAD fields:

```text
hush
1
master
<vault_id>
<vek_version>
```

A master-password change generates a new salt and KEK, then wraps the unchanged VEK. It must not change secret ciphertext, device wraps, or VEK version. Rotation wraps the new random VEK; when retaining the KDF salt it must still use a fresh nonce. The service retains used master `(salt, nonce)` pairs to reject known reuse across rotations.

Argon2id makes offline guessing more expensive; it does not compensate for a weak master password. Choose a high-entropy password. Client implementations must benchmark the specified settings on supported browsers and machines before release, and avoid lowering them silently. A Web Worker is appropriate for browser KDF work so the UI stays responsive.

## Device wrapping

Use RFC 9180 HPKE **base mode** with:

| Component | Selection                  | Identifier |
| --------- | -------------------------- | ---------- |
| KEM       | DHKEM(X25519, HKDF-SHA256) | `0x0020`   |
| KDF       | HKDF-SHA256                | `0x0001`   |
| AEAD      | AES-256-GCM                | `0x0002`   |

The recipient public key is 32 raw X25519 bytes. Clients must use a mature HPKE implementation and its public-key validation, including rejection of invalid key-agreement results. Do not construct an ad hoc ECDH wrapping scheme.

Create a **new sender context for each wrap**, seal exactly one message (the 32-byte VEK), then discard the context. Never reuse an HPKE ephemeral key or context between device wraps. Authentication and authorization of the uploaded public key come from the owner workflow, not HPKE base mode.

HPKE info fields:

```text
hush
1
device-vek
```

HPKE AAD fields:

```text
hush
1
device
<vault_id>
<device_id>
<vek_version>
```

Envelope:

```json
{
  "format": 1,
  "algorithm": "HPKE-X25519-HKDF-SHA256-AES-256-GCM",
  "enc": "<32-byte encapsulated key, base64url>",
  "ciphertext": "<48 ciphertext/tag bytes, base64url>"
}
```

HPKE internally derives the nonce; the envelope does not include one. A recipient must create a fresh context for each envelope and call open once with the specified AAD.

## Enrollment, recovery, and rotation

The CLI generates and retains its private key locally and exports only its public key and registration metadata. The Web admin authenticates as owner, obtains the VEK locally, wraps it for that public key, and registers the device and Access Client ID together. The CLI never uploads its private key or performs service mutations.

Browser keys should be non-extractable WebCrypto keys where the selected library supports them, stored in IndexedDB. Non-extractability does not prevent malicious same-origin JavaScript from using a key. Do not persist plaintext VEK/KEK in application stores, localStorage, or caches. A fixture's exportable keys are solely for interoperability verification.

For rotation, the Web client fetches one owner snapshot, unwraps and decrypts locally, creates a new VEK, encrypts every current secret, wraps for all remaining active devices, and submits the complete set with the snapshot's revision. It must validate every local decryption before publishing. On `409`, fetch a new snapshot and rebuild; never omit newly added secrets or devices.

Re-entering the master password for high-risk Web operations is a client responsibility. The service cannot verify knowledge of the password or cryptographic consistency without changing the zero-knowledge protocol.

## Interoperability checks

`fixtures/crypto-v1.json` contains public test inputs and expected outputs, including private test keys. `npm run test:crypto` verifies it using JavaScript WebCrypto, `@hpke/core`, and `@noble/hashes`. `npm run test:crypto:go` independently verifies the same fixture using Go's AES-GCM and HPKE implementations and `golang.org/x/crypto/argon2`. Both reject incorrect AAD.

To deliberately regenerate fixtures, use `node scripts/crypto-vectors.mjs --generate`, then rerun both verifiers. This is not part of normal tests because HPKE encapsulation uses fresh randomness.

References: [HPKE, RFC 9180](https://www.rfc-editor.org/rfc/rfc9180.html), [Argon2, RFC 9106](https://www.rfc-editor.org/rfc/rfc9106.html), [Web Cryptography API](https://www.w3.org/TR/WebCryptoAPI/).
