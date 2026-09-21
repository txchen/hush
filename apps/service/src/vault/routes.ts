import type { Hono } from "hono";
import type { AppEnv } from "../http";
import { body, expectedRevision, owner, snapshot, editing, revisionResponse } from "../http";
import { initSchema, passwordSchema } from "./model";
import { requireCondition } from "../errors";
import { event } from "../db/repository";

export function vaultRoutes(app: Hono<AppEnv>) {
  app.get("/vault", (c) => {
    const { vault } = snapshot(c);
    return c.json({
      id: vault.id,
      name: vault.name,
      revision: vault.revision,
      vek_version: vault.vek_version,
      created_at: vault.created_at,
      updated_at: vault.updated_at,
    });
  });
  app.put("/vault", async (c) => {
    owner(c);
    requireCondition(
      expectedRevision(c) === 0 && !c.get("snapshot"),
      409,
      "vault_already_initialized",
    );
    const input = await body(c, initSchema);
    const now = new Date().toISOString();
    const after = {
      vault: { ...input, revision: 1, vek_version: 1, created_at: now, updated_at: now },
      secrets: [],
      devices: [],
      profiles: [],
    };
    await c
      .get("repository")
      .commit(null, after, event(c.get("actor"), "vault.initialized", input.id));
    return revisionResponse(c, 1);
  });
  app.get("/vault/recovery", async (c) => {
    owner(c);
    const { vault } = snapshot(c);
    await c.get("repository").recordRead(event(c.get("actor"), "master_wrap.fetched", vault.id));
    return c.json({
      vault_id: vault.id,
      revision: vault.revision,
      vek_version: vault.vek_version,
      kdf: vault.kdf,
      master_wrap: vault.master_wrap,
    });
  });
  app.get("/vault/snapshot", async (c) => {
    owner(c);
    const state = snapshot(c);
    await c
      .get("repository")
      .recordRead(event(c.get("actor"), "vault.snapshot_fetched", state.vault.id));
    return c.json(state);
  });
  app.put("/vault/master-wrap", async (c) => {
    const { before, after } = editing(c);
    const input = await body(c, passwordSchema);
    requireCondition(input.kdf.salt !== before.vault.kdf.salt, 400, "fresh_kdf_salt_required");
    after.vault.kdf = input.kdf;
    after.vault.master_wrap = input.master_wrap;
    await c
      .get("repository")
      .commit(before, after, event(c.get("actor"), "master_wrap.replaced", after.vault.id));
    return revisionResponse(c, after.vault.revision);
  });
}
