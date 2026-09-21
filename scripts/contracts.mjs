import { readFileSync, writeFileSync } from "node:fs";
import { stringify } from "yaml";
import { z } from "zod";
import * as model from "../apps/service/src/vault/model.ts";

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const object = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const array = (items) => ({ type: "array", items });
const integer = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER - 1 };
const text = { type: "string" };
const timestamp = { type: "string", format: "date-time" };
const schemas = {};
for (const [name, schema] of Object.entries({
  Init: model.initSchema,
  SecretInput: model.secretInputSchema,
  DeviceInput: model.deviceInputSchema,
  ProfileInput: model.profileInputSchema,
  PasswordChange: model.passwordSchema,
  Rename: model.renameSchema,
  Rotation: model.rotationSchema,
})) {
  const { $schema: _schema, ...json } = z.toJSONSchema(schema);
  schemas[name] = json;
}
const entity = (input) =>
  object({
    ...schemas[input].properties,
    id: { type: "string", format: "uuid" },
    created_at: timestamp,
    updated_at: timestamp,
  });
schemas.Secret = entity("SecretInput");
schemas.Profile = entity("ProfileInput");
schemas.Device = entity("DeviceInput");
schemas.Device.properties.status = { enum: ["active", "revoked"] };
schemas.Device.properties.wrapped_vek = {
  anyOf: [schemas.Device.properties.wrapped_vek, { type: "null" }],
};
schemas.Device.required.push("status");
schemas.Vault = object({
  ...schemas.Init.properties,
  revision: integer,
  vek_version: integer,
  created_at: timestamp,
  updated_at: timestamp,
});
schemas.VaultMetadata = object(
  Object.fromEntries(
    Object.entries(schemas.Vault.properties).filter(
      ([key]) => !["kdf", "master_wrap"].includes(key),
    ),
  ),
);
schemas.SecretMetadata = object(
  Object.fromEntries(
    Object.entries(schemas.Secret.properties).filter(([key]) => key !== "envelope"),
  ),
);
schemas.DeviceMetadata = object({
  ...Object.fromEntries(
    Object.entries(schemas.Device.properties).filter(([key]) => key !== "wrapped_vek"),
  ),
  last_seen_at: { anyOf: [timestamp, { type: "null" }] },
});
schemas.Revision = object({ revision: integer });
schemas.Snapshot = object({
  vault: ref("Vault"),
  secrets: array(ref("Secret")),
  devices: array(ref("Device")),
  profiles: array(ref("Profile")),
});
schemas.Recovery = object({
  vault_id: text,
  revision: integer,
  vek_version: integer,
  kdf: schemas.Init.properties.kdf,
  master_wrap: schemas.Init.properties.master_wrap,
});
schemas.DeviceKey = object({
  device_id: text,
  vault_id: text,
  vek_version: integer,
  wrapped_vek: schemas.DeviceInput.properties.wrapped_vek,
});
schemas.AuditEvent = object({
  sequence: integer,
  actor_role: { enum: ["owner", "device"] },
  actor_id: text,
  action: text,
  resource_id: { type: ["string", "null"] },
  created_at: timestamp,
});
schemas.Error = object({ error: object({ code: text, request_id: text }) });

const ownerSecurity = [{ AccessSession: [] }];
const allSecurity = [...ownerSecurity, { AccessClientId: [], AccessClientSecret: [] }];
const paths = {};
function route(path, method, operationId, summary, response, input, owner = method !== "get") {
  const parameters = [];
  if (path.includes("{id}"))
    parameters.push({
      name: "id",
      in: "path",
      required: true,
      schema: { type: "string", format: "uuid" },
    });
  if (method !== "get")
    parameters.push(
      {
        name: "If-Match",
        in: "header",
        required: true,
        description: 'Quoted vault revision, e.g. "3". Initialization requires "0".',
        schema: { type: "string", pattern: '^"(0|[1-9][0-9]*)"$' },
      },
      {
        name: "Origin",
        in: "header",
        required: true,
        description: "Must equal configured ADMIN_ORIGIN.",
        schema: text,
      },
      { name: "X-Hush-Request", in: "header", required: true, schema: { const: "1" } },
    );
  if (path === "/audit")
    parameters.push({
      name: "after",
      in: "query",
      schema: { type: "integer", minimum: 0, default: 0 },
    });
  const responses = {
    200: {
      description: "Success. Never contains plaintext secrets or private keys.",
      headers: {
        ETag: { description: "Quoted vault revision when a vault exists.", schema: text },
        "Cache-Control": { schema: { const: "no-store" } },
      },
      content: { "application/json": { schema: response } },
    },
  };
  for (const [code, description] of Object.entries({
    400: "Invalid input",
    401: "Missing or invalid Access JWT",
    403: "Unauthorized identity, revoked device, or invalid admin origin",
    404: "Resource not found",
    409: "Revision, uniqueness, nonce reuse, or capacity conflict",
    413: "Request too large",
    415: "JSON required",
    428: "If-Match required",
    500: "Internal error",
    503: "Access not configured",
  })) {
    responses[code] = { description, content: { "application/json": { schema: ref("Error") } } };
  }
  const operation = {
    operationId,
    summary,
    security: owner ? ownerSecurity : allSecurity,
    parameters,
    responses,
  };
  if (input)
    operation.requestBody = {
      required: true,
      content: { "application/json": { schema: ref(input) } },
    };
  (paths[path] ??= {})[method] = operation;
}
route("/vault", "get", "getVault", "Read public vault metadata", ref("VaultMetadata"));
route("/vault", "put", "initializeVault", "Initialize the single vault", ref("Revision"), "Init");
route(
  "/vault/recovery",
  "get",
  "getRecovery",
  "Read master wrapping for owner recovery",
  ref("Recovery"),
  undefined,
  true,
);
route(
  "/vault/snapshot",
  "get",
  "getSnapshot",
  "Read a consistent owner snapshot for rotation",
  ref("Snapshot"),
  undefined,
  true,
);
route(
  "/vault/master-wrap",
  "put",
  "changeMasterWrap",
  "Replace master wrapping with a fresh KDF salt",
  ref("Revision"),
  "PasswordChange",
);
route(
  "/vault/rotate",
  "post",
  "rotateVault",
  "Atomically rotate every secret and remaining device key",
  ref("Revision"),
  "Rotation",
);
route(
  "/secrets",
  "get",
  "listSecrets",
  "List secret metadata without ciphertext",
  object({ secrets: array(ref("SecretMetadata")) }),
);
route("/secrets/{id}", "get", "getSecret", "Fetch secret ciphertext", ref("Secret"));
route(
  "/secrets/{id}",
  "put",
  "putSecret",
  "Create or replace encrypted secret; client supplies next secret version",
  ref("Revision"),
  "SecretInput",
);
route(
  "/secrets/{id}",
  "delete",
  "deleteSecret",
  "Delete a secret not referenced by a profile",
  ref("Revision"),
);
route(
  "/profiles",
  "get",
  "listProfiles",
  "List profiles and environment mappings",
  object({ profiles: array(ref("Profile")) }),
);
route("/profiles/{id}", "get", "getProfile", "Read one profile", ref("Profile"));
route(
  "/profiles/{id}",
  "put",
  "putProfile",
  "Create or replace profile mappings",
  ref("Revision"),
  "ProfileInput",
);
route("/profiles/{id}", "delete", "deleteProfile", "Delete a profile", ref("Revision"));
route(
  "/profiles/{id}/secrets",
  "get",
  "getProfileSecrets",
  "Fetch only ciphertext selected by a profile",
  object({ profile: ref("Profile"), secrets: array(ref("Secret")) }),
);
route(
  "/devices",
  "get",
  "listDevices",
  "List device metadata and last ciphertext/key fetch time",
  object({ devices: array(ref("DeviceMetadata")) }),
  undefined,
  true,
);
route(
  "/devices",
  "post",
  "enrollDevice",
  "Enroll a client public key and wrapped VEK",
  ref("Revision"),
  "DeviceInput",
);
route(
  "/devices/self/key",
  "get",
  "getOwnDeviceKey",
  "Read wrapped VEK for the authenticated CLI device",
  ref("DeviceKey"),
);
paths["/devices/self/key"].get.security = [{ AccessClientId: [], AccessClientSecret: [] }];
route(
  "/devices/{id}/key",
  "get",
  "getDeviceKeyAsOwner",
  "Read an active device wrap as owner",
  ref("DeviceKey"),
  undefined,
  true,
);
route("/devices/{id}", "patch", "renameDevice", "Rename a device", ref("Revision"), "Rename");
route(
  "/devices/{id}/revoke",
  "post",
  "revokeDevice",
  "Soft-revoke a device and remove its wrap; no request body",
  ref("Revision"),
);
route(
  "/audit",
  "get",
  "listAudit",
  "Read up to 100 audit events after a sequence cursor",
  object({ events: array(ref("AuditEvent")), next_after: { type: "integer", minimum: 0 } }),
  undefined,
  true,
);

const tableNames = [
  "vault",
  "secrets",
  "profiles",
  "devices",
  "device_activity",
  "audit_log",
  "secret_nonces",
  "master_nonces",
];
route(
  "/database",
  "get",
  "listDatabaseTables",
  "List inspectable application tables (owner only)",
  object({ tables: array({ type: "string", enum: tableNames }) }),
  undefined,
  true,
);
route(
  "/database/{table}",
  "get",
  "getDatabaseRows",
  "Read raw SQLite rows; never decrypts or executes supplied SQL",
  object({
    table: text,
    columns: array(
      object({
        cid: { type: "integer" },
        name: text,
        type: text,
        notnull: { type: "integer" },
        dflt_value: {},
        pk: { type: "integer" },
        hidden: { type: "integer" },
      }),
    ),
    rows: array({ type: "object", additionalProperties: true }),
    total: { type: "integer", minimum: 0 },
    offset: { type: "integer", minimum: 0 },
    limit: { const: 50 },
  }),
  undefined,
  true,
);
paths["/database/{table}"].get.parameters.push(
  { name: "table", in: "path", required: true, schema: { type: "string", enum: tableNames } },
  {
    name: "offset",
    in: "query",
    schema: { type: "integer", minimum: 0, maximum: 1_000_000, default: 0 },
  },
);

const document = {
  openapi: "3.1.0",
  info: {
    title: "Hush Service API",
    version: "1.0.0",
    description:
      "Single-owner encrypted vault. CLI devices are read-only. All binary fields use canonical unpadded base64url. See crypto.md for mandatory AAD, algorithm, size, and nonce rules. The Worker validates structure, not cryptographic correctness.",
  },
  servers: [{ url: "/api/v1" }],
  paths,
  components: {
    schemas,
    securitySchemes: {
      AccessSession: {
        type: "apiKey",
        in: "cookie",
        name: "CF_Authorization",
        description:
          "Cloudflare Access human session. Edge forwards the signed assertion; Worker verifies it and matches OWNER_EMAIL.",
      },
      AccessClientId: { type: "apiKey", in: "header", name: "CF-Access-Client-Id" },
      AccessClientSecret: { type: "apiKey", in: "header", name: "CF-Access-Client-Secret" },
    },
  },
};
const output = "# Generated by npm run contracts. Do not edit by hand.\n" + stringify(document);
const path = new URL("../contracts/openapi.yaml", import.meta.url);
if (process.argv.includes("--check")) {
  if (readFileSync(path, "utf8") !== output)
    throw new Error("API contract is stale. Run npm run contracts.");
} else writeFileSync(path, output);
