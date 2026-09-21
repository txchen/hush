import { describe, expect, it } from "vitest";
import vector from "../../../contracts/fixtures/crypto-v1.json";
import { aad, decode, encode, open, seal, unwrapDevice } from "../src/lib/crypto";
import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256, Aes256Gcm } from "@hpke/core";
import type { Envelope, Wrap } from "../src/lib/crypto";

describe("browser cryptographic protocol", () => {
  it("decrypts the shared Go/JavaScript vector and rejects changed AAD", async () => {
    const key = decode(vector.vek);
    const context = aad("secret", vector.vault_id, vector.secret_id, 1, 1);
    expect(encode(context)).toBe(vector.secret_aad);
    const plain = await open(key, vector.secret as Envelope, context);
    expect(new TextDecoder().decode(plain)).toBe(vector.plaintext);
    await expect(
      open(key, vector.secret as Envelope, aad("secret", vector.vault_id, vector.secret_id, 2, 1)),
    ).rejects.toThrow();
  });
  it("produces fresh nonces and round-trips multiline values", async () => {
    const bytes = new TextEncoder().encode("first\nsecond\nα");
    const first = await seal(decode(vector.vek), bytes, aad("test"));
    const second = await seal(decode(vector.vek), bytes, aad("test"));
    expect(first.nonce).not.toBe(second.nonce);
    expect(await open(decode(vector.vek), first, aad("test"))).toEqual(bytes);
  });
  it("opens HPKE test envelopes using the browser adapter", async () => {
    const suite = new CipherSuite({
      kem: new DhkemX25519HkdfSha256(),
      kdf: new HkdfSha256(),
      aead: new Aes256Gcm(),
    });
    const privateKey = await suite.kem.deserializePrivateKey(decode(vector.device_private_key));
    expect(
      encode(
        await unwrapDevice(
          privateKey,
          vector.vault_id,
          vector.device_id,
          1,
          vector.device_wrap as Wrap,
        ),
      ),
    ).toBe(vector.vek);
  });
});
