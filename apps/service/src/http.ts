import type { Context } from "hono";
import type { z } from "zod";
import type { Actor, Snapshot } from "./vault/model";
import type { Repository } from "./db/repository";
import { ApiError, requireCondition } from "./errors";

export type AppEnv = {
  Bindings: Env;
  Variables: { actor: Actor; repository: Repository; snapshot: Snapshot | null; requestId: string };
};
export type AppContext = Context<AppEnv>;

export function snapshot(c: AppContext): Snapshot {
  const state = c.get("snapshot");
  requireCondition(state, 404, "vault_not_initialized");
  return state;
}

export function owner(c: AppContext) {
  requireCondition(c.get("actor").role === "owner", 403, "owner_required");
}

export function expectedRevision(c: AppContext): number {
  const match = c.req.header("If-Match");
  requireCondition(match, 428, "revision_required");
  requireCondition(/^"(0|[1-9][0-9]*)"$/.test(match), 400, "invalid_revision");
  const revision = Number(match.slice(1, -1));
  requireCondition(Number.isSafeInteger(revision), 400, "invalid_revision");
  return revision;
}

export function editing(c: AppContext): { before: Snapshot; after: Snapshot } {
  owner(c);
  const before = snapshot(c);
  requireCondition(expectedRevision(c) === before.vault.revision, 409, "revision_conflict");
  const after = structuredClone(before);
  after.vault.revision++;
  after.vault.updated_at = new Date().toISOString();
  return { before, after };
}

export async function body<T extends z.ZodType>(
  c: AppContext,
  schema: T,
  max = 1024 * 1024,
): Promise<z.infer<T>> {
  requireCondition(
    c.req.header("Content-Type")?.split(";")[0].trim().toLowerCase() === "application/json",
    415,
    "json_required",
  );
  const length = c.req.header("Content-Length");
  if (length) requireCondition(Number(length) <= max, 413, "request_too_large");
  requireCondition(c.req.raw.body, 400, "body_required");
  const reader = c.req.raw.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new ApiError(413, "request_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    throw new ApiError(400, "invalid_json");
  }
  const parsed = schema.safeParse(data);
  requireCondition(parsed.success, 400, "invalid_body");
  return parsed.data;
}

export function revisionResponse(c: AppContext, revision: number) {
  c.header("ETag", `"${revision}"`);
  return c.json({ revision });
}
