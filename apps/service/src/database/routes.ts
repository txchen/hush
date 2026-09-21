import type { Hono } from "hono";
import type { AppEnv } from "../http";
import { owner } from "../http";
import { requireCondition } from "../errors";

const tables = {
  vault: "singleton",
  secrets: "id",
  profiles: "id",
  devices: "id",
  device_activity: "device_id",
  audit_log: "sequence",
  secret_nonces: "vek_version, nonce",
  master_nonces: "salt, nonce",
} as const;

export function databaseRoutes(app: Hono<AppEnv>) {
  app.get("/database", (c) => {
    owner(c);
    return c.json({ tables: Object.keys(tables) });
  });
  app.get("/database/:table", async (c) => {
    owner(c);
    const table = c.req.param("table");
    requireCondition(Object.hasOwn(tables, table), 404, "table_not_found");
    const offsetText = c.req.query("offset") ?? "0";
    const offset = Number(offsetText);
    requireCondition(
      /^(0|[1-9][0-9]*)$/.test(offsetText) && Number.isSafeInteger(offset) && offset <= 1_000_000,
      400,
      "invalid_offset",
    );
    // Identifiers come exclusively from this fixed allowlist. No SQL is accepted.
    const order = tables[table as keyof typeof tables];
    const db = c.env.DB.withSession("first-primary");
    const [columns, count, rows] = await db.batch<Record<string, unknown>>([
      db.prepare(`PRAGMA table_xinfo(${table})`),
      db.prepare(`SELECT COUNT(*) AS total FROM ${table}`),
      db.prepare(`SELECT * FROM ${table} ORDER BY ${order} LIMIT 50 OFFSET ?`).bind(offset),
    ]);
    return c.json({
      table,
      columns: columns.results,
      total: count.results[0].total,
      offset,
      limit: 50,
      rows: rows.results,
    });
  });
}
