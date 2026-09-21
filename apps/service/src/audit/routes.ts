import type { Hono } from "hono";
import type { AppEnv } from "../http";
import { owner } from "../http";
import { requireCondition } from "../errors";

export function auditRoutes(app: Hono<AppEnv>) {
  app.get("/audit", async (c) => {
    owner(c);
    const value = c.req.query("after") ?? "0";
    const after = Number(value);
    requireCondition(
      /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(after),
      400,
      "invalid_cursor",
    );
    const events = await c.get("repository").audit(after);
    return c.json({
      events,
      next_after: events.length ? events[events.length - 1].sequence : after,
    });
  });
}
