<script setup lang="ts">
import { ref } from "vue";
import { session } from "../lib/session";
const { phase, busy, trusted } = session;
const password = ref("");
const confirm = ref("");
const name = ref("Personal");
const trust = ref(false);
const validation = ref("");
async function submit() {
  validation.value = "";
  if (phase.value === "setup" && (password.value.length < 16 || password.value !== confirm.value)) {
    validation.value = "Use at least 16 characters and enter the same password twice.";
    return;
  }
  const value = password.value;
  password.value = "";
  confirm.value = "";
  if (phase.value === "setup") await session.initialize(name.value, value, trust.value);
  else await session.unlockPassword(value, trust.value);
}
</script>
<template>
  <section class="gate">
    <template v-if="phase === 'loading'"
      ><div class="spinner" />
      <h2>Opening vault</h2></template
    >
    <template v-else-if="phase === 'unavailable'"
      ><h2>Vault unavailable</h2>
      <p>Check the service configuration or sign in with your owner account.</p>
      <button @click="session.boot()" :disabled="busy">Try again</button></template
    >
    <template v-else>
      <div class="gate-mark">H</div>
      <h2>{{ phase === "setup" ? "Create your vault" : "Unlock vault" }}</h2>
      <button
        v-if="trusted && phase === 'locked'"
        class="primary saved-key"
        :disabled="busy"
        @click="session.savedUnlock()"
      >
        Unlock with this browser
      </button>
      <form @submit.prevent="submit">
        <label v-if="phase === 'setup'"
          >Vault name<input v-model="name" required maxlength="128" autocomplete="off"
        /></label>
        <label
          >Master password<input
            v-model="password"
            type="password"
            required
            :autocomplete="phase === 'setup' ? 'new-password' : 'current-password'"
            autofocus
        /></label>
        <label v-if="phase === 'setup'"
          >Confirm password<input
            v-model="confirm"
            type="password"
            required
            autocomplete="new-password"
        /></label>
        <label v-if="!trusted" class="check"
          ><input v-model="trust" type="checkbox" />Trust this browser</label
        >
        <p v-if="phase === 'setup'" class="hint">
          Use a long, unique password. There is no password reset.
        </p>
        <p v-if="validation" role="alert" class="error">{{ validation }}</p>
        <button class="primary full" :disabled="busy">
          {{ busy ? "Unlocking…" : phase === "setup" ? "Create vault" : "Unlock with password" }}
        </button>
      </form>
    </template>
  </section>
</template>
