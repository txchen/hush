import type { Hono } from "hono";
import type { AppEnv } from "../http";
import { body, editing, revisionResponse } from "../http";
import { limits, rotationSchema } from "../vault/model";
import { requireCondition } from "../errors";
import { event } from "../db/repository";

export function rotationRoutes(app: Hono<AppEnv>) {
  app.post("/vault/rotate", async (c) => {
    const { before, after } = editing(c);
    const input = await body(c, rotationSchema, limits.rotation);
    requireCondition(
      input.vek_version === before.vault.vek_version + 1,
      409,
      "vek_version_conflict",
    );
    const revoked = new Set(input.revoke_device_ids);
    requireCondition(
      revoked.size === input.revoke_device_ids.length &&
        [...revoked].every((id) =>
          before.devices.some((d) => d.id === id && d.status === "active"),
        ),
      400,
      "invalid_revocation_set",
    );
    const secrets = new Map(input.secrets.map((s) => [s.id, s]));
    requireCondition(
      secrets.size === input.secrets.length &&
        secrets.size === before.secrets.length &&
        before.secrets.every((s) => secrets.get(s.id)?.version === s.version + 1),
      400,
      "incomplete_secret_rotation",
    );
    const keys = new Map(input.device_keys.map((d) => [d.id, d.wrapped_vek]));
    const remaining = before.devices.filter((d) => d.status === "active" && !revoked.has(d.id));
    requireCondition(
      keys.size === input.device_keys.length &&
        keys.size === remaining.length &&
        remaining.every((d) => keys.has(d.id)),
      400,
      "incomplete_device_rotation",
    );
    requireCondition(
      input.master_wrap.ciphertext !== before.vault.master_wrap.ciphertext,
      400,
      "fresh_master_wrap_required",
    );
    if (input.kdf.salt === before.vault.kdf.salt)
      requireCondition(
        input.master_wrap.nonce !== before.vault.master_wrap.nonce,
        400,
        "fresh_master_nonce_required",
      );
    after.vault.vek_version = input.vek_version;
    after.vault.kdf = input.kdf;
    after.vault.master_wrap = input.master_wrap;
    for (const secret of after.secrets) {
      const replacement = secrets.get(secret.id)!;
      secret.envelope = replacement.envelope;
      secret.version = replacement.version;
      secret.vek_version = input.vek_version;
      secret.updated_at = after.vault.updated_at;
    }
    for (const device of after.devices) {
      if (revoked.has(device.id)) {
        device.status = "revoked";
        device.wrapped_vek = null;
        device.updated_at = after.vault.updated_at;
      } else if (device.status === "active") {
        const replacement = keys.get(device.id)!;
        requireCondition(
          replacement.enc !== device.wrapped_vek?.enc,
          400,
          "fresh_device_encapsulation_required",
        );
        device.wrapped_vek = replacement;
        device.vek_version = input.vek_version;
        device.updated_at = after.vault.updated_at;
      }
    }
    await c
      .get("repository")
      .commit(before, after, event(c.get("actor"), "vault.rotated", after.vault.id));
    return revisionResponse(c, after.vault.revision);
  });
}
