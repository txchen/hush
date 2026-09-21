import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256, Aes256Gcm } from "@hpke/core";
import type { Secret, Vault, Device } from "../../../service/src/vault/model";
export type Envelope = Secret["envelope"];
export type Wrap = NonNullable<Device["wrapped_vek"]>;
const suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
});
export const random = (size: number) => crypto.getRandomValues(new Uint8Array(size));
export const encode = (data: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(data instanceof Uint8Array ? data : data)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
export const decode = (data: string) =>
  Uint8Array.from(atob(data.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
export const aad = (...fields: (string | number)[]) =>
  new TextEncoder().encode(["hush", 1, ...fields].join("\n"));
const raw = (data: Uint8Array): ArrayBuffer => data.slice().buffer;

export function derive(password: string, kdf: Vault["kdf"]): Promise<Uint8Array> {
  if (
    kdf.algorithm !== "Argon2id" ||
    kdf.version !== 19 ||
    kdf.memory_kib !== 65536 ||
    kdf.iterations !== 3 ||
    kdf.parallelism !== 1 ||
    decode(kdf.salt).length !== 16
  )
    throw new Error("Unsupported KDF");
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./kdf.worker.ts", import.meta.url), { type: "module" });
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error("KDF timeout"));
    }, 120_000);
    worker.onmessage = (event: MessageEvent<{ key?: Uint8Array }>) => {
      clearTimeout(timeout);
      worker.terminate();
      if (event.data.key) resolve(event.data.key);
      else reject(new Error("KDF failed"));
    };
    worker.onerror = () => {
      clearTimeout(timeout);
      worker.terminate();
      reject(new Error("KDF failed"));
    };
    worker.postMessage({ password, salt: decode(kdf.salt) });
  });
}
export const newKdf = (): Vault["kdf"] => ({
  algorithm: "Argon2id",
  version: 19,
  memory_kib: 65536,
  iterations: 3,
  parallelism: 1,
  salt: encode(random(16)),
});
export async function seal(
  key: Uint8Array,
  plaintext: Uint8Array,
  additionalData: Uint8Array,
): Promise<Envelope> {
  const nonce = random(12);
  const imported = await crypto.subtle.importKey("raw", raw(key), "AES-GCM", false, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: raw(nonce), additionalData: raw(additionalData), tagLength: 128 },
    imported,
    raw(plaintext),
  );
  return {
    format: 1,
    algorithm: "AES-256-GCM",
    nonce: encode(nonce),
    ciphertext: encode(ciphertext),
  };
}
export async function open(
  key: Uint8Array,
  envelope: Envelope,
  additionalData: Uint8Array,
): Promise<Uint8Array> {
  if (envelope.format !== 1 || envelope.algorithm !== "AES-256-GCM")
    throw new Error("Unsupported envelope");
  const imported = await crypto.subtle.importKey("raw", raw(key), "AES-GCM", false, ["decrypt"]);
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: raw(decode(envelope.nonce)),
        additionalData: raw(additionalData),
        tagLength: 128,
      },
      imported,
      raw(decode(envelope.ciphertext)),
    ),
  );
}
export async function unlock(password: string, vault: Vault): Promise<Uint8Array> {
  const kek = await derive(password, vault.kdf);
  try {
    return await open(kek, vault.master_wrap, aad("master", vault.id, vault.vek_version));
  } finally {
    kek.fill(0);
  }
}
export async function secretText(key: Uint8Array, vaultId: string, secret: Secret) {
  const bytes = await open(
    key,
    secret.envelope,
    aad("secret", vaultId, secret.id, secret.version, secret.vek_version),
  );
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    bytes.fill(0);
  }
}
export async function wrapDevice(
  key: Uint8Array,
  vaultId: string,
  deviceId: string,
  version: number,
  publicKey: string,
): Promise<Wrap> {
  const recipientPublicKey = await suite.kem.deserializePublicKey(raw(decode(publicKey)));
  const sender = await suite.createSenderContext({
    recipientPublicKey,
    info: raw(aad("device-vek")),
  });
  return {
    format: 1,
    algorithm: "HPKE-X25519-HKDF-SHA256-AES-256-GCM",
    enc: encode(sender.enc),
    ciphertext: encode(await sender.seal(raw(key), raw(aad("device", vaultId, deviceId, version)))),
  };
}
export async function unwrapDevice(
  privateKey: CryptoKey,
  vaultId: string,
  deviceId: string,
  version: number,
  wrap: Wrap,
) {
  if (wrap.format !== 1 || wrap.algorithm !== "HPKE-X25519-HKDF-SHA256-AES-256-GCM")
    throw new Error("Unsupported device wrap");
  const recipient = await suite.createRecipientContext({
    recipientKey: privateKey,
    enc: raw(decode(wrap.enc)),
    info: raw(aad("device-vek")),
  });
  return new Uint8Array(
    await recipient.open(
      raw(decode(wrap.ciphertext)),
      raw(aad("device", vaultId, deviceId, version)),
    ),
  );
}
