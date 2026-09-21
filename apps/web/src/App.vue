<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from "vue";
import { useRoute } from "vue-router";
import Icon from "./components/Icon.vue";
import Gate from "./components/Gate.vue";
import { session } from "./lib/session";
const { phase, snapshot, busy, error, notice } = session;
const route = useRoute();
const navigation = ["Secrets", "Profiles", "Devices", "Database", "Settings"];
const vaultName = computed(() => snapshot.value?.vault.name ?? "Personal vault");
let cleanup: (() => void) | undefined;
onMounted(() => {
  cleanup = session.startLifecycle();
  void session.boot();
});
onUnmounted(() => cleanup?.());
watch(
  () => route.path,
  () => {
    session.hide();
    error.value = "";
    notice.value = "";
    document.title = `${String(route.meta.title ?? "Vault")} · Hush`;
  },
);
</script>
<template>
  <div class="shell">
    <aside class="sidebar">
      <a class="brand" href="/secrets"
        ><span class="brand-mark">H</span>hush<span class="brand-label">VAULT</span></a
      >
      <div class="vault-label">
        <span class="status-dot" :class="{ active: phase === 'open' }" />{{ vaultName }}
      </div>
      <nav aria-label="Main navigation">
        <template v-for="item in navigation" :key="item"
          ><RouterLink v-if="phase === 'open'" :to="'/' + item.toLowerCase()"
            ><Icon :name="item.toLowerCase()" />{{ item
            }}<span v-if="item === 'Secrets'" class="nav-count">{{
              snapshot?.secrets.length
            }}</span></RouterLink
          ><span v-else class="nav-disabled"
            ><Icon :name="item.toLowerCase()" />{{ item }}</span
          ></template
        >
      </nav>
      <div class="sidebar-bottom">
        <span class="owner-avatar">O</span>
        <div>
          <strong>Owner</strong
          ><small>{{ phase === "open" ? "Vault unlocked" : "Vault locked" }}</small>
        </div>
      </div>
    </aside>
    <div class="workspace">
      <header class="topbar">
        <div>
          <span class="muted">{{ vaultName }}</span
          ><span class="slash">/</span><strong>{{ route.meta.title ?? "Secrets" }}</strong>
        </div>
        <div class="topbar-actions">
          <button
            v-if="phase === 'open'"
            class="icon-button"
            aria-label="Lock vault"
            title="Lock vault"
            @click="session.lock()"
          >
            <Icon name="lock" />
          </button>
          <button
            v-if="phase === 'open'"
            class="icon-button"
            aria-label="Refresh vault"
            :disabled="busy"
            @click="session.perform((epoch) => session.refresh(epoch))"
          >
            <Icon name="refresh" />
          </button>
        </div>
      </header>
      <main>
        <div v-if="error" class="banner error" role="alert">
          {{ error }}<button aria-label="Dismiss error" @click="error = ''">×</button>
        </div>
        <div v-if="notice" class="banner" role="status">{{ notice }}</div>
        <RouterView v-if="phase === 'open'" /><Gate v-else />
      </main>
    </div>
  </div>
</template>
