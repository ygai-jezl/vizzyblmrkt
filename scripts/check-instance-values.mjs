#!/usr/bin/env node
// npm run check:instance: fails when the code names one particular hosted copy of YouGrow
// (our domains, Google Cloud projects, tenants, App Hosting address or Google Analytics id).
// Those belong in config, so anyone can run their own copy. Files that may name them, with
// the reason, are listed in scripts/instance-values.allow.
//
//   npm run check:instance              check every file git knows about (tracked or new)
//   npm run check:instance -- --stale   also list allowlist entries that no longer match a hit
//
// Node built-ins only. Exit 0 when clean, 1 when something names our instance, 2 on a bad allowlist.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { allowedBy, findInstanceValues, parseAllowList } from "./lib/instance-values.mjs";
import { REPO_ROOT } from "./lib/local-env.mjs";

const ALLOW_FILE = "scripts/instance-values.allow";
const MAX_BYTES = 5 * 1024 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules", ".next", ".local", ".venv", "dist", "coverage", "__pycache__"]);

/** Every file git would commit: tracked plus new and not ignored. Falls back to a walk without git. */
function repoFiles() {
  try {
    const out = execFileSync("git", ["-C", REPO_ROOT, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return [...new Set(out.split("\0").filter(Boolean))];
  } catch {
    const files = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
        } else if (entry.isFile()) {
          files.push(relative(REPO_ROOT, join(dir, entry.name)).split(sep).join("/"));
        }
      }
    };
    walk(REPO_ROOT);
    return files;
  }
}

/** File text, or null for a binary, oversized, deleted or unreadable file. */
function readText(path) {
  try {
    const abs = join(REPO_ROOT, path);
    if (statSync(abs).size > MAX_BYTES) return null;
    const buf = readFileSync(abs);
    if (buf.subarray(0, 8000).includes(0)) return null;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

function main() {
  const showStale = process.argv.includes("--stale");
  const allowText = readText(ALLOW_FILE);
  if (allowText === null) {
    process.stderr.write(`Can't read ${ALLOW_FILE}.\n`);
    process.exit(2);
  }
  const { entries, errors } = parseAllowList(allowText);
  if (errors.length) {
    process.stderr.write(`${ALLOW_FILE}:\n${errors.map((e) => `  ${e}`).join("\n")}\n`);
    process.exit(2);
  }

  const used = new Set();
  const problems = [];
  let scanned = 0;
  for (const path of repoFiles()) {
    if (path === ALLOW_FILE) continue;
    const text = readText(path);
    if (text === null) continue;
    scanned++;
    const hits = findInstanceValues(text);
    if (hits.length === 0) continue;
    const entry = allowedBy(path, entries);
    if (entry) {
      used.add(entry);
      continue;
    }
    for (const h of hits) problems.push(`${path}:${h.line}:${h.column}  ${h.value}  (${h.pattern})`);
  }

  if (showStale) {
    const stale = entries.filter((e) => !used.has(e));
    if (stale.length) {
      process.stdout.write(`Allowlist entries with nothing to allow (remove them when the reason has gone):\n`);
      for (const e of stale) process.stdout.write(`  ${ALLOW_FILE}:${e.line}  ${e.glob}\n`);
    }
  }

  if (problems.length === 0) {
    process.stdout.write(`check:instance: no instance values in ${scanned} files (${entries.length} allowlist entries).\n`);
    return;
  }
  process.stderr.write(`check:instance: ${problems.length} instance value(s) in code that should come from config:\n`);
  for (const p of problems) process.stderr.write(`  ${p}\n`);
  process.stderr.write(
    `\nRead the value from an environment variable instead (add it to .env.example, and our value to apphosting.yaml).\n` +
      `If the file really is about our own hosting, add its path to ${ALLOW_FILE} with the reason.\n`,
  );
  process.exit(1);
}

main();
