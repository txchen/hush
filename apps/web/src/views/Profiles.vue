<script setup lang="ts">
import { ref } from "vue";
import Panel from "../components/Panel.vue";
import { session } from "../lib/session";
import type { Profile } from "../../../service/src/vault/model";
const { snapshot, busy } = session;
const form = ref<{ id?: string; name: string; mappings: Profile["mappings"] }>();
const deleting = ref<Profile>();
function select(id: string, name: string) {
  if (!form.value) return;
  const index = form.value.mappings.findIndex((m) => m.secret_id === id);
  if (index >= 0) form.value.mappings.splice(index, 1);
  else
    form.value.mappings.push({
      secret_id: id,
      env_name: /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : "TOKEN",
    });
}
async function save() {
  if (
    form.value &&
    (await session.saveProfile(form.value.id, form.value.name, form.value.mappings))
  )
    form.value = undefined;
}
async function remove() {
  if (deleting.value && (await session.remove("profiles", deleting.value.id)))
    deleting.value = undefined;
}
</script>
<template>
  <div class="page-heading">
    <div>
      <h1>
        Profiles <span class="count">{{ snapshot?.profiles.length }}</span>
      </h1>
    </div>
    <button class="primary" :disabled="busy" @click="form = { name: '', mappings: [] }">
      + Add profile
    </button>
  </div>
  <div class="table-card table-scroll">
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Environment variables</th>
          <th>Secrets</th>
          <th class="actions-heading">Actions</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="profile in snapshot?.profiles" :key="profile.id">
          <td class="strong">{{ profile.name }}</td>
          <td>
            <div class="chips">
              <span
                v-for="mapping in profile.mappings"
                :key="mapping.env_name"
                class="subtle-badge mono"
                >{{ mapping.env_name }}</span
              ><span v-if="!profile.mappings.length" class="muted">—</span>
            </div>
          </td>
          <td>{{ profile.mappings.length }}</td>
          <td class="actions">
            <button
              @click="
                form = {
                  id: profile.id,
                  name: profile.name,
                  mappings: profile.mappings.map((m) => ({ ...m })),
                }
              "
            >
              Edit</button
            ><button class="danger-text" @click="deleting = profile">Delete</button>
          </td>
        </tr>
        <tr v-if="!snapshot?.profiles.length">
          <td colspan="4" class="empty">No profiles yet.</td>
        </tr>
      </tbody>
    </table>
  </div>
  <Panel v-if="form" :title="form.id ? 'Edit profile' : 'Add profile'" @close="form = undefined"
    ><form @submit.prevent="save">
      <label>Name<input v-model="form.name" required maxlength="128" placeholder="github" /></label>
      <div class="field-label">Secrets and environment names</div>
      <div class="mapping-list">
        <div v-for="secret in snapshot?.secrets" :key="secret.id" class="mapping">
          <label class="check"
            ><input
              type="checkbox"
              :checked="form.mappings.some((m) => m.secret_id === secret.id)"
              @change="select(secret.id, secret.name)"
            /><span class="mono">{{ secret.name }}</span></label
          ><template
            v-for="mapping in form.mappings.filter((m) => m.secret_id === secret.id)"
            :key="mapping.secret_id"
            ><input
              v-model="mapping.env_name"
              :aria-label="'Environment name for ' + secret.name"
              required
              pattern="[A-Za-z_][A-Za-z0-9_]*"
              maxlength="128"
          /></template>
        </div>
        <p v-if="!snapshot?.secrets.length" class="hint">Add a secret first.</p>
      </div>
      <div class="form-actions">
        <button type="button" @click="form = undefined">Cancel</button
        ><button class="primary" :disabled="busy">Save profile</button>
      </div>
    </form></Panel
  >
  <Panel v-if="deleting" title="Delete profile" @close="deleting = undefined"
    ><p>
      Delete <strong>{{ deleting.name }}</strong
      >? Its secrets will be kept.
    </p>
    <div class="form-actions">
      <button @click="deleting = undefined">Cancel</button
      ><button class="danger" :disabled="busy" @click="remove">Delete profile</button>
    </div></Panel
  >
</template>
