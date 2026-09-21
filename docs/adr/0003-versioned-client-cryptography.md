# Fix a cross-language cryptographic envelope

Format 1 uses Argon2id to derive the KEK, AES-256-GCM for secret values and master wrapping, and RFC 9180 HPKE with X25519/HKDF-SHA256/AES-256-GCM for device wrapping. Fixed algorithms and unambiguous, purpose-separated AAD avoid divergent Vue and Go implementations and custom public-key wrapping constructions.

The Worker validates the envelope and rejects known nonce reuse but performs no vault cryptography. JavaScript and Go independently verify public interoperability fixtures. Supporting additional algorithms or changing the fixed KDF parameters requires an explicit protocol version change; see [the protocol](../../contracts/crypto.md).
