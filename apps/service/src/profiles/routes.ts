import type { Hono } from "hono";
import type { AppEnv } from "../http";
import { body, snapshot, editing, revisionResponse } from "../http";
import { idSchema, limits, profileInputSchema } from "../vault/model";
import { requireCondition } from "../errors";
import { event } from "../db/repository";

export function profileRoutes(app: Hono<AppEnv>) {
  app.get("/profiles", (c) => c.json({ profiles: snapshot(c).profiles }));
  app.get("/profiles/:id", (c) => {
    const profile = snapshot(c).profiles.find((p) => p.id === c.req.param("id"));
    requireCondition(profile, 404, "profile_not_found");
    return c.json(profile);
  });
  app.get("/profiles/:id/secrets", async (c) => {
    const state = snapshot(c);
    const profile = state.profiles.find((p) => p.id === c.req.param("id"));
    requireCondition(profile, 404, "profile_not_found");
    const selected = new Set(profile.mappings.map((m) => m.secret_id));
    await c
      .get("repository")
      .recordRead(event(c.get("actor"), "profile.ciphertexts_fetched", profile.id));
    return c.json({ profile, secrets: state.secrets.filter((s) => selected.has(s.id)) });
  });
  app.put("/profiles/:id", async (c) => {
    const { before, after } = editing(c);
    const id = c.req.param("id");
    requireCondition(idSchema.safeParse(id).success, 400, "invalid_id");
    const input = await body(c, profileInputSchema);
    const old = before.profiles.find((p) => p.id === id);
    requireCondition(old || before.profiles.length < limits.profiles, 409, "profile_limit");
    requireCondition(
      !before.profiles.some((p) => p.id !== id && p.name === input.name),
      409,
      "duplicate_profile_name",
    );
    requireCondition(
      new Set(input.mappings.map((m) => m.env_name)).size === input.mappings.length,
      400,
      "duplicate_env_name",
    );
    requireCondition(
      input.mappings.every((m) => before.secrets.some((s) => s.id === m.secret_id)),
      400,
      "unknown_secret",
    );
    after.profiles = [
      ...after.profiles.filter((p) => p.id !== id),
      {
        ...input,
        id,
        created_at: old?.created_at ?? after.vault.updated_at,
        updated_at: after.vault.updated_at,
      },
    ];
    await c
      .get("repository")
      .commit(
        before,
        after,
        event(c.get("actor"), old ? "profile.updated" : "profile.created", id),
      );
    return revisionResponse(c, after.vault.revision);
  });
  app.delete("/profiles/:id", async (c) => {
    const { before, after } = editing(c);
    const id = c.req.param("id");
    requireCondition(
      before.profiles.some((p) => p.id === id),
      404,
      "profile_not_found",
    );
    after.profiles = after.profiles.filter((p) => p.id !== id);
    await c.get("repository").commit(before, after, event(c.get("actor"), "profile.deleted", id));
    return revisionResponse(c, after.vault.revision);
  });
}
