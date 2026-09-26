import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { chmod, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

const exec = promisify(execFile);
const version = process.env.HUSH_NPM_VERSION ?? "0.0.0-test";
const artifacts = resolve("dist/npm", version);

await test(
  "packed npm CLI installs and preserves native process behavior",
  { timeout: 120_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), "hush npm test "));
    const packages = new Map();
    const tarballs = new Map();
    const downloads = new Set();
    for (const file of await readdir(artifacts)) {
      if (!file.endsWith(".tgz")) continue;
      const { stdout } = await exec("tar", ["-xOf", join(artifacts, file), "package/package.json"]);
      const manifest = JSON.parse(stdout);
      assert.equal(manifest.version, version);
      assert.equal(manifest.scripts, undefined);
      packages.set(manifest.name, { manifest, file });
      tarballs.set(`/${file}`, await readFile(join(artifacts, file)));
    }
    assert.equal(packages.size, 4);
    // A local registry exercises npm's real optional-dependency/platform resolution
    // without requiring unpublished packages or touching the user's global install.
    let registry;
    const server = createServer((request, response) => {
      const path = decodeURIComponent(new URL(request.url, registry).pathname);
      if (tarballs.has(path)) {
        downloads.add(path);
        response.end(tarballs.get(path));
        return;
      }
      const entry = packages.get(path.slice(1));
      if (!entry) {
        response.writeHead(404);
        response.end('{"error":"not found"}');
        return;
      }
      const { manifest, file } = entry;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          name: manifest.name,
          "dist-tags": { latest: version },
          versions: {
            [version]: {
              ...manifest,
              dist: {
                tarball: `${registry}/${file}`,
                integrity: `sha512-${createHash("sha512")
                  .update(tarballs.get(`/${file}`))
                  .digest("base64")}`,
              },
            },
          },
        }),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    registry = `http://127.0.0.1:${server.address().port}`;
    try {
      const userconfig = join(temporary, "npmrc");
      await writeFile(userconfig, `registry=${registry}\n@txchen:registry=${registry}\n`);
      const env = {
        ...process.env,
        NPM_CONFIG_USERCONFIG: userconfig,
        NPM_CONFIG_CACHE: join(temporary, "cache"),
      };
      const prefix = join(temporary, "prefix");
      await exec(
        "npm",
        [
          "install",
          "--global",
          "--prefix",
          prefix,
          "--registry",
          registry,
          "--ignore-scripts",
          "--include=optional",
          "--no-audit",
          "--no-fund",
          `@txchen/hush@${version}`,
        ],
        { env },
      );
      const launcher = join(prefix, "bin", "hush");
      const { stdout, stderr } = await exec(launcher, ["version"], { env });
      assert.equal(stdout.trim(), `hush ${version}`);
      assert.equal(stderr, "");
      const target = `${process.platform}-${process.arch}`;
      assert.equal(
        downloads.size,
        2,
        "only entry package and native platform tarball should download",
      );
      assert.ok([...downloads].some((path) => path.includes(target)));
      const installed = join(prefix, "lib", "node_modules", "@txchen", "hush");
      const native = join(installed, "node_modules", "@txchen", `hush-${target}`);
      const binary = join(native, "bin", "hush");
      // Replace the binary only inside the disposable installation to observe
      // arguments, PID, environment, streams, exit status and signal delivery.
      await writeFile(binary, '#!/bin/sh\nexec "$HUSH_TEST_NODE" "$HUSH_TEST_HELPER" "$@"\n');
      await chmod(binary, 0o755);
      const helper = join(temporary, "helper.cjs");
      await writeFile(
        helper,
        `
      console.log(JSON.stringify({ pid: process.pid, args: process.argv.slice(2), cwd: process.cwd(), value: process.env.HUSH_TEST_VALUE }));
      if (process.argv[2] === "wait") { setInterval(() => {}, 1000); }
      else { process.stdin.pipe(process.stdout); process.stdin.on("end", () => { console.error("stderr preserved"); process.exitCode = 37; }); }
    `,
      );
      const helperEnv = {
        ...env,
        HUSH_TEST_NODE: process.execPath,
        HUSH_TEST_HELPER: helper,
        HUSH_TEST_VALUE: "value with spaces",
      };
      const args = ["exec", "profile with spaces", "--", "echo", "$(literal)", "", "中文"];
      const child = spawn(launcher, args, { env: helperEnv, cwd: temporary });
      const closed = once(child, "close");
      let output = "";
      let errors = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        errors += chunk;
      });
      child.stdin.end("stdin preserved\n");
      assert.deepEqual(await closed, [37, null]);
      const [info, echo] = output.trimEnd().split("\n");
      assert.deepEqual(JSON.parse(info), {
        pid: child.pid,
        args,
        cwd: await realpath(temporary),
        value: "value with spaces",
      });
      assert.equal(echo, "stdin preserved");
      assert.equal(errors, "stderr preserved\n");
      for (const signal of ["SIGINT", "SIGTERM"]) {
        const waiting = spawn(launcher, ["wait"], { env: helperEnv });
        const finished = once(waiting, "close");
        try {
          await once(waiting.stdout, "data", { signal: AbortSignal.timeout(5000) });
          waiting.kill(signal);
          assert.deepEqual(await finished, [null, signal]);
        } finally {
          waiting.kill("SIGKILL");
        }
      }
      const manifestPath = join(native, "package.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      await writeFile(manifestPath, JSON.stringify({ ...manifest, version: "0.0.0-wrong" }));
      await assert.rejects(
        exec(launcher, ["version"], { env }),
        (error) => error.code === 1 && /Version mismatch/.test(error.stderr),
      );
      await rm(native, { recursive: true });
      await assert.rejects(
        exec(launcher, ["version"], { env }),
        (error) => error.code === 1 && /--include=optional/.test(error.stderr),
      );
    } finally {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
