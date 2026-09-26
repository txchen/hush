import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const version = process.argv[2];
const dryRun = process.argv[3] === "--dry-run";
if (
  !version ||
  !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version) ||
  process.argv.length > 4 ||
  (process.argv[3] && !dryRun)
) {
  throw new Error("Usage: node scripts/publish-cli-npm.mjs VERSION [--dry-run]");
}
const registry = "https://registry.npmjs.org/";
// Publish every platform before the entry point makes this version discoverable.
const names = ["hush-linux-x64", "hush-linux-arm64", "hush-darwin-arm64", "hush"];
const artifacts = names.map((name) => {
  const file = resolve("dist/npm", version, `txchen-${name}-${version}.tgz`);
  return {
    name: `@txchen/${name}`,
    file,
    integrity: `sha512-${createHash("sha512").update(readFileSync(file)).digest("base64")}`,
  };
});
for (const { name, file, integrity } of artifacts) {
  if (!dryRun) {
    let published;
    try {
      published = JSON.parse(
        execFileSync(
          "npm",
          ["view", `${name}@${version}`, "dist.integrity", "--json", "--registry", registry],
          { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] },
        ),
      );
    } catch (error) {
      let code;
      try {
        code = JSON.parse(error.stdout).error?.code;
      } catch {
        /* Non-JSON failures must stop publishing. */
      }
      if (code !== "E404") throw error;
    }
    if (published) {
      if (published !== integrity)
        throw new Error(
          `${name}@${version} already exists with different contents; use a new version.`,
        );
      console.log(`Already published: ${name}@${version}`);
      continue;
    }
  }
  execFileSync(
    "npm",
    [
      "publish",
      file,
      "--access",
      "public",
      "--registry",
      registry,
      "--tag",
      version.includes("-") ? "next" : "latest",
      ...(dryRun ? ["--dry-run"] : []),
    ],
    { stdio: "inherit" },
  );
}
