import { defineConfig } from "vite-plus";
import vue from "@vitejs/plugin-vue";
export default defineConfig({
  plugins: [vue()],
  server: { port: 5173, strictPort: true, proxy: { "/api": "http://127.0.0.1:8787" } },
  test: { include: ["test/**/*.test.ts"] },
  build: { sourcemap: false },
});
