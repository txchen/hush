<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import Panel from "../components/Panel.vue";
import { session } from "../lib/session";
import { api, message } from "../lib/api";
const { snapshot, busy, visibility } = session;
const action = ref<"password" | "rotate">();
const password = ref("");
const replacement = ref("");
const confirm = ref("");
const validation = ref("");
type Event = {
  sequence: number;
  action: string;
  actor_role: string;
  resource_id: string | null;
  created_at: string;
};
const events = ref<Event[]>([]);
const more = ref(false);
const auditBusy = ref(false);
function clear() {
  action.value = undefined;
  password.value = "";
  replacement.value = "";
  confirm.value = "";
  validation.value = "";
}
watch(visibility, clear);
async function load(reset = false) {
  if (auditBusy.value) return;
  auditBusy.value = true;
  try {
    const after = reset ? 0 : (events.value.at(-1)?.sequence ?? 0);
    const result = await api<{ events: Event[] }>(`/audit?after=${after}`);
    events.value = reset ? result.events : [...events.value, ...result.events];
    more.value = result.events.length === 100;
  } catch (cause) {
    session.error.value = message(cause);
  } finally {
    auditBusy.value = false;
  }
}
onMounted(() => {
  void load(true);
});
async function submit() {
  if (
    action.value === "password" &&
    (replacement.value.length < 16 || replacement.value !== confirm.value)
  ) {
    validation.value = "Use at least 16 characters and confirm the new password.";
    return;
  }
  const current = password.value;
  const next = replacement.value;
  password.value = "";
  replacement.value = "";
  confirm.value = "";
  const success =
    action.value === "password"
      ? await session.passwordChange(current, next)
      : await session.rotate(current);
  if (success) {
    clear();
    session.notice.value = "Vault security updated.";
    await load(true);
  }
}
</script>
<template>
  <div class="page-heading">
    <div><h1>Settings</h1></div>
  </div>
  <div class="settings-grid">
    <section class="card">
      <h2>Vault</h2>
      <dl>
        <dt>Name</dt>
        <dd>{{ snapshot?.vault.name }}</dd>
        <dt>Vault ID</dt>
        <dd class="mono small wrap">{{ snapshot?.vault.id }}</dd>
        <dt>Key version</dt>
        <dd>{{ snapshot?.vault.vek_version }}</dd>
        <dt>Revision</dt>
        <dd>{{ snapshot?.vault.revision }}</dd>
      </dl>
    </section>
    <section class="card">
      <h2>Security</h2>
      <div class="setting-row">
        <div>
          <strong>Master password</strong>
          <p>Replace the password wrapping your vault key.</p>
        </div>
        <button @click="action = 'password'">Change password</button>
      </div>
      <div class="setting-row">
        <div>
          <strong>Vault encryption key</strong>
          <p>Re-encrypt all secrets with a new key.</p>
        </div>
        <button @click="action = 'rotate'">Rotate key</button>
      </div>
      <p class="hint">Session locks after 15 minutes of inactivity.</p>
    </section>
  </div>
  <div class="section-heading">
    <h2>Audit log</h2>
    <button :disabled="auditBusy" @click="load(true)">Refresh</button>
  </div>
  <div class="table-card table-scroll">
    <table>
      <thead>
        <tr>
          <th>Time</th>
          <th>Action</th>
          <th>Actor</th>
          <th>Resource</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="event in events" :key="event.sequence">
          <td class="nowrap muted">{{ new Date(event.created_at).toLocaleString() }}</td>
          <td class="mono">{{ event.action }}</td>
          <td>{{ event.actor_role }}</td>
          <td class="mono small muted">{{ event.resource_id ?? "—" }}</td>
        </tr>
        <tr v-if="!events.length">
          <td colspan="4" class="empty">No audit events.</td>
        </tr>
      </tbody>
    </table>
    <div v-if="more" class="table-toolbar">
      <button :disabled="auditBusy" @click="load()">Load more</button>
    </div>
  </div>
  <Panel
    v-if="action"
    :title="action === 'password' ? 'Change master password' : 'Rotate vault key'"
    @close="clear"
    ><form @submit.prevent="submit">
      <p v-if="action === 'rotate'" class="hint">
        All secrets and active device keys will be re-encrypted together.
      </p>
      <label
        >Current master password<input
          v-model="password"
          type="password"
          autocomplete="current-password"
          required /></label
      ><template v-if="action === 'password'"
        ><label
          >New master password<input
            v-model="replacement"
            type="password"
            autocomplete="new-password"
            required
            minlength="16" /></label
        ><label
          >Confirm new password<input
            v-model="confirm"
            type="password"
            autocomplete="new-password"
            required /></label
      ></template>
      <p v-if="validation" class="error" role="alert">{{ validation }}</p>
      <div class="form-actions">
        <button type="button" @click="clear">Cancel</button
        ><button class="primary" :disabled="busy">
          {{ busy ? "Working…" : action === "password" ? "Change password" : "Rotate key" }}
        </button>
      </div>
    </form></Panel
  >
</template>
