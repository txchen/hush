import { Hono } from "hono";
import { authenticate } from "./auth/access";
import { Repository } from "./db/repository";
import { ApiError, requireCondition } from "./errors";
import type { AppEnv } from "./http";
import { vaultRoutes } from "./vault/routes";
import { secretRoutes } from "./secrets/routes";
import { profileRoutes } from "./profiles/routes";
import { deviceRoutes } from "./devices/routes";
import { rotationRoutes } from "./rotation/routes";
import { auditRoutes } from "./audit/routes";
import { databaseRoutes } from "./database/routes";

const app = new Hono<AppEnv>();
app.use("*", async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);
  c.header("X-Request-Id", requestId);
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  await next();
});
app.onError((error, c) => {
  if (error instanceof ApiError)
    return c.json({ error: { code: error.code, request_id: c.get("requestId") } }, error.status);
  // SQL errors can contain bound values; never log the exception or request body.
  console.error(JSON.stringify({ event: "request_failed", request_id: c.get("requestId") }));
  return c.json({ error: { code: "internal_error", request_id: c.get("requestId") } }, 500);
});
app.notFound((c) => c.json({ error: { code: "not_found", request_id: c.get("requestId") } }, 404));

const api = new Hono<AppEnv>();
api.use("*", async (c, next) => {
  const identity = await authenticate(c.req.raw, c.env);
  const isWrite = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
  if (isWrite) {
    requireCondition(identity.role === "owner", 403, "owner_required");
    // Owner writes are same-origin browser operations; this is CSRF protection,
    // not proof of a browser. Authority comes from the signed Access identity.
    requireCondition(
      c.req.header("Origin") === c.env.ADMIN_ORIGIN && c.req.header("X-Hush-Request") === "1",
      403,
      "invalid_admin_origin",
    );
    if (c.req.method === "DELETE" || c.req.path.endsWith("/revoke")) {
      requireCondition(!c.req.raw.body, 400, "unexpected_body");
    }
  } else if (c.req.header("Origin")) {
    requireCondition(c.req.header("Origin") === c.env.ADMIN_ORIGIN, 403, "invalid_admin_origin");
  }
  const repository = new Repository(c.env.DB);
  const state = await repository.snapshot();
  c.set("repository", repository);
  c.set("snapshot", state);
  if (identity.role === "owner") c.set("actor", identity);
  else {
    const device = state?.devices.find(
      (d) => d.type === "cli" && d.access_client_id === identity.clientId,
    );
    requireCondition(device?.status === "active", 403, "device_not_authorized");
    c.set("actor", { role: "device", deviceId: device.id });
  }
  if (state) c.header("ETag", `"${state.vault.revision}"`);
  await next();
});

vaultRoutes(api);
secretRoutes(api);
profileRoutes(api);
deviceRoutes(api);
rotationRoutes(api);
auditRoutes(api);
databaseRoutes(api);
app.route("/api/v1", api);

export default app;
