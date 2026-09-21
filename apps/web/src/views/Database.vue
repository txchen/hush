<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import Panel from "../components/Panel.vue";
import { api, message } from "../lib/api";
import { session } from "../lib/session";
type Column = { name: string; type: string; pk: number; hidden: number };
type Table = {
  table: string;
  columns: Column[];
  rows: Record<string, unknown>[];
  total: number;
  offset: number;
  limit: number;
};
const tables = ref<string[]>([]);
const selected = ref("vault");
const result = ref<Table>();
const loading = ref(false);
const page = ref(0);
const cell = ref<{ name: string; raw: string; pretty?: string }>();
const formatted = ref(true);
let requestId = 0;
async function load() {
  const id = ++requestId;
  loading.value = true;
  try {
    const data = await api<Table>(
      `/database/${encodeURIComponent(selected.value)}?offset=${page.value * 50}`,
    );
    if (id === requestId) result.value = data;
  } catch (cause) {
    session.error.value = message(cause);
  } finally {
    if (id === requestId) loading.value = false;
  }
}
onMounted(async () => {
  try {
    tables.value = (await api<{ tables: string[] }>("/database")).tables;
    await load();
  } catch (cause) {
    session.error.value = message(cause);
  }
});
watch(selected, () => {
  page.value = 0;
  result.value = undefined;
  void load();
});
watch(page, () => {
  void load();
});
function raw(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value);
}
function inspect(name: string, value: unknown) {
  const text = raw(value);
  let pretty: string | undefined;
  try {
    pretty = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    /* Not every stored value is JSON. */
  }
  cell.value = { name, raw: text, pretty };
  formatted.value = Boolean(pretty);
}
async function copy() {
  if (!cell.value) return;
  try {
    await navigator.clipboard.writeText(cell.value.raw);
    session.notice.value = "Raw value copied.";
  } catch {
    session.error.value = "Clipboard access unavailable.";
  }
}
</script>
<template>
  <div class="page-heading">
    <div>
      <h1>Database <span class="badge neutral">Read-only</span></h1>
    </div>
    <button :disabled="loading" @click="load">Refresh</button>
  </div>
  <div class="database-layout">
    <nav class="table-list" aria-label="Database tables">
      <button
        v-for="table in tables"
        :key="table"
        :class="{ selected: selected === table }"
        @click="selected = table"
      >
        {{ table }}
      </button>
    </nav>
    <section class="table-card database-table">
      <div class="table-toolbar">
        <strong class="mono">{{ selected }}</strong
        ><span class="small muted">{{ result?.total ?? "…" }} rows</span>
      </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th v-for="column in result?.columns" :key="column.name">
                <span>{{ column.name }}<span v-if="column.pk" class="pk">PK</span></span
                ><small class="column-type"
                  >{{ column.type }}{{ column.hidden ? " · generated" : "" }}</small
                >
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, index) in result?.rows" :key="index">
              <td v-for="column in result?.columns" :key="column.name" class="db-cell">
                <button
                  class="raw-cell mono"
                  :aria-label="'Inspect ' + column.name + ' in row ' + (index + 1)"
                  @click="inspect(column.name, row[column.name])"
                >
                  {{ row[column.name] === null ? "NULL" : raw(row[column.name]) }}
                </button>
              </td>
            </tr>
            <tr v-if="!result?.rows.length">
              <td :colspan="result?.columns.length ?? 1" class="empty">
                {{ loading ? "Loading…" : "No rows." }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="table-toolbar pagination">
        <span class="small muted"
          >{{ result?.rows.length ? page * 50 + 1 : 0 }}–{{
            page * 50 + (result?.rows.length ?? 0)
          }}
          of {{ result?.total ?? 0 }}</span
        >
        <div>
          <button :disabled="loading || page === 0" @click="page--">Previous</button
          ><button :disabled="loading || (page + 1) * 50 >= (result?.total ?? 0)" @click="page++">
            Next
          </button>
        </div>
      </div>
    </section>
  </div>
  <Panel v-if="cell" :title="cell.name" wide @close="cell = undefined"
    ><div class="cell-toolbar">
      <label v-if="cell.pretty" class="check"
        ><input v-model="formatted" type="checkbox" />Format JSON</label
      ><span v-else class="small muted">Stored value</span
      ><button @click="copy">Copy raw value</button>
    </div>
    <pre class="raw-value">{{ formatted && cell.pretty ? cell.pretty : cell.raw }}</pre>
  </Panel>
</template>
