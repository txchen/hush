import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: {
    ignorePatterns: ["**/worker-configuration.d.ts"],
    options: { typeAware: true },
    rules: { "typescript/no-floating-promises": "error" },
  },
  fmt: {
    ignorePatterns: ["**/worker-configuration.d.ts", "package-lock.json", "contracts/openapi.yaml"],
  },
});
