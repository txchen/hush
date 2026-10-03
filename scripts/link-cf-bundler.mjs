// cf beta does not search workspace parents when locating its bundler.
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const serviceModules = fileURLToPath(new URL("../apps/service/node_modules/", import.meta.url));
const target = join(serviceModules, "wrangler");
if (!existsSync(target)) {
  const source = dirname(require.resolve("wrangler/package.json"));
  mkdirSync(serviceModules, { recursive: true });
  symlinkSync(
    process.platform === "win32" ? source : relative(serviceModules, source),
    target,
    process.platform === "win32" ? "junction" : "dir",
  );
}
