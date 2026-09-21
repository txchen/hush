<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { session } from "../lib/session";
import type { Secret } from "../../../service/src/vault/model";
import { message } from "../lib/api";
import Panel from "../components/Panel.vue";
const { snapshot, busy, visibility } = session;
const search = ref("");
const form = ref<{ id?: string; name: string; value: string }>();
const deleting = ref<Secret>();
const values = ref<Record<string, string>>({});
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const items = computed(
  () =>
    snapshot.value?.secrets.filter((s) =>
      s.name.toLowerCase().includes(search.value.toLowerCase()),
    ) ?? [],
);
function clear() {
  values.value = {};
  form.value = undefined;
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
}
watch(visibility, clear);
onUnmounted(clear);
async function reveal(secret: Secret) {
  if (values.value[secret.id] !== undefined) {
    delete values.value[secret.id];
    return;
  }
  try {
    values.value[secret.id] = await session.reveal(secret);
    timers.set(
      secret.id,
      setTimeout(() => delete values.value[secret.id], 30_000),
    );
  } catch (cause) {
    session.error.value = message(cause);
  }
}
async function copy(secret: Secret) {
  try {
    const value = await session.reveal(secret);
    await navigator.clipboard.writeText(value);
    session.notice.value = "Copied to clipboard.";
  } catch {
    session.error.value = "Could not copy. Check clipboard permissions.";
  }
}
async function edit(secret: Secret) {
  try {
    form.value = { id: secret.id, name: secret.name, value: await session.reveal(secret) };
  } catch (cause) {
    session.error.value = message(cause);
  }
}
async function save() {
  if (!form.value) return;
  const { id, name, value } = form.value;
  form.value.value = "";
  if (await session.saveSecret(id, name, value)) form.value = undefined;
}
async function remove() {
  if (deleting.value && (await session.remove("secrets", deleting.value.id)))
    deleting.value = undefined;
}
const profileCount = (id: string) =>
  snapshot.value?.profiles.filter((p) => p.mappings.some((m) => m.secret_id === id)).length ?? 0;
</script>
<template>
  <div class="page-heading">
    <div>
      <h1>
        Secrets <span class="count">{{ snapshot?.secrets.length }}</span>
      </h1>
    </div>
    <button class="primary" :disabled="busy" @click="form = { name: '', value: '' }">
      + Add secret
    </button>
  </div>
  <div class="table-card">
    <div class="table-toolbar">
      <input
        v-model="search"
        class="search"
        type="search"
        placeholder="Search secrets…"
        aria-label="Search secrets"
      /><span class="muted small">{{ items.length }} secrets</span>
    </div>
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Value</th>
            <th>Profiles</th>
            <th>Updated</th>
            <th class="actions-heading">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="secret in items" :key="secret.id">
            <td class="mono strong">{{ secret.name }}</td>
            <td class="secret-value mono" :class="{ revealed: values[secret.id] !== undefined }">
              {{ values[secret.id] ?? "••••••••••••" }}
            </td>
            <td>
              <span class="subtle-badge">{{ profileCount(secret.id) }}</span>
            </td>
            <td class="muted nowrap">{{ new Date(secret.updated_at).toLocaleDateString() }}</td>
            <td class="actions">
              <button :aria-label="'Reveal ' + secret.name" @click="reveal(secret)">
                {{ values[secret.id] !== undefined ? "Hide" : "Reveal" }}</button
              ><button :aria-label="'Copy ' + secret.name" @click="copy(secret)">Copy</button
              ><button :disabled="busy" @click="edit(secret)">Edit</button
              ><button class="danger-text" :disabled="busy" @click="deleting = secret">
                Delete
              </button>
            </td>
          </tr>
          <tr v-if="!items.length">
            <td colspan="5" class="empty">
              {{ search ? "No matching secrets." : "No secrets yet. Add your first secret." }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
  <Panel v-if="form" :title="form.id ? 'Edit secret' : 'Add secret'" @close="form = undefined"
    ><form @submit.prevent="save">
      <label
        >Name<input
          v-model="form.name"
          required
          maxlength="128"
          placeholder="GITHUB_TOKEN"
          autocomplete="off"
          spellcheck="false" /></label
      ><label
        >Value<textarea
          v-model="form.value"
          required
          rows="5"
          autocomplete="off"
          spellcheck="false"
        />
      </label>
      <div class="form-actions">
        <button type="button" @click="form = undefined">Cancel</button
        ><button class="primary" :disabled="busy">{{ busy ? "Saving…" : "Save secret" }}</button>
      </div>
    </form></Panel
  >
  <Panel v-if="deleting" title="Delete secret" @close="deleting = undefined"
    ><p>
      Delete <strong>{{ deleting.name }}</strong
      >?
    </p>
    <p v-if="profileCount(deleting.id)" class="error">
      Remove this secret from its profiles first.
    </p>
    <div class="form-actions">
      <button @click="deleting = undefined">Cancel</button
      ><button class="danger" :disabled="busy || profileCount(deleting.id) > 0" @click="remove">
        Delete secret
      </button>
    </div></Panel
  >
</template>
