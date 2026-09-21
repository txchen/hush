import type { Actor, AuditEvent, Snapshot, Vault, Secret, Device, Profile } from "../vault/model";
import { ApiError } from "../errors";

type Row = { data: string };
type Table = "secrets" | "devices" | "profiles";

export class Repository {
  // Pin reads to the primary so revocation is never checked against a stale replica.
  private db: D1DatabaseSession;
  constructor(db: D1Database) {
    this.db = db.withSession("first-primary");
  }

  async snapshot(): Promise<Snapshot | null> {
    const [vault, secrets, devices, profiles] = await this.db.batch<Row>([
      this.db.prepare("SELECT data FROM vault WHERE singleton = 1"),
      this.db.prepare("SELECT data FROM secrets ORDER BY id"),
      this.db.prepare("SELECT data FROM devices ORDER BY id"),
      this.db.prepare("SELECT data FROM profiles ORDER BY id"),
    ]);
    if (!vault.results.length) return null;
    return {
      vault: JSON.parse(vault.results[0].data) as Vault,
      secrets: secrets.results.map((r) => JSON.parse(r.data) as Secret),
      devices: devices.results.map((r) => JSON.parse(r.data) as Device),
      profiles: profiles.results.map((r) => JSON.parse(r.data) as Profile),
    };
  }

  private auditStatement(event: AuditEvent) {
    return this.db
      .prepare(
        "INSERT INTO audit_log (actor_role, actor_id, action, resource_id, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(
        event.actor.role,
        event.actor.role === "owner" ? event.actor.subject : event.actor.deviceId,
        event.action,
        event.resource_id,
        new Date().toISOString(),
      );
  }

  async recordRead(event: AuditEvent) {
    const statements = [this.auditStatement(event)];
    if (event.actor.role === "device") {
      statements.push(
        this.db
          .prepare(
            "INSERT INTO device_activity (device_id, last_seen_at) VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET last_seen_at = excluded.last_seen_at",
          )
          .bind(event.actor.deviceId, new Date().toISOString()),
      );
    }
    await this.db.batch(statements);
  }

  async audit(after: number) {
    return (
      await this.db
        .prepare("SELECT * FROM audit_log WHERE sequence > ? ORDER BY sequence LIMIT 100")
        .bind(after)
        .all()
    ).results;
  }

  async activity() {
    return (
      await this.db
        .prepare("SELECT device_id, last_seen_at FROM device_activity")
        .all<{ device_id: string; last_seen_at: string }>()
    ).results;
  }

  async commit(before: Snapshot | null, after: Snapshot, event: AuditEvent) {
    const statements: D1PreparedStatement[] = [];
    if (!before) {
      statements.push(
        this.db
          .prepare("INSERT INTO vault (singleton, revision, data) VALUES (1, 1, ?)")
          .bind(JSON.stringify(after.vault)),
      );
    } else {
      // A failed CAS must raise an SQL error, not merely update zero rows, so D1
      // rolls back every statement in the batch (including the audit event).
      statements.push(
        this.db
          .prepare(
            "UPDATE vault SET revision = CASE WHEN revision = ? THEN revision + 1 ELSE -1 END, data = ? WHERE singleton = 1",
          )
          .bind(before.vault.revision, JSON.stringify(after.vault)),
      );
    }
    for (const table of ["secrets", "devices", "profiles"] as const) {
      const old = new Map((before?.[table] ?? []).map((row) => [row.id, JSON.stringify(row)]));
      const current = after[table];
      const remaining = new Set(current.map((row) => row.id));
      const deleted = [...old.keys()].filter((id) => !remaining.has(id));
      if (deleted.length)
        statements.push(
          this.db
            .prepare(`DELETE FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`)
            .bind(JSON.stringify(deleted)),
        );
      const changed = current.filter((row) => old.get(row.id) !== JSON.stringify(row));
      statements.push(...this.upserts(table, changed));
    }
    const oldSecrets = new Map(before?.secrets.map((s) => [s.id, s]));
    const nonces = after.secrets
      .filter((s) => {
        const old = oldSecrets.get(s.id);
        return (
          !old ||
          old.version !== s.version ||
          old.vek_version !== s.vek_version ||
          JSON.stringify(old.envelope) !== JSON.stringify(s.envelope)
        );
      })
      .map((s) => ({ vek_version: s.vek_version, nonce: s.envelope.nonce }));
    if (nonces.length)
      statements.push(
        this.db
          .prepare(
            "INSERT INTO secret_nonces (vek_version, nonce) SELECT json_extract(value, '$.vek_version'), json_extract(value, '$.nonce') FROM json_each(?)",
          )
          .bind(JSON.stringify(nonces)),
      );
    if (
      !before ||
      JSON.stringify(before.vault.master_wrap) !== JSON.stringify(after.vault.master_wrap) ||
      before.vault.kdf.salt !== after.vault.kdf.salt
    ) {
      statements.push(
        this.db
          .prepare("INSERT INTO master_nonces (salt, nonce) VALUES (?, ?)")
          .bind(after.vault.kdf.salt, after.vault.master_wrap.nonce),
      );
    }
    statements.push(this.auditStatement(event));
    try {
      await this.db.batch(statements);
    } catch (error) {
      // Only classify known constraint failures; never echo SQL/bound ciphertext.
      const message = error instanceof Error ? error.message : "";
      if (message.includes("valid_revision") || message.includes("vault.singleton"))
        throw new ApiError(409, "revision_conflict");
      if (message.includes("UNIQUE constraint failed"))
        throw new ApiError(409, "duplicate_name_identity_or_nonce");
      throw error;
    }
  }

  private upserts(table: Table, rows: { id: string }[]) {
    const statements: D1PreparedStatement[] = [];
    // Each bound JSON chunk stays well below D1's 2 MB value limit. Even a
    // 500-secret rotation uses fewer than 50 statements, not one per secret.
    for (let i = 0; i < rows.length; i += 40) {
      statements.push(
        this.db
          .prepare(
            `INSERT INTO ${table} (id, data) SELECT json_extract(value, '$.id'), value FROM json_each(?) WHERE true ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
          )
          .bind(JSON.stringify(rows.slice(i, i + 40))),
      );
    }
    return statements;
  }
}

export function event(actor: Actor, action: string, resource_id: string | null = null): AuditEvent {
  return { actor, action, resource_id };
}
