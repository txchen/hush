<script setup lang="ts">
defineProps<{ name: string }>();
const paths: Record<string, string> = {
  secrets: "M8 10V7a4 4 0 0 1 8 0v3M6 10h12v11H6zM12 14v3",
  profiles: "M3 6h7l2 2h9v12H3zM3 6V4h7l2 2h9v2",
  devices: "M3 4h18v12H3zM8 21h8M12 16v5",
  database:
    "M20 5c0 2-4 3-8 3S4 7 4 5s4-3 8-3 8 1 8 3zM4 5v14c0 2 4 3 8 3s8-1 8-3V5M4 12c0 2 4 3 8 3s8-1 8-3",
  settings:
    "M12 3v3m0 12v3M3 12h3m12 0h3M6 6l2 2m8 8 2 2M6 18l2-2m8-8 2-2M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  lock: "M8 10V7a4 4 0 0 1 8 0v3M6 10h12v11H6z",
  refresh: "M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3",
};
</script>
<template>
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="paths[name] || paths.secrets" />
  </svg>
</template>
