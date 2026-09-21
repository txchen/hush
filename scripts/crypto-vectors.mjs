// Fixture-only cryptography. These public test keys must never be used in a vault.
import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256, Aes256Gcm } from "@hpke/core";
import { argon2id } from "@noble/hashes/argon2.js";

const suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
});
const utf8 = (value) => new TextEncoder().encode(value);
const encode = (bytes) => Buffer.from(bytes).toString("base64url");
const decode = (value) => Buffer.from(value, "base64url");
const aad = (fields) => utf8(fields.join("\n"));
const fixturePath = new URL("../contracts/fixtures/crypto-v1.json", import.meta.url);
async function aes(key, nonce, additionalData, input, operation) {
  const imported = await crypto.subtle.importKey("raw", key, "AES-GCM", false, [operation]);
  return crypto.subtle[operation](
    { name: "AES-GCM", iv: nonce, additionalData, tagLength: 128 },
    imported,
    input,
  );
}

if (process.argv.includes("--generate")) {
  const vaultId = "11111111-1111-4111-8111-111111111111";
  const secretId = "22222222-2222-4222-8222-222222222222";
  const deviceId = "33333333-3333-4333-8333-333333333333";
  const password = "Public fixture password — never use this";
  const salt = Uint8Array.from({ length: 16 }, (_, i) => i);
  const vek = Uint8Array.from({ length: 32 }, (_, i) => i + 32);
  const kek = argon2id(utf8(password), salt, { m: 65536, t: 3, p: 1, dkLen: 32 });
  const masterAad = aad(["hush", "1", "master", vaultId, "1"]);
  const secretAad = aad(["hush", "1", "secret", vaultId, secretId, "1", "1"]);
  const info = aad(["hush", "1", "device-vek"]);
  const deviceAad = aad(["hush", "1", "device", vaultId, deviceId, "1"]);
  const pair = await suite.kem.deriveKeyPair(new Uint8Array(32).fill(7));
  const sender = await suite.createSenderContext({ recipientPublicKey: pair.publicKey, info });
  const secretNonce = new Uint8Array(12).fill(3);
  const masterNonce = new Uint8Array(12).fill(4);
  const plaintext = "fixture-token-α";
  const output = {
    warning:
      "Public interoperability test data. Never use these keys, password, or nonces in production.",
    format: 1,
    vault_id: vaultId,
    secret_id: secretId,
    device_id: deviceId,
    password,
    kdf: {
      algorithm: "Argon2id",
      version: 19,
      salt: encode(salt),
      memory_kib: 65536,
      iterations: 3,
      parallelism: 1,
    },
    kek: encode(kek),
    vek: encode(vek),
    plaintext,
    master_aad: encode(masterAad),
    secret_aad: encode(secretAad),
    device_aad: encode(deviceAad),
    hpke_info: encode(info),
    master_wrap: {
      format: 1,
      algorithm: "AES-256-GCM",
      nonce: encode(masterNonce),
      ciphertext: encode(await aes(kek, masterNonce, masterAad, vek, "encrypt")),
    },
    secret: {
      format: 1,
      algorithm: "AES-256-GCM",
      nonce: encode(secretNonce),
      ciphertext: encode(await aes(vek, secretNonce, secretAad, utf8(plaintext), "encrypt")),
    },
    device_public_key: encode(await suite.kem.serializePublicKey(pair.publicKey)),
    device_private_key: encode(await suite.kem.serializePrivateKey(pair.privateKey)),
    device_wrap: {
      format: 1,
      algorithm: "HPKE-X25519-HKDF-SHA256-AES-256-GCM",
      enc: encode(sender.enc),
      ciphertext: encode(await sender.seal(vek, deviceAad)),
    },
  };
  writeFileSync(fixturePath, JSON.stringify(output, null, 2) + "\n");
}

const vector = JSON.parse(readFileSync(fixturePath, "utf8"));
const kek = argon2id(utf8(vector.password), decode(vector.kdf.salt), {
  m: vector.kdf.memory_kib,
  t: vector.kdf.iterations,
  p: vector.kdf.parallelism,
  dkLen: 32,
});
assert.equal(encode(kek), vector.kek);
assert.equal(encode(aad(["hush", "1", "master", vector.vault_id, "1"])), vector.master_aad);
assert.equal(
  encode(aad(["hush", "1", "secret", vector.vault_id, vector.secret_id, "1", "1"])),
  vector.secret_aad,
);
assert.equal(
  encode(aad(["hush", "1", "device", vector.vault_id, vector.device_id, "1"])),
  vector.device_aad,
);
const vek = await aes(
  kek,
  decode(vector.master_wrap.nonce),
  decode(vector.master_aad),
  decode(vector.master_wrap.ciphertext),
  "decrypt",
);
assert.equal(encode(vek), vector.vek);
const plaintext = await aes(
  vek,
  decode(vector.secret.nonce),
  decode(vector.secret_aad),
  decode(vector.secret.ciphertext),
  "decrypt",
);
assert.equal(new TextDecoder().decode(plaintext), vector.plaintext);
const privateKey = await suite.kem.deserializePrivateKey(decode(vector.device_private_key));
const recipient = await suite.createRecipientContext({
  recipientKey: privateKey,
  enc: decode(vector.device_wrap.enc),
  info: decode(vector.hpke_info),
});
assert.equal(
  encode(await recipient.open(decode(vector.device_wrap.ciphertext), decode(vector.device_aad))),
  vector.vek,
);
await assert.rejects(() =>
  aes(
    vek,
    decode(vector.secret.nonce),
    aad(["hush", "1", "secret", vector.vault_id, vector.secret_id, "2", "1"]),
    decode(vector.secret.ciphertext),
    "decrypt",
  ),
);
const wrongRecipient = await suite.createRecipientContext({
  recipientKey: privateKey,
  enc: decode(vector.device_wrap.enc),
  info: decode(vector.hpke_info),
});
await assert.rejects(() =>
  wrongRecipient.open(decode(vector.device_wrap.ciphertext), utf8("wrong-device")),
);
console.log("JavaScript crypto vectors verified (Argon2id, AES-GCM, HPKE, AAD rejection).");
