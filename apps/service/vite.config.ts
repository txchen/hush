import { defineConfig } from "vite-plus";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ACCESS_TEAM_DOMAIN: "hush-test.cloudflareaccess.com",
          ACCESS_AUDIENCE: "hush-test-audience",
          OWNER_EMAIL: "owner@example.com",
          ADMIN_ORIGIN: "https://hush.example.com",
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
        },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"], fileParallelism: false, testTimeout: 30_000 },
});
