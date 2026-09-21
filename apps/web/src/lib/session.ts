import { ref, shallowRef } from "vue";
import type { Snapshot, Secret, Profile } from "../../../service/src/vault/model";
import { api, ApiError, message } from "./api";
import {
  aad,
  derive,
  newKdf,
  open,
  random,
  seal,
  secretText,
  unlock,
  wrapDevice,
  unwrapDevice,
  encode,
} from "./crypto";
import { forgetDevice, saveDevice, storedDevice } from "./device-store";

const phase = ref<"loading" | "setup" | "locked" | "open" | "unavailable">("loading");
const snapshot = shallowRef<Snapshot>();
const busy = ref(false);
const error = ref("");
const notice = ref("");
const trusted = ref(false);
const visibility = ref(0);
let vek: Uint8Array | undefined;
let generation = 0;
let lastActivity = Date.now();
function assertCurrent(epoch: number) {
  if (epoch !== generation) throw new Error("Session ended");
}
function key() {
  if (!vek || phase.value !== "open") throw new Error("Vault is locked");
  return vek;
}
function state() {
  if (!snapshot.value) throw new Error("Vault unavailable");
  return snapshot.value;
}
function lock() {
  generation++;
  vek?.fill(0);
  vek = undefined;
  busy.value = false;
  if (snapshot.value) phase.value = "locked";
  error.value = "";
  notice.value = "";
  visibility.value++;
}
async function perform(task: (epoch: number) => Promise<void>) {
  if (busy.value) return false;
  const epoch = generation;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await task(epoch);
    assertCurrent(epoch);
    return true;
  } catch (cause) {
    if (epoch === generation && cause instanceof ApiError && cause.status === 409) {
      try {
        await refresh(epoch);
      } catch {
        /* Keep the original conflict message. */
      }
    }
    if (epoch === generation) error.value = message(cause);
    return false;
  } finally {
    if (epoch === generation) busy.value = false;
  }
}
async function refresh(epoch = generation) {
  const updated = await api<Snapshot>("/vault/snapshot");
  assertCurrent(epoch);
  if (vek && snapshot.value && updated.vault.vek_version !== snapshot.value.vault.vek_version) {
    snapshot.value = updated;
    lock();
    notice.value = "The vault key changed. Unlock again.";
    return;
  }
  snapshot.value = updated;
}
async function boot() {
  phase.value = "loading";
  await perform(async (epoch) => {
    try {
      await refresh(epoch);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "vault_not_initialized") {
        phase.value = "setup";
        return;
      }
      phase.value = "unavailable";
      throw cause;
    }
    phase.value = "locked";
    try {
      trusted.value = Boolean(await storedDevice(state().vault.id));
    } catch {
      trusted.value = false;
    }
    if (trusted.value) await unlockSaved(epoch);
  });
}
async function unlockSaved(epoch: number) {
  const vault = state().vault;
  const local = await storedDevice(vault.id);
  if (!local) {
    trusted.value = false;
    return;
  }
  let candidate: Uint8Array | undefined;
  try {
    const response = await api<{
      wrapped_vek: NonNullable<Snapshot["devices"][number]["wrapped_vek"]>;
      vek_version: number;
    }>(`/devices/${local.deviceId}/key`);
    candidate = await unwrapDevice(
      local.privateKey,
      vault.id,
      local.deviceId,
      response.vek_version,
      response.wrapped_vek,
    );
    assertCurrent(epoch);
    if (response.vek_version !== state().vault.vek_version) {
      await refresh(epoch);
    }
    if (response.vek_version !== state().vault.vek_version) throw new Error("Key version changed");
    vek = candidate;
    candidate = undefined;
    phase.value = "open";
    lastActivity = Date.now();
  } catch (cause) {
    if (cause instanceof ApiError && [403, 404].includes(cause.status)) {
      await forgetDevice(vault.id);
      trusted.value = false;
    }
    if (epoch === generation) notice.value = "Use your master password to unlock this browser.";
  } finally {
    candidate?.fill(0);
  }
}
async function trustBrowser(epoch: number) {
  const current = state();
  const pair = (await crypto.subtle.generateKey({ name: "X25519" }, false, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const id = crypto.randomUUID();
  const publicKey = encode(await crypto.subtle.exportKey("raw", pair.publicKey));
  const wrapped = await wrapDevice(
    key(),
    current.vault.id,
    id,
    current.vault.vek_version,
    publicKey,
  );
  assertCurrent(epoch);
  // Persist first, so an IndexedDB failure cannot strand a server registration.
  await saveDevice({ vaultId: current.vault.id, deviceId: id, privateKey: pair.privateKey });
  try {
    assertCurrent(epoch);
    await api(
      "/devices",
      "POST",
      {
        id,
        name: "Trusted browser",
        type: "browser",
        public_key: publicKey,
        access_client_id: null,
        vek_version: current.vault.vek_version,
        wrapped_vek: wrapped,
      },
      current.vault.revision,
    );
  } catch (cause) {
    await forgetDevice(current.vault.id);
    throw cause;
  }
  assertCurrent(epoch);
  trusted.value = true;
  await refresh(epoch);
}
async function unlockPassword(password: string, trust: boolean) {
  return perform(async (epoch) => {
    await refresh(epoch);
    let candidate: Uint8Array | undefined;
    try {
      candidate = await unlock(password, state().vault);
    } catch {
      throw new ApiError(400, "could_not_unlock_check_your_master_password");
    }
    try {
      assertCurrent(epoch);
      vek = candidate;
      candidate = undefined;
      phase.value = "open";
      lastActivity = Date.now();
    } finally {
      candidate?.fill(0);
    }
    if (trust && !trusted.value) await trustBrowser(epoch);
  });
}
async function initialize(name: string, password: string, trust: boolean) {
  return perform(async (epoch) => {
    const id = crypto.randomUUID();
    const kdf = newKdf();
    const candidate = random(32);
    const kek = await derive(password, kdf);
    try {
      const master_wrap = await seal(kek, candidate, aad("master", id, 1));
      assertCurrent(epoch);
      await api("/vault", "PUT", { id, name, kdf, master_wrap }, 0);
      assertCurrent(epoch);
      await refresh(epoch);
      vek = candidate.slice();
      phase.value = "open";
      lastActivity = Date.now();
      if (trust) await trustBrowser(epoch);
    } finally {
      kek.fill(0);
      candidate.fill(0);
    }
  });
}
async function mutate(path: string, method: string, data: unknown, epoch: number) {
  key();
  assertCurrent(epoch);
  await api(path, method, data, state().vault.revision);
  assertCurrent(epoch);
  await refresh(epoch);
}
async function saveSecret(id: string | undefined, name: string, plaintext: string) {
  return perform(async (epoch) => {
    const current = state();
    const secretId = id ?? crypto.randomUUID();
    const version = (current.secrets.find((s) => s.id === secretId)?.version ?? 0) + 1;
    const bytes = new TextEncoder().encode(plaintext);
    try {
      if (bytes.length > 12_184) throw new ApiError(400, "secret_exceeds_12184_bytes");
      const envelope = await seal(
        key(),
        bytes,
        aad("secret", current.vault.id, secretId, version, current.vault.vek_version),
      );
      await mutate(
        `/secrets/${secretId}`,
        "PUT",
        { name, version, vek_version: current.vault.vek_version, envelope },
        epoch,
      );
    } finally {
      bytes.fill(0);
    }
  });
}
async function reveal(secret: Secret) {
  const epoch = generation;
  const visibilityEpoch = visibility.value;
  const result = await secretText(key(), state().vault.id, secret);
  assertCurrent(epoch);
  if (visibilityEpoch !== visibility.value || document.hidden) throw new Error("View hidden");
  return result;
}
async function saveProfile(id: string | undefined, name: string, mappings: Profile["mappings"]) {
  return perform((epoch) =>
    mutate(`/profiles/${id ?? crypto.randomUUID()}`, "PUT", { name, mappings }, epoch),
  );
}
async function enroll(name: string, id: string, publicKey: string, clientId: string) {
  return perform(async (epoch) => {
    const current = state();
    const wrapped_vek = await wrapDevice(
      key(),
      current.vault.id,
      id,
      current.vault.vek_version,
      publicKey,
    );
    await mutate(
      "/devices",
      "POST",
      {
        id,
        name,
        type: "cli",
        public_key: publicKey,
        access_client_id: clientId,
        vek_version: current.vault.vek_version,
        wrapped_vek,
      },
      epoch,
    );
  });
}
async function revoke(id: string) {
  return perform(async (epoch) => {
    await mutate(`/devices/${id}/revoke`, "POST", undefined, epoch);
    const local = await storedDevice(state().vault.id);
    if (local?.deviceId === id) {
      await forgetDevice(local.vaultId);
      trusted.value = false;
      lock();
    }
  });
}
async function passwordChange(password: string, replacement: string) {
  return perform(async (epoch) => {
    const current = state();
    const recovered = await unlock(password, current.vault);
    const kdf = newKdf();
    let kek: Uint8Array | undefined;
    try {
      kek = await derive(replacement, kdf);
      const master_wrap = await seal(
        kek,
        recovered,
        aad("master", current.vault.id, current.vault.vek_version),
      );
      await mutate("/vault/master-wrap", "PUT", { kdf, master_wrap }, epoch);
    } finally {
      recovered.fill(0);
      kek?.fill(0);
    }
  });
}
async function rotate(password: string, revokeId?: string) {
  return perform(async (epoch) => {
    const current = state();
    const next = current.vault.vek_version + 1;
    const kek = await derive(password, current.vault.kdf);
    const newKey = random(32);
    let oldKey: Uint8Array | undefined;
    let submitted = false;
    try {
      oldKey = await open(
        kek,
        current.vault.master_wrap,
        aad("master", current.vault.id, current.vault.vek_version),
      );
      const secrets = [];
      for (const secret of current.secrets) {
        const plaintext = await open(
          oldKey,
          secret.envelope,
          aad("secret", current.vault.id, secret.id, secret.version, current.vault.vek_version),
        );
        try {
          secrets.push({
            id: secret.id,
            version: secret.version + 1,
            envelope: await seal(
              newKey,
              plaintext,
              aad("secret", current.vault.id, secret.id, secret.version + 1, next),
            ),
          });
        } finally {
          plaintext.fill(0);
        }
        assertCurrent(epoch);
      }
      const device_keys = [];
      for (const device of current.devices.filter(
        (d) => d.status === "active" && d.id !== revokeId,
      )) {
        device_keys.push({
          id: device.id,
          wrapped_vek: await wrapDevice(
            newKey,
            current.vault.id,
            device.id,
            next,
            device.public_key,
          ),
        });
      }
      const master_wrap = await seal(kek, newKey, aad("master", current.vault.id, next));
      assertCurrent(epoch);
      key();
      submitted = true;
      await api(
        "/vault/rotate",
        "POST",
        {
          vek_version: next,
          kdf: current.vault.kdf,
          master_wrap,
          secrets,
          device_keys,
          revoke_device_ids: revokeId ? [revokeId] : [],
        },
        current.vault.revision,
      );
      assertCurrent(epoch);
      const updated = await api<Snapshot>("/vault/snapshot");
      assertCurrent(epoch);
      if (updated.vault.vek_version !== next) {
        snapshot.value = updated;
        lock();
        return;
      }
      vek?.fill(0);
      vek = newKey.slice();
      snapshot.value = updated;
      const local = await storedDevice(current.vault.id);
      if (local?.deviceId === revokeId) {
        await forgetDevice(current.vault.id);
        trusted.value = false;
      }
    } catch (cause) {
      if (submitted && epoch === generation && !(cause instanceof ApiError && cause.status < 500)) {
        lock();
        notice.value =
          "Rotation status is uncertain. Refresh and unlock before making further changes.";
      }
      throw cause;
    } finally {
      kek.fill(0);
      oldKey?.fill(0);
      newKey.fill(0);
    }
  });
}
export const session = {
  phase,
  snapshot,
  busy,
  error,
  notice,
  trusted,
  visibility,
  boot,
  lock,
  perform,
  refresh,
  initialize,
  unlockPassword,
  savedUnlock: () => perform(unlockSaved),
  saveSecret,
  reveal,
  saveProfile,
  enroll,
  revoke,
  passwordChange,
  rotate,
  remove: (kind: "secrets" | "profiles", id: string) =>
    perform((epoch) => mutate(`/${kind}/${id}`, "DELETE", undefined, epoch)),
  rename: (id: string, name: string) =>
    perform((epoch) => mutate(`/devices/${id}`, "PATCH", { name }, epoch)),
  hide: () => {
    visibility.value++;
  },
  startLifecycle() {
    const activity = () => {
      if (Date.now() - lastActivity >= 15 * 60_000 && phase.value === "open") lock();
      lastActivity = Date.now();
    };
    const hidden = () => {
      if (document.hidden) visibility.value++;
      activity();
    };
    const timer = setInterval(() => {
      if (phase.value === "open" && Date.now() - lastActivity >= 15 * 60_000) lock();
    }, 1000);
    for (const event of ["pointerdown", "keydown", "scroll"])
      window.addEventListener(event, activity, { passive: true });
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", lock);
    return () => {
      clearInterval(timer);
      for (const event of ["pointerdown", "keydown", "scroll"])
        window.removeEventListener(event, activity);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", lock);
      lock();
    };
  },
};
