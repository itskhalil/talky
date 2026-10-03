#!/usr/bin/env node
// Tauri refuses to build when an @tauri-apps/* npm package and its Rust crate
// sit on different major/minor versions. That check only runs inside
// `tauri build`, which no pull-request workflow does, so a bump on one side
// alone reaches main and breaks every build (see PR #20 / #23).
//
// This compares the versions npm and cargo actually resolved -- package-lock.json
// against src-tauri/Cargo.lock -- and exits non-zero on any mismatched pair.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// npm package -> Rust crate. `@tauri-apps/api` is the frontend half of `tauri`
// itself; `@tauri-apps/cli` has no crate in this project and is left out.
const PAIRS = {
  "@tauri-apps/api": "tauri",
  "@tauri-apps/plugin-dialog": "tauri-plugin-dialog",
  "@tauri-apps/plugin-opener": "tauri-plugin-opener",
  "@tauri-apps/plugin-os": "tauri-plugin-os",
  "@tauri-apps/plugin-process": "tauri-plugin-process",
  "@tauri-apps/plugin-updater": "tauri-plugin-updater",
};

function npmVersions() {
  const lock = JSON.parse(
    readFileSync(join(repoRoot, "package-lock.json"), "utf8"),
  );
  const versions = {};
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    const name = path.startsWith("node_modules/")
      ? path.slice("node_modules/".length)
      : null;
    if (name && name in PAIRS && entry.version) versions[name] = entry.version;
  }
  return versions;
}

function crateVersions() {
  const lock = readFileSync(join(repoRoot, "src-tauri", "Cargo.lock"), "utf8");
  const versions = {};
  for (const block of lock.split("[[package]]")) {
    const name = block.match(/^name = "(.+)"$/m)?.[1];
    const version = block.match(/^version = "(.+)"$/m)?.[1];
    if (name && version) versions[name] = version;
  }
  return versions;
}

const minor = (v) => v.split(".").slice(0, 2).join(".");

const npm = npmVersions();
const crates = crateVersions();
const mismatches = [];
const checked = [];

for (const [pkg, crate] of Object.entries(PAIRS)) {
  const npmVersion = npm[pkg];
  const crateVersion = crates[crate];
  if (!npmVersion || !crateVersion) continue; // dependency not used by this project
  const row = `${crate} (v${crateVersion}) : ${pkg} (v${npmVersion})`;
  if (minor(npmVersion) === minor(crateVersion)) checked.push(row);
  else mismatches.push(row);
}

if (mismatches.length > 0) {
  console.error(
    "Found version mismatched Tauri packages. The NPM package and Rust",
  );
  console.error(
    "crate must be on the same major/minor release, or `tauri build` fails:\n",
  );
  for (const row of mismatches) console.error(`  ${row}`);
  console.error(
    "\nRaise whichever side is behind, then regenerate its lockfile.",
  );
  process.exit(1);
}

console.log(`Tauri npm/crate versions agree (${checked.length} pairs):`);
for (const row of checked) console.log(`  ${row}`);
