#!/usr/bin/env node
"use strict";

const { accessSync, constants } = require("node:fs");
const path = require("node:path");
const manifest = require("./package.json");

function main() {
  const target = `${process.platform}-${process.arch}`;
  const name = `${manifest.name}-${target}`;
  if (!manifest.optionalDependencies[name]) {
    throw new Error(
      `Unsupported platform: ${target}. See https://github.com/txchen/hush#install-the-cli`,
    );
  }
  if (Number(process.versions.node.split(".")[0]) < 24 || typeof process.execve !== "function") {
    throw new Error(
      "The npm launcher requires Node.js 24+. Upgrade Node.js or install a standalone Hush binary.",
    );
  }
  let packagePath;
  try {
    packagePath = require.resolve(`${name}/package.json`);
  } catch {
    throw new Error(
      `Missing ${name}. Reinstall with: npm install -g ${manifest.name}@${manifest.version} --include=optional`,
    );
  }
  if (require(packagePath).version !== manifest.version) {
    throw new Error(
      `Version mismatch for ${name}; reinstall ${manifest.name}@${manifest.version}.`,
    );
  }
  const binary = path.join(packagePath, "..", "bin", "hush");
  accessSync(binary, constants.X_OK);
  // Replace this launcher: preserve PID, terminal, signals and exit status.
  process.execve(binary, [binary, ...process.argv.slice(2)], process.env);
}

try {
  main();
} catch (error) {
  console.error(`hush: ${error.message}`);
  process.exitCode = 1;
}
