import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { bindings, defineConfig } from "cf/config";

type Deployment = {
  accountId: string;
  domain: string;
  databaseId: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUDIENCE: string;
  OWNER_EMAIL: string;
  ADMIN_ORIGIN: string;
};

export default defineConfig(({ mode }) => {
  // Production values stay in an ignored, operator-owned file.
  const deployment: Deployment | undefined =
    mode === "production"
      ? JSON.parse(readFileSync(new URL("./deployment.local.json", import.meta.url), "utf8"))
      : undefined;
  if (mode === "production") {
    const required: (keyof Deployment)[] = [
      "accountId",
      "domain",
      "databaseId",
      "ACCESS_TEAM_DOMAIN",
      "ACCESS_AUDIENCE",
      "OWNER_EMAIL",
      "ADMIN_ORIGIN",
    ];
    if (
      required.some(
        (key) =>
          typeof deployment?.[key] !== "string" ||
          !deployment[key].trim() ||
          deployment[key].startsWith("YOUR_"),
      )
    ) {
      throw new Error("Complete deployment.local.json before building for production.");
    }
  }
  return {
    accountId: deployment?.accountId,
    worker: {
      name: "hush-service",
      entrypoint: "src/index.ts",
      compatibilityDate: "2026-09-21",
      compatibilityFlags: ["nodejs_compat"],
      workersDev: false,
      previewUrls: false,
      observability: { enabled: true, headSamplingRate: 1 },
      assets: {
        notFoundHandling: "single-page-application",
        runWorkerFirst: ["/api/*"],
      },
      domains: deployment ? [deployment.domain] : [],
      env: {
        ACCESS_TEAM_DOMAIN: bindings.text(
          deployment?.ACCESS_TEAM_DOMAIN ?? "configure-me.cloudflareaccess.com",
        ),
        ACCESS_AUDIENCE: bindings.text(deployment?.ACCESS_AUDIENCE ?? "configure-me"),
        OWNER_EMAIL: bindings.text(deployment?.OWNER_EMAIL ?? "owner@example.invalid"),
        ADMIN_ORIGIN: bindings.text(deployment?.ADMIN_ORIGIN ?? "https://hush.example.invalid"),
        DB: bindings.d1({
          name: "hush",
          id: deployment?.databaseId ?? "00000000-0000-4000-8000-000000000000",
        }),
        ASSETS: bindings.assets(),
      },
    },
  };
});
