import type { Hono } from "hono";
import type { AppEnv } from "../http";
import { body, snapshot, editing, revisionResponse } from "../http";
import { idSchema, limits, secretInputSchema } from "../vault/model";
import { requireCondition } from "../errors";
import { event } from "../db/repository";

export function secretRoutes(app: Hono<AppEnv>) {
  app.get("/secrets", (c) =>
    c.json({
      secrets: snapshot(c).secrets.map(({ envelope: _envelope, ...metadata }) => metadata),
    }),
  );
  app.get("/secrets/:id", async (c) => {
    const secret = snapshot(c).secrets.find((s) => s.id === c.req.param("id"));
    requireCondition(secret, 404, "secret_not_found");
    await c
      .get("repository")
      .recordRead(event(c.get("actor"), "secret.ciphertext_fetched", secret.id));
    return c.json(secret);
  });
  app.put("/secrets/:id", async (c) => {
    const { before, after } = editing(c);
    const id = c.req.param("id");
    requireCondition(idSchema.safeParse(id).success, 400, "invalid_id");
    const input = await body(c, secretInputSchema);
    const previous = before.secrets.find((s) => s.id === id);
    requireCondition(
      input.vek_version === before.vault.vek_version &&
        input.version === (previous?.version ?? 0) + 1,
      409,
      "secret_version_conflict",
    );
    requireCondition(previous || before.secrets.length < limits.secrets, 409, "secret_limit");
    requireCondition(
      !before.secrets.some((s) => s.id !== id && s.name === input.name),
      409,
      "duplicate_secret_name",
    );
    const now = after.vault.updated_at;
    const secret = { ...input, id, created_at: previous?.created_at ?? now, updated_at: now };
    after.secrets = [...after.secrets.filter((s) => s.id !== id), secret];
    await c
      .get("repository")
      .commit(
        before,
        after,
        event(c.get("actor"), previous ? "secret.updated" : "secret.created", id),
      );
    return revisionResponse(c, after.vault.revision);
  });
  app.delete("/secrets/:id", async (c) => {
    const { before, after } = editing(c);
    const id = c.req.param("id");
    requireCondition(
      before.secrets.some((s) => s.id === id),
      404,
      "secret_not_found",
    );
    requireCondition(
      !before.profiles.some((p) => p.mappings.some((m) => m.secret_id === id)),
      409,
      "secret_in_use",
    );
    after.secrets = after.secrets.filter((s) => s.id !== id);
    await c.get("repository").commit(before, after, event(c.get("actor"), "secret.deleted", id));
    return revisionResponse(c, after.vault.revision);
  });
}
