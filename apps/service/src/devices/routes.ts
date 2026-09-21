import type { Hono } from "hono";
import type { AppEnv } from "../http";
import { body, owner, snapshot, editing, revisionResponse } from "../http";
import { deviceInputSchema, limits, renameSchema } from "../vault/model";
import { requireCondition } from "../errors";
import { event } from "../db/repository";

export function deviceRoutes(app: Hono<AppEnv>) {
  app.get("/devices", async (c) => {
    owner(c);
    const activity = new Map(
      (await c.get("repository").activity()).map((a) => [a.device_id, a.last_seen_at]),
    );
    return c.json({
      devices: snapshot(c).devices.map(({ wrapped_vek: _wrap, ...device }) => ({
        ...device,
        last_seen_at: activity.get(device.id) ?? null,
      })),
    });
  });
  app.get("/devices/self/key", async (c) => {
    const actor = c.get("actor");
    requireCondition(actor.role === "device", 403, "device_session_required");
    const device = snapshot(c).devices.find((d) => d.id === actor.deviceId);
    requireCondition(device?.status === "active", 403, "device_revoked");
    await c.get("repository").recordRead(event(actor, "device_wrap.fetched", device.id));
    return c.json({
      device_id: device.id,
      vault_id: snapshot(c).vault.id,
      vek_version: device.vek_version,
      wrapped_vek: device.wrapped_vek,
    });
  });
  app.get("/devices/:id/key", async (c) => {
    owner(c);
    const device = snapshot(c).devices.find((d) => d.id === c.req.param("id"));
    requireCondition(device?.status === "active", 404, "active_device_not_found");
    await c.get("repository").recordRead(event(c.get("actor"), "device_wrap.fetched", device.id));
    return c.json({
      device_id: device.id,
      vault_id: snapshot(c).vault.id,
      vek_version: device.vek_version,
      wrapped_vek: device.wrapped_vek,
    });
  });
  app.post("/devices", async (c) => {
    const { before, after } = editing(c);
    const input = await body(c, deviceInputSchema);
    requireCondition(input.vek_version === before.vault.vek_version, 409, "vek_version_conflict");
    requireCondition(
      before.devices.filter((d) => d.status === "active").length < limits.devices,
      409,
      "device_limit",
    );
    requireCondition(
      !before.devices.some(
        (d) =>
          d.id === input.id ||
          (input.access_client_id !== null && d.access_client_id === input.access_client_id),
      ),
      409,
      "device_already_registered",
    );
    // Also bound retained revocation tombstones, which are never reused.
    requireCondition(before.devices.length < 500, 409, "device_history_limit");
    after.devices.push({
      ...input,
      status: "active",
      created_at: after.vault.updated_at,
      updated_at: after.vault.updated_at,
    });
    await c
      .get("repository")
      .commit(before, after, event(c.get("actor"), "device.registered", input.id));
    return revisionResponse(c, after.vault.revision);
  });
  app.patch("/devices/:id", async (c) => {
    const { before, after } = editing(c);
    const input = await body(c, renameSchema);
    const device = after.devices.find((d) => d.id === c.req.param("id"));
    requireCondition(device, 404, "device_not_found");
    device.name = input.name;
    device.updated_at = after.vault.updated_at;
    await c
      .get("repository")
      .commit(before, after, event(c.get("actor"), "device.renamed", device.id));
    return revisionResponse(c, after.vault.revision);
  });
  app.post("/devices/:id/revoke", async (c) => {
    const { before, after } = editing(c);
    const device = after.devices.find((d) => d.id === c.req.param("id"));
    requireCondition(device, 404, "device_not_found");
    requireCondition(device.status === "active", 409, "device_already_revoked");
    device.status = "revoked";
    device.wrapped_vek = null;
    device.updated_at = after.vault.updated_at;
    await c
      .get("repository")
      .commit(before, after, event(c.get("actor"), "device.revoked", device.id));
    return revisionResponse(c, after.vault.revision);
  });
}
