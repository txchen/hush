import { test, expect, type Page } from "@playwright/test";
import vector from "../../../../contracts/fixtures/crypto-v1.json" with { type: "json" };
import type { Snapshot } from "../../../service/src/vault/model";

function initial(): Snapshot {
  const now = "2026-09-21T10:00:00.000Z";
  return {
    vault: {
      id: vector.vault_id,
      name: "Personal",
      revision: 1,
      vek_version: 1,
      kdf: vector.kdf as Snapshot["vault"]["kdf"],
      master_wrap: vector.master_wrap as Snapshot["vault"]["master_wrap"],
      created_at: now,
      updated_at: now,
    },
    secrets: [
      {
        id: vector.secret_id,
        name: "GITHUB_TOKEN",
        version: 1,
        vek_version: 1,
        envelope: vector.secret as Snapshot["secrets"][number]["envelope"],
        created_at: now,
        updated_at: now,
      },
    ],
    profiles: [],
    devices: [],
  };
}

// Browser tests exercise the real UI and cryptography against isolated HTTP
// fixtures. Worker authorization/SQL transactions have separate workerd tests.
async function backend(page: Page, empty = false) {
  let state: Snapshot | undefined = empty ? undefined : initial();
  const writes: unknown[] = [];
  let conflict = false;
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.slice("/api/v1".length);
    const method = request.method();
    const reply = (value: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(value),
        headers: { "Cache-Control": "no-store" },
      });
    const fail = (code: string, status: number) => reply({ error: { code } }, status);
    if (method === "GET" && !state) return fail("vault_not_initialized", 404);
    if (method !== "GET") {
      if (request.headers()["if-match"] !== `"${state?.vault.revision ?? 0}"` || conflict) {
        conflict = false;
        return fail("revision_conflict", 409);
      }
      const data = request.postData() ? request.postDataJSON() : undefined;
      writes.push(data);
      const now = new Date().toISOString();
      if (path === "/vault") {
        state = {
          vault: { ...data, revision: 1, vek_version: 1, created_at: now, updated_at: now },
          secrets: [],
          profiles: [],
          devices: [],
        };
        return reply({ revision: 1 });
      }
      if (!state) return fail("vault_not_initialized", 404);
      if (path.startsWith("/secrets/")) {
        const id = path.split("/")[2];
        const old = state.secrets.find((s) => s.id === id);
        state.secrets = state.secrets.filter((s) => s.id !== id);
        if (method === "PUT")
          state.secrets.push({ ...data, id, created_at: old?.created_at ?? now, updated_at: now });
      } else if (path.startsWith("/profiles/")) {
        const id = path.split("/")[2];
        state.profiles = state.profiles.filter((p) => p.id !== id);
        if (method === "PUT")
          state.profiles.push({ ...data, id, created_at: now, updated_at: now });
      } else if (path === "/devices")
        state.devices.push({ ...data, status: "active", created_at: now, updated_at: now });
      else if (path.endsWith("/revoke")) {
        const device = state.devices.find((d) => d.id === path.split("/")[2]);
        if (device) {
          device.status = "revoked";
          device.wrapped_vek = null;
        }
      } else if (path.startsWith("/devices/") && method === "PATCH") {
        const device = state.devices.find((d) => d.id === path.split("/")[2]);
        if (device) device.name = data.name;
      } else if (path === "/vault/master-wrap") {
        state.vault.kdf = data.kdf;
        state.vault.master_wrap = data.master_wrap;
      } else if (path === "/vault/rotate") {
        state.vault.vek_version = data.vek_version;
        state.vault.kdf = data.kdf;
        state.vault.master_wrap = data.master_wrap;
        state.secrets = state.secrets.map((s) => ({
          ...s,
          ...data.secrets.find((item: { id: string }) => item.id === s.id),
          vek_version: data.vek_version,
        }));
        for (const device of state.devices) {
          if (data.revoke_device_ids.includes(device.id)) {
            device.status = "revoked";
            device.wrapped_vek = null;
          } else if (device.status === "active") {
            device.vek_version = data.vek_version;
            device.wrapped_vek = data.device_keys.find(
              (item: { id: string }) => item.id === device.id,
            ).wrapped_vek;
          }
        }
      } else return fail("not_found", 404);
      state.vault.revision++;
      return reply({ revision: state.vault.revision });
    }
    if (path === "/vault/snapshot") return reply(state);
    if (path === "/vault") return reply(state!.vault);
    if (path.startsWith("/devices/") && path.endsWith("/key")) {
      const device = state!.devices.find((d) => d.id === path.split("/")[2]);
      if (device?.status !== "active") return fail("active_device_not_found", 404);
      return reply({ wrapped_vek: device.wrapped_vek, vek_version: device.vek_version });
    }
    if (path === "/audit")
      return reply({
        events: [
          {
            sequence: 1,
            action: "vault.initialized",
            actor_role: "owner",
            resource_id: vector.vault_id,
            created_at: "2026-09-21T10:00:00Z",
          },
        ],
        next_after: 1,
      });
    if (path === "/database")
      return reply({
        tables: [
          "vault",
          "secrets",
          "profiles",
          "devices",
          "device_activity",
          "audit_log",
          "secret_nonces",
          "master_nonces",
        ],
      });
    if (path.startsWith("/database/")) {
      const table = path.split("/")[2];
      const rows =
        table === "vault"
          ? [{ singleton: 1, revision: state!.vault.revision, data: JSON.stringify(state!.vault) }]
          : table === "secrets"
            ? state!.secrets.map((s) => ({ id: s.id, data: JSON.stringify(s), name: s.name }))
            : [];
      return reply({
        table,
        columns: (table === "vault"
          ? ["singleton", "revision", "data"]
          : ["id", "data", "name"]
        ).map((name, i) => ({
          name,
          type: name === "data" ? "TEXT" : "TEXT",
          pk: i === 0 ? 1 : 0,
          hidden: name === "name" ? 3 : 0,
        })),
        rows,
        total: rows.length,
        offset: 0,
        limit: 50,
      });
    }
    return fail("not_found", 404);
  });
  return {
    writes,
    state: () => state!,
    conflictNext: () => {
      conflict = true;
    },
  };
}

async function unlock(page: Page, trust = false, password = vector.password) {
  await page.getByLabel("Master password", { exact: true }).fill(password);
  if (trust) await page.getByLabel("Trust this browser").check();
  await page.getByRole("button", { name: "Unlock with password" }).click();
  await expect(page.getByRole("link", { name: /^Secrets/ })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Refresh vault" })).toBeEnabled();
}

test("creates a vault without uploading password or plaintext keys", async ({ page }) => {
  const server = await backend(page, true);
  await page.goto("/");
  await page.getByLabel("Master password", { exact: true }).fill(vector.password);
  await page.getByLabel("Confirm password").fill(vector.password);
  await expect(page.getByLabel("Trust this browser")).not.toBeChecked();
  await page.getByRole("button", { name: "Create vault" }).click();
  await expect(page.getByRole("heading", { name: "Secrets", exact: false })).toBeVisible({
    timeout: 60_000,
  });
  expect(JSON.stringify(server.writes)).not.toContain(vector.password);
  expect(server.state().vault.master_wrap.ciphertext).toBeTruthy();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Unlock vault" })).toBeVisible();
});

test("trusted browser persists a non-extractable key and reopens without the password", async ({
  page,
}) => {
  await backend(page);
  await page.goto("/");
  await unlock(page, true);
  const extractable = await page.evaluate(async () => {
    return await new Promise<boolean>((resolve, reject) => {
      const request = indexedDB.open("hush-device", 1);
      request.onsuccess = () => {
        const read = request.result.transaction("keys").objectStore("keys").getAll();
        read.onsuccess = () => {
          resolve(read.result[0].privateKey.extractable);
          request.result.close();
        };
        read.onerror = reject;
      };
      request.onerror = reject;
    });
  });
  expect(extractable).toBe(false);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Secrets", exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Reveal GITHUB_TOKEN" }).click();
  await expect(page.getByText(vector.plaintext, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Lock vault" }).first().click();
  await expect(page.getByRole("heading", { name: "Unlock vault" })).toBeVisible();
  await expect(page.getByText(vector.plaintext, { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Unlock with this browser" }).click();
  await expect(page.getByRole("button", { name: "Reveal GITHUB_TOKEN" })).toBeVisible();
});

test("encrypts secret edits, handles conflicts and builds profile mappings", async ({ page }) => {
  const server = await backend(page);
  await page.goto("/");
  await unlock(page);
  await page.getByRole("button", { name: "Add secret" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill("CLOUDFLARE_API_TOKEN");
  await dialog.getByLabel("Value", { exact: true }).fill("private-token-never-upload");
  server.conflictNext();
  await dialog.getByRole("button", { name: "Save secret" }).click();
  await expect(dialog.getByRole("alert")).toContainText("vault changed");
  await dialog.getByLabel("Value", { exact: true }).fill("private-token-never-upload");
  await dialog.getByRole("button", { name: "Save secret" }).click();
  await expect(dialog).toHaveCount(0);
  expect(JSON.stringify(server.writes)).not.toContain("private-token-never-upload");
  await page.getByRole("button", { name: "Reveal CLOUDFLARE_API_TOKEN" }).click();
  await expect(page.getByText("private-token-never-upload", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Profiles" }).click();
  await page.getByRole("button", { name: "Add profile" }).click();
  await dialog.getByLabel("Name", { exact: true }).fill("cloudflare");
  await dialog.getByLabel("CLOUDFLARE_API_TOKEN", { exact: true }).check();
  await dialog.getByRole("button", { name: "Save profile" }).click();
  await expect(dialog).toHaveCount(0);
  expect(server.state().profiles[0].mappings).toHaveLength(1);
  await page.getByRole("link", { name: /^Secrets/ }).click();
  await expect(page.getByText("private-token-never-upload", { exact: true })).toHaveCount(0);
});

test("database viewer exposes raw ciphertext and never decrypts stored rows", async ({ page }) => {
  await backend(page);
  await page.goto("/");
  await unlock(page);
  await page.getByRole("link", { name: "Database" }).click();
  await expect(page.getByText("Read-only", { exact: true })).toBeVisible();
  await page
    .getByRole("navigation", { name: "Database tables" })
    .getByRole("button", { name: "secrets", exact: true })
    .click();
  await page.getByRole("button", { name: "Inspect data in row 1" }).click();
  await expect(page.getByRole("dialog")).toContainText(vector.secret.ciphertext);
  await expect(page.getByRole("dialog")).not.toContainText(vector.plaintext);
  await page.getByLabel("Format JSON").uncheck();
  await expect(page.locator("pre")).toContainText('"envelope":{');
});

test("rotates the vault, changes its password and can still decrypt secrets", async ({ page }) => {
  const server = await backend(page);
  await page.goto("/");
  await unlock(page);
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Rotate key", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Current master password").fill(vector.password);
  await dialog.getByRole("button", { name: "Rotate key" }).click();
  await expect(dialog).toHaveCount(0, { timeout: 60_000 });
  expect(server.state().vault.vek_version).toBe(2);
  await page.getByRole("button", { name: "Change password", exact: true }).click();
  await dialog.getByLabel("Current master password").fill(vector.password);
  await dialog
    .getByLabel("New master password", { exact: true })
    .fill("Another public test password 123");
  await dialog.getByLabel("Confirm new password").fill("Another public test password 123");
  await dialog.getByRole("button", { name: "Change password" }).click();
  await expect(dialog).toHaveCount(0, { timeout: 60_000 });
  await page.reload();
  await unlock(page, false, "Another public test password 123");
  await page.getByRole("link", { name: /^Secrets/ }).click();
  await page.getByRole("button", { name: "Reveal GITHUB_TOKEN" }).click();
  await expect(page.getByText(vector.plaintext, { exact: true })).toBeVisible();
});

test("hides revealed values when backgrounded and locks after inactivity", async ({ page }) => {
  await backend(page);
  await page.goto("/");
  await unlock(page);
  await page.getByRole("button", { name: "Reveal GITHUB_TOKEN" }).click();
  await expect(page.getByText(vector.plaintext, { exact: true })).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.getByText(vector.plaintext, { exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    const now = Date.now();
    Date.now = () => now + 16 * 60_000;
  });
  await expect(page.getByRole("heading", { name: "Unlock vault" })).toBeVisible();
});

test("compact layout works on desktop and mobile without page overflow", async ({ page }) => {
  await backend(page);
  await page.goto("/");
  await unlock(page);
  await page.screenshot({ path: "../../.scratch/web/desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "../../.scratch/web/mobile.png", fullPage: true });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.screenshot({ path: "../../.scratch/web/dark.png", fullPage: true });
});
