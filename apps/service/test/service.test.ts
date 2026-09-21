import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import app from "../src/index";
import { Repository, event } from "../src/db/repository";
import type { Snapshot } from "../src/vault/model";

const b64 = (n: number, fill = 1) =>
  btoa(String.fromCharCode(...new Uint8Array(n).fill(fill)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const uuid = () => crypto.randomUUID();
const kdf = {
  algorithm: "Argon2id",
  version: 19,
  salt: b64(16),
  memory_kib: 65536,
  iterations: 3,
  parallelism: 1,
};
const master = (fill = 1) => ({
  format: 1,
  algorithm: "AES-256-GCM",
  nonce: b64(12, fill),
  ciphertext: b64(48, fill),
});
const wrapped = (fill = 1) => ({
  format: 1,
  algorithm: "HPKE-X25519-HKDF-SHA256-AES-256-GCM",
  enc: b64(32, fill),
  ciphertext: b64(48, fill),
});
let nonceSequence = 0;
function envelope(size = 32) {
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setUint32(8, ++nonceSequence);
  return {
    format: 1,
    algorithm: "AES-256-GCM",
    nonce: btoa(String.fromCharCode(...nonce))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, ""),
    ciphertext: b64(size),
  };
}
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let ownerToken: string;
let deviceToken: string;
let vaultId: string;

async function token(
  claims: Record<string, unknown> = { email: "owner@example.com", sub: "owner-id" },
  options: { audience?: string; issuer?: string; expires?: number } = {},
) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuedAt()
    .setIssuer(options.issuer ?? "https://hush-test.cloudflareaccess.com")
    .setAudience(options.audience ?? "hush-test-audience")
    .setExpirationTime(options.expires ?? Math.floor(Date.now() / 1000) + 3600)
    .sign(keys.privateKey);
}

function request(
  path: string,
  options: {
    method?: string;
    data?: unknown;
    revision?: number;
    token?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const headers = new Headers({
    "Cf-Access-Jwt-Assertion": options.token ?? ownerToken,
    ...options.headers,
  });
  if (options.revision !== undefined) headers.set("If-Match", `"${options.revision}"`);
  if (options.method && options.method !== "GET") {
    if (!headers.has("Origin")) headers.set("Origin", "https://hush.example.com");
    if (!headers.has("X-Hush-Request")) headers.set("X-Hush-Request", "1");
  }
  if (options.data !== undefined) headers.set("Content-Type", "application/json");
  return app.request(
    `https://hush.example.com/api/v1${path}`,
    {
      method: options.method ?? "GET",
      headers,
      body: options.data === undefined ? undefined : JSON.stringify(options.data),
    },
    env,
  );
}

async function initialize() {
  const response = await request("/vault", {
    method: "PUT",
    revision: 0,
    data: { id: vaultId, name: "Personal", kdf, master_wrap: master() },
  });
  expect(response.status).toBe(200);
}
async function enroll(revision = 1, clientId = "machine.access") {
  const id = uuid();
  const response = await request("/devices", {
    method: "POST",
    revision,
    data: {
      id,
      name: "Laptop",
      type: "cli",
      public_key: b64(32, 2),
      access_client_id: clientId,
      vek_version: 1,
      wrapped_vek: wrapped(),
    },
  });
  expect(response.status).toBe(200);
  return id;
}
async function addSecret(revision: number, name = "TOKEN") {
  const id = uuid();
  const data = { name, version: 1, vek_version: 1, envelope: envelope() };
  expect((await request(`/secrets/${id}`, { method: "PUT", revision, data })).status).toBe(200);
  return { id, ...data };
}

beforeAll(async () => {
  keys = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: "test-key", alg: "RS256" };
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(JSON.stringify({ keys: [jwk] }), {
        headers: { "Content-Type": "application/json" },
      }),
  );
  ownerToken = await token();
  deviceToken = await token({ common_name: "machine.access", sub: "" });
});
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  vaultId = uuid();
});
afterAll(() => vi.restoreAllMocks());

describe("Access identity and browser write boundary", () => {
  it("rejects unsigned headers and malformed JWTs", async () => {
    expect(
      (
        await request("/vault", {
          token: "",
          headers: { "Cf-Access-Authenticated-User-Email": "owner@example.com" },
        })
      ).status,
    ).toBe(401);
    expect((await request("/vault", { token: "not.a.jwt" })).status).toBe(401);
  });
  it("verifies issuer, audience, expiry and signature", async () => {
    for (const options of [
      { audience: "wrong" },
      { issuer: "https://evil.example" },
      { expires: 1 },
    ]) {
      expect((await request("/vault", { token: await token(undefined, options) })).status).toBe(
        401,
      );
    }
    const otherKeys = await generateKeyPair("RS256");
    const forged = await new SignJWT({ email: "owner@example.com", sub: "owner-id" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuedAt()
      .setIssuer("https://hush-test.cloudflareaccess.com")
      .setAudience("hush-test-audience")
      .setExpirationTime("1h")
      .sign(otherKeys.privateKey);
    expect((await request("/vault", { token: forged })).status).toBe(401);
  });
  it("rejects other humans and mixed machine/owner identities", async () => {
    expect(
      (
        await request("/vault", {
          token: await token({ email: "other@example.com", sub: "other" }),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("/vault", {
          token: await token({
            email: "owner@example.com",
            common_name: "machine.access",
            sub: "",
          }),
        })
      ).status,
    ).toBe(403);
  });
  it("requires same-origin browser write headers and an expected revision", async () => {
    const data = { id: vaultId, name: "Personal", kdf, master_wrap: master() };
    expect(
      (
        await request("/vault", {
          method: "PUT",
          data,
          revision: 0,
          headers: { Origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("/vault", {
          method: "PUT",
          data,
          revision: 0,
          headers: { "X-Hush-Request": "" },
        })
      ).status,
    ).toBe(403);
    expect((await request("/vault", { method: "PUT", data })).status).toBe(428);
  });
});

describe("read-only devices", () => {
  it("exposes actual SQLite columns and values only to the owner", async () => {
    await initialize();
    await enroll();
    const secret = await addSecret(2);
    const tables = await request("/database");
    expect(await tables.json()).toMatchObject({
      tables: expect.arrayContaining(["vault", "secrets", "master_nonces"]),
    });
    const response = await request("/database/secrets");
    const result = (await response.json()) as {
      columns: { name: string; hidden: number }[];
      rows: { data: string; name: string }[];
      total: number;
    };
    expect(result.total).toBe(1);
    expect(result.columns).toContainEqual(expect.objectContaining({ name: "name", hidden: 3 }));
    expect(JSON.parse(result.rows[0].data)).toMatchObject({
      id: secret.id,
      envelope: secret.envelope,
    });
    expect(result.rows[0].name).toBe("TOKEN");
    for (const path of [
      "/database",
      "/database/vault",
      "/database/devices",
      "/database/master_nonces",
    ])
      expect((await request(path, { token: deviceToken })).status).toBe(403);
    for (const table of [
      "sqlite_master",
      "sqlite_sequence",
      "secrets%3BDROP%20TABLE%20vault",
      "__proto__",
    ])
      expect((await request(`/database/${table}`)).status).toBe(404);
    expect((await request("/database/secrets?offset=-1")).status).toBe(400);
    expect((await request("/database/secrets?offset=1")).status).toBe(200);
    expect(
      (
        await request("/database/secrets", {
          method: "POST",
          revision: 3,
          data: { sql: "DELETE FROM secrets" },
        })
      ).status,
    ).toBe(404);
    expect((await new Repository(env.DB).snapshot())?.secrets).toHaveLength(1);
  });

  it("binds verified Client ID, returns only its own wrap, and immediately denies revoked devices", async () => {
    await initialize();
    expect((await request("/vault", { token: deviceToken })).status).toBe(403);
    const id = await enroll();
    const own = await request("/devices/self/key", {
      token: deviceToken,
      headers: { "X-Device-Id": uuid() },
    });
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({ device_id: id, wrapped_vek: wrapped() });
    for (const path of [
      "/vault/recovery",
      "/vault/snapshot",
      "/devices",
      `/devices/${id}/key`,
      "/audit",
    ]) {
      expect((await request(path, { token: deviceToken })).status).toBe(403);
    }
    expect((await request(`/devices/${id}/revoke`, { method: "POST", revision: 2 })).status).toBe(
      200,
    );
    for (const path of ["/vault", "/secrets", "/profiles", "/devices/self/key"]) {
      expect((await request(path, { token: deviceToken })).status).toBe(403);
    }
    const recovery = await request("/vault/recovery");
    expect(recovery.status).toBe(200);
    const state = await new Repository(env.DB).snapshot();
    expect(state?.devices[0].wrapped_vek).toBeNull();
  });
  it.each([
    ["PUT", "/vault"],
    ["PUT", "/vault/master-wrap"],
    ["POST", "/vault/rotate"],
    ["POST", "/devices"],
    ["PATCH", "/devices/id"],
    ["POST", "/devices/id/revoke"],
    ["PUT", "/secrets/id"],
    ["DELETE", "/secrets/id"],
    ["PUT", "/profiles/id"],
    ["DELETE", "/profiles/id"],
  ])("blocks device %s %s before parsing input", async (method, path) => {
    await initialize();
    await enroll();
    expect(
      (await request(path, { method, revision: 2, data: {}, token: deviceToken })).status,
    ).toBe(403);
  });
});

describe("encrypted records and profiles", () => {
  it("increments versions for edits and rejects reusing the previous envelope", async () => {
    await initialize();
    const secret = await addSecret(1);
    const data = { name: "RENAMED", version: 2, vek_version: 1, envelope: secret.envelope };
    expect(
      (await request(`/secrets/${secret.id}`, { method: "PUT", revision: 2, data })).status,
    ).toBe(409);
    const fresh = { ...data, envelope: envelope() };
    expect(
      (await request(`/secrets/${secret.id}`, { method: "PUT", revision: 2, data: fresh })).status,
    ).toBe(200);
    const response = await request(`/secrets/${secret.id}`);
    expect(await response.json()).toMatchObject(fresh);
    expect(
      (await request(`/secrets/${secret.id}`, { method: "PUT", revision: 3, data: fresh })).status,
    ).toBe(409);
  });

  it("rejects oversized streamed input without Content-Length and oversized envelopes", async () => {
    await initialize();
    const headers = {
      "Cf-Access-Jwt-Assertion": ownerToken,
      Origin: "https://hush.example.com",
      "X-Hush-Request": "1",
      "If-Match": '"1"',
      "Content-Type": "application/json",
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024 + 1).fill(32));
        controller.close();
      },
    });
    const response = await app.request(
      `https://hush.example.com/api/v1/secrets/${uuid()}`,
      { method: "PUT", headers, body: stream },
      env,
    );
    expect(response.status).toBe(413);
    expect(
      (
        await request(`/secrets/${uuid()}`, {
          method: "PUT",
          revision: 1,
          data: { name: "BIG", version: 1, vek_version: 1, envelope: envelope(12_201) },
        })
      ).status,
    ).toBe(400);
    expect((await new Repository(env.DB).snapshot())?.vault.revision).toBe(1);
  });

  it("rejects malformed JSON, noncanonical binary data and bodies on bodyless operations", async () => {
    await initialize();
    const headers = {
      "Cf-Access-Jwt-Assertion": ownerToken,
      Origin: "https://hush.example.com",
      "X-Hush-Request": "1",
      "If-Match": '"1"',
      "Content-Type": "application/json",
    };
    expect(
      (
        await app.request(
          `https://hush.example.com/api/v1/secrets/${uuid()}`,
          { method: "PUT", headers, body: "{" },
          env,
        )
      ).status,
    ).toBe(400);
    const input = {
      name: "BAD",
      version: 1,
      vek_version: 1,
      envelope: { ...envelope(), ciphertext: b64(32) + "=" },
    };
    expect(
      (await request(`/secrets/${uuid()}`, { method: "PUT", revision: 1, data: input })).status,
    ).toBe(400);
    expect(
      (
        await request(`/secrets/${uuid()}`, {
          method: "DELETE",
          revision: 1,
          data: { plaintext: "bad" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("/devices/missing/revoke", {
          method: "POST",
          revision: 1,
          data: { plaintext: "bad" },
        })
      ).status,
    ).toBe(400);
  });

  it("returns only selected profile ciphertext and protects referenced secrets", async () => {
    await initialize();
    await enroll();
    const first = await addSecret(2, "FIRST");
    await addSecret(3, "SECOND");
    const id = uuid();
    const profile = {
      name: "github",
      mappings: [{ secret_id: first.id, env_name: "GITHUB_TOKEN" }],
    };
    expect(
      (await request(`/profiles/${id}`, { method: "PUT", revision: 4, data: profile })).status,
    ).toBe(200);
    const response = await request(`/profiles/${id}/secrets`, { token: deviceToken });
    expect(response.headers.get("ETag")).toBe('"5"');
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ secrets: [{ id: first.id }] });
    expect((await request(`/secrets/${first.id}`, { method: "DELETE", revision: 5 })).status).toBe(
      409,
    );
    expect((await request(`/profiles/${id}`, { method: "DELETE", revision: 5 })).status).toBe(200);
    expect((await request(`/secrets/${first.id}`, { method: "DELETE", revision: 6 })).status).toBe(
      200,
    );
  });
  it("rejects unknown plaintext fields, unsupported formats, invalid versions and duplicate mappings", async () => {
    await initialize();
    const id = uuid();
    const input = { name: "TOKEN", version: 1, vek_version: 1, envelope: envelope() };
    for (const data of [
      { ...input, value: "plaintext" },
      { ...input, envelope: { ...input.envelope, plaintext: "bad" } },
      { ...input, envelope: { ...input.envelope, algorithm: "unknown" } },
    ]) {
      expect((await request(`/secrets/${id}`, { method: "PUT", revision: 1, data })).status).toBe(
        400,
      );
    }
    expect(
      (
        await request(`/secrets/${id}`, {
          method: "PUT",
          revision: 1,
          data: { ...input, vek_version: 2 },
        })
      ).status,
    ).toBe(409);
    const secret = await addSecret(1);
    for (const mappings of [
      [{ secret_id: uuid(), env_name: "TOKEN" }],
      [
        { secret_id: secret.id, env_name: "TOKEN" },
        { secret_id: secret.id, env_name: "TOKEN" },
      ],
    ]) {
      expect(
        (
          await request(`/profiles/${uuid()}`, {
            method: "PUT",
            revision: 2,
            data: { name: "bad", mappings },
          })
        ).status,
      ).toBe(400);
    }
  });
  it("rejects nonce reuse even after deletion and rolls back its attempted write", async () => {
    await initialize();
    const first = await addSecret(1);
    expect((await request(`/secrets/${first.id}`, { method: "DELETE", revision: 2 })).status).toBe(
      200,
    );
    const response = await request(`/secrets/${uuid()}`, {
      method: "PUT",
      revision: 3,
      data: { name: "REUSED", version: 1, vek_version: 1, envelope: first.envelope },
    });
    expect(response.status).toBe(409);
    const state = await new Repository(env.DB).snapshot();
    expect(state?.vault.revision).toBe(3);
    expect(state?.secrets).toHaveLength(0);
  });
  it("re-wraps the master key without changing secrets or device keys", async () => {
    await initialize();
    await enroll();
    await addSecret(2);
    const repo = new Repository(env.DB);
    const before = await repo.snapshot();
    expect(
      (
        await request("/vault/master-wrap", {
          method: "PUT",
          revision: 3,
          data: { kdf: { ...kdf, salt: b64(16, 5) }, master_wrap: master(5) },
        })
      ).status,
    ).toBe(200);
    const after = await repo.snapshot();
    expect(after?.secrets).toEqual(before?.secrets);
    expect(after?.devices).toEqual(before?.devices);
    expect(after?.vault.vek_version).toBe(1);
  });
});

describe("atomic publication", () => {
  it("rejects master nonce reuse across key versions, not just the latest wrapping", async () => {
    await initialize();
    const input = {
      vek_version: 2,
      kdf,
      master_wrap: master(2),
      revoke_device_ids: [],
      secrets: [],
      device_keys: [],
    };
    expect(
      (await request("/vault/rotate", { method: "POST", revision: 1, data: input })).status,
    ).toBe(200);
    expect(
      (
        await request("/vault/rotate", {
          method: "POST",
          revision: 2,
          data: { ...input, vek_version: 3, master_wrap: master(1) },
        })
      ).status,
    ).toBe(409);
    expect((await new Repository(env.DB).snapshot())?.vault.vek_version).toBe(2);
  });

  it("allows exactly one concurrent initialization", async () => {
    const data = { id: vaultId, name: "Personal", kdf, master_wrap: master() };
    const responses = await Promise.all([
      request("/vault", { method: "PUT", revision: 0, data }),
      request("/vault", { method: "PUT", revision: 0, data }),
    ]);
    expect(responses.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 409]);
  });
  it("allows exactly one writer from a shared snapshot and rolls back the loser audit", async () => {
    await initialize();
    const repository = new Repository(env.DB);
    const before = (await repository.snapshot())!;
    const copies = ["First", "Second"].map((name) => ({
      ...structuredClone(before),
      vault: { ...before.vault, revision: 2, name },
    }));
    const results = await Promise.allSettled(
      copies.map((after) =>
        new Repository(env.DB).commit(
          before,
          after,
          event({ role: "owner", subject: "owner-id" }, "test.mutation"),
        ),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason.code).toBe("revision_conflict");
    expect((await repository.snapshot())?.vault.revision).toBe(2);
    expect((await repository.audit(0)).filter((e) => e.action === "test.mutation")).toHaveLength(1);
  });
  it("rejects incomplete/stale rotations and atomically revokes a device on success", async () => {
    await initialize();
    const revoked = await enroll();
    const remaining = await enroll(2, "remaining.access");
    const secret = await addSecret(3);
    const input = {
      vek_version: 2,
      kdf,
      master_wrap: master(2),
      revoke_device_ids: [revoked],
      secrets: [{ id: secret.id, version: 2, envelope: envelope() }],
      device_keys: [{ id: remaining, wrapped_vek: wrapped(2) }],
    };
    expect(
      (
        await request("/vault/rotate", {
          method: "POST",
          revision: 4,
          data: { ...input, secrets: [] },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("/vault/rotate", {
          method: "POST",
          revision: 4,
          data: { ...input, device_keys: [] },
        })
      ).status,
    ).toBe(400);
    expect(
      (await request("/vault/rotate", { method: "POST", revision: 3, data: input })).status,
    ).toBe(409);
    expect(
      (await request("/vault/rotate", { method: "POST", revision: 4, data: input })).status,
    ).toBe(200);
    const state = (await new Repository(env.DB).snapshot())!;
    expect(state.vault).toMatchObject({ revision: 5, vek_version: 2, master_wrap: master(2) });
    expect(state.secrets[0]).toMatchObject({ version: 2, vek_version: 2 });
    expect(state.devices.find((d) => d.id === revoked)?.wrapped_vek).toBeNull();
    expect(state.devices.find((d) => d.id === remaining)?.wrapped_vek).toEqual(wrapped(2));
    expect((await request("/secrets", { token: deviceToken })).status).toBe(403);
  });
  it("rolls back every change if a rotation contains reused nonces", async () => {
    await initialize();
    const revoked = await enroll();
    await addSecret(2, "A");
    await addSecret(3, "B");
    const repository = new Repository(env.DB);
    const before = (await repository.snapshot())!;
    const duplicate = envelope();
    const input = {
      vek_version: 2,
      kdf,
      master_wrap: master(2),
      revoke_device_ids: [revoked],
      secrets: before.secrets.map((s) => ({ id: s.id, version: 2, envelope: duplicate })),
      device_keys: [],
    };
    expect(
      (await request("/vault/rotate", { method: "POST", revision: 4, data: input })).status,
    ).toBe(409);
    expect(await repository.snapshot()).toEqual(before);
    expect((await repository.audit(0)).some((e) => e.action === "vault.rotated")).toBe(false);
  });
  it("rotates 500 near-limit envelopes and rejects a 501st secret", async () => {
    await initialize();
    const repository = new Repository(env.DB);
    const before = (await repository.snapshot())!;
    const seeded: Snapshot = structuredClone(before);
    seeded.vault.revision = 2;
    seeded.secrets = Array.from({ length: 500 }, (_, i) => ({
      id: uuid(),
      name: `TOKEN_${i}`,
      version: 1,
      vek_version: 1,
      envelope: envelope(12_200) as Snapshot["secrets"][number]["envelope"],
      created_at: before.vault.created_at,
      updated_at: before.vault.updated_at,
    }));
    await repository.commit(
      before,
      seeded,
      event({ role: "owner", subject: "owner-id" }, "test.seed"),
    );
    expect(
      (
        await request(`/secrets/${uuid()}`, {
          method: "PUT",
          revision: 2,
          data: { name: "EXTRA", version: 1, vek_version: 1, envelope: envelope() },
        })
      ).status,
    ).toBe(409);
    const input = {
      vek_version: 2,
      kdf,
      master_wrap: master(2),
      revoke_device_ids: [],
      secrets: seeded.secrets.map((s) => ({ id: s.id, version: 2, envelope: envelope(12_200) })),
      device_keys: [],
    };
    const response = await request("/vault/rotate", { method: "POST", revision: 2, data: input });
    expect(response.status).toBe(200);
    const state = (await repository.snapshot())!;
    expect(state.vault.revision).toBe(3);
    expect(state.secrets).toHaveLength(500);
    expect(state.secrets.every((s) => s.vek_version === 2)).toBe(true);
  });
});

it("keeps audit metadata free of ciphertext, wrapping and plaintext", async () => {
  await initialize();
  await enroll();
  const secret = await addSecret(2);
  await request(`/secrets/${secret.id}`, { token: deviceToken });
  const response = await request("/audit");
  const text = await response.text();
  expect(text).toContain("secret.ciphertext_fetched");
  expect(text).not.toContain(secret.envelope.ciphertext);
  expect(text).not.toContain("master_wrap");
  expect(text).not.toContain("revealed");
  expect((await new Repository(env.DB).snapshot())?.vault.revision).toBe(3);
});
