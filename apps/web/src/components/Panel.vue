<script setup lang="ts">
import { onMounted, ref } from "vue";
import { session } from "../lib/session";
defineProps<{ title: string; wide?: boolean }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
onMounted(() => dialog.value?.showModal());
</script>
<template>
  <dialog ref="dialog" :class="{ wide }" @cancel.prevent="emit('close')">
    <header class="panel-header">
      <h2>{{ title }}</h2>
      <button class="icon-button" aria-label="Close dialog" @click="emit('close')">×</button>
    </header>
    <div class="panel-body">
      <p v-if="session.error.value" class="error" role="alert">{{ session.error.value }}</p>
      <slot />
    </div>
  </dialog>
</template>
