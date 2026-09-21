import { z } from "zod";

export const limits = {
  secrets: 500,
  devices: 50,
  profiles: 100,
  envelope: 16 * 1024,
  request: 1024 * 1024,
  rotation: 10 * 1024 * 1024,
} as const;
export const idSchema = z
  .uuid()
  .refine((value) => value === value.toLowerCase(), "UUIDs must be lowercase");
export const nameSchema = z
  .string()
  .min(1)
  .max(128)
  // Control characters must not enter names displayed by clients or terminals.
  // oxlint-disable-next-line no-control-regex
  .regex(/^[^\x00-\x1f\x7f]+$/)
  .refine((v) => v === v.trim());
export const versionSchema = z
  .number()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER - 1);

function binary(min: number, max = min) {
  return z
    .string()
    .min(Math.ceil((min * 4) / 3))
    .max(Math.ceil((max * 4) / 3))
    .regex(/^[A-Za-z0-9_-]+$/)
    .refine((value) => {
      try {
        const decoded = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
        return (
          decoded.length >= min &&
          decoded.length <= max &&
          btoa(decoded).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") === value
        );
      } catch {
        return false;
      }
    }, "Expected canonical unpadded base64url");
}

export const aeadSchema = z
  .strictObject({
    format: z.literal(1),
    algorithm: z.literal("AES-256-GCM"),
    nonce: binary(12),
    ciphertext: binary(16, 12_200),
  })
  .refine((v) => JSON.stringify(v).length <= limits.envelope, "Envelope exceeds 16 KiB");
export const masterWrapSchema = z.strictObject({
  format: z.literal(1),
  algorithm: z.literal("AES-256-GCM"),
  nonce: binary(12),
  ciphertext: binary(48),
});
export const deviceWrapSchema = z.strictObject({
  format: z.literal(1),
  algorithm: z.literal("HPKE-X25519-HKDF-SHA256-AES-256-GCM"),
  enc: binary(32),
  ciphertext: binary(48),
});
export const publicKeySchema = binary(32).refine(
  (v) =>
    atob(v.replace(/-/g, "+").replace(/_/g, "/"))
      .split("")
      .some((c) => c.charCodeAt(0) !== 0),
  "Invalid public key",
);
export const kdfSchema = z.strictObject({
  algorithm: z.literal("Argon2id"),
  version: z.literal(19),
  salt: binary(16),
  memory_kib: z.literal(65536),
  iterations: z.literal(3),
  parallelism: z.literal(1),
});
export const initSchema = z.strictObject({
  id: idSchema,
  name: nameSchema,
  kdf: kdfSchema,
  master_wrap: masterWrapSchema,
});
export const secretInputSchema = z.strictObject({
  name: nameSchema,
  version: versionSchema,
  vek_version: versionSchema,
  envelope: aeadSchema,
});
export const deviceInputSchema = z
  .strictObject({
    id: idSchema,
    name: nameSchema,
    type: z.enum(["cli", "browser"]),
    public_key: publicKeySchema,
    access_client_id: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_-]+\.access$/)
      .nullable(),
    vek_version: versionSchema,
    wrapped_vek: deviceWrapSchema,
  })
  .refine(
    (v) => (v.type === "cli" ? v.access_client_id !== null : v.access_client_id === null),
    "Only CLI devices require an Access Client ID",
  );
export const profileInputSchema = z.strictObject({
  name: nameSchema,
  mappings: z
    .array(
      z.strictObject({
        secret_id: idSchema,
        env_name: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      }),
    )
    .max(limits.secrets),
});
export const passwordSchema = z.strictObject({ kdf: kdfSchema, master_wrap: masterWrapSchema });
export const renameSchema = z.strictObject({ name: nameSchema });
export const rotationSchema = z.strictObject({
  vek_version: versionSchema,
  kdf: kdfSchema,
  master_wrap: masterWrapSchema,
  revoke_device_ids: z.array(idSchema).max(limits.devices),
  secrets: z
    .array(z.strictObject({ id: idSchema, version: versionSchema, envelope: aeadSchema }))
    .max(limits.secrets),
  device_keys: z
    .array(z.strictObject({ id: idSchema, wrapped_vek: deviceWrapSchema }))
    .max(limits.devices),
});

export type Vault = z.infer<typeof initSchema> & {
  revision: number;
  vek_version: number;
  created_at: string;
  updated_at: string;
};
export type Secret = z.infer<typeof secretInputSchema> & {
  id: string;
  created_at: string;
  updated_at: string;
};
export type Device = Omit<z.infer<typeof deviceInputSchema>, "wrapped_vek"> & {
  wrapped_vek: z.infer<typeof deviceWrapSchema> | null;
  status: "active" | "revoked";
  created_at: string;
  updated_at: string;
};
export type Profile = z.infer<typeof profileInputSchema> & {
  id: string;
  created_at: string;
  updated_at: string;
};
export type Snapshot = { vault: Vault; secrets: Secret[]; devices: Device[]; profiles: Profile[] };
export type Identity = { role: "owner"; subject: string } | { role: "device"; clientId: string };
export type Actor = { role: "owner"; subject: string } | { role: "device"; deviceId: string };
export type AuditEvent = { actor: Actor; action: string; resource_id: string | null };
