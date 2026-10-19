#!/usr/bin/env node
// Print the settings one App Hosting backend ends up with: apphosting.yaml, with
// apphosting.<env>.yaml merged over it when that file exists.
//
//   node scripts/config/resolve-apphosting.mjs --env dev
//   node scripts/config/resolve-apphosting.mjs --env prod --json
//   node scripts/config/resolve-apphosting.mjs --env prod --compare main
//
// Options:
//   --env <name>       required. The overlay is apphosting.<name>.yaml (none if it doesn't exist).
//   --base <file>      the base file (default apphosting.yaml).
//   --overlay <file>   the overlay file (default apphosting.<env>.yaml). "none" for base only.
//   --json             print JSON instead of one line per setting.
//   --compare <ref>    resolve the same files from a git ref and print what differs.
//                      Exits 1 when anything differs, 0 when nothing does.
//
// The output is sorted, so two runs can be diffed. Secrets are only ever names here.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { diffResolved, formatDiff, formatResolved, mergeApphosting, toJson } from "./apphosting-merge.mjs";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");

function usage(message) {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write(
    "Usage: node scripts/config/resolve-apphosting.mjs --env <name> [--base apphosting.yaml] [--overlay apphosting.<name>.yaml|none] [--json] [--compare <git ref>]\n",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { env: null, base: null, overlay: null, json: false, compare: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const val = argv[++i];
      if (val === undefined || val.startsWith("--")) usage(`${arg} needs a value.`);
      return val;
    };
    if (arg === "--env") opts.env = next();
    else if (arg === "--base") opts.base = next();
    else if (arg === "--overlay") opts.overlay = next();
    else if (arg === "--compare") opts.compare = next();
    else if (arg === "--json") opts.json = true;
    else if (arg === "--help" || arg === "-h") usage();
    else usage(`Unknown option: ${arg}`);
  }
  if (!opts.env) usage("--env is required (for example --env dev or --env prod).");
  if (!/^[A-Za-z0-9_-]+$/.test(opts.env)) usage(`--env ${opts.env} is not a valid environment name.`);
  return opts;
}

/** The repository this script lives in (scripts/config/ → the root), wherever it's run from. */
const repoRoot = fileURLToPath(new URL("../..", import.meta.url)).replace(/[\\/]+$/, "");

function parseYaml(text, label) {
  try {
    return yaml.load(text) ?? {};
  } catch (err) {
    throw new Error(`${label}: not valid YAML (${err.message})`);
  }
}

/** Reads files from the working tree. */
function workingTreeReader(file) {
  const path = isAbsolute(file) ? file : resolve(process.cwd(), file);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

/** Reads files as they were at a git ref. Missing at that ref → null. */
function gitReader(ref) {
  return (file) => {
    const abs = isAbsolute(file) ? file : resolve(process.cwd(), file);
    const rel = relative(repoRoot, abs).split("\\").join("/");
    if (rel.startsWith("..")) throw new Error(`${file} is outside the repository, so it can't be read from ${ref}.`);
    try {
      return execFileSync("git", ["-C", repoRoot, "show", `${ref}:${rel}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch (err) {
      const stderr = String(err.stderr || "");
      if (/does not exist|exists on disk, but not in/.test(stderr)) return null;
      throw new Error(`git show ${ref}:${rel} failed: ${stderr.trim() || err.message}`);
    }
  };
}

function resolveWith(read, opts, label) {
  // Defaults live at the repository root; paths given on the command line are relative to here.
  const baseFile = opts.base ?? join(repoRoot, "apphosting.yaml");
  const baseText = read(baseFile);
  if (baseText === null) throw new Error(`${label}: ${baseFile} not found.`);
  const base = parseYaml(baseText, `${label} ${baseFile}`);
  let overlay = null;
  let overlayFile = null;
  if (opts.overlay !== "none") {
    overlayFile = opts.overlay ?? join(repoRoot, `apphosting.${opts.env}.yaml`);
    const overlayText = read(overlayFile);
    if (overlayText === null) {
      // An explicit --overlay that doesn't exist is a mistake; the default one may simply not exist (dev).
      if (opts.overlay) throw new Error(`${label}: ${opts.overlay} not found.`);
      overlayFile = null;
    } else {
      overlay = parseYaml(overlayText, `${label} ${overlayFile}`);
    }
  }
  const resolved = mergeApphosting(base, overlay);
  for (const w of resolved.warnings) process.stderr.write(`warning (${label}): ${w}\n`);
  return { resolved, overlayFile };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const now = resolveWith(workingTreeReader, opts, "working tree");

  if (!opts.compare) {
    if (opts.json) {
      const overlay = now.overlayFile ? relative(repoRoot, resolve(now.overlayFile)) : null;
      process.stdout.write(`${JSON.stringify({ environment: opts.env, overlay, ...toJson(now.resolved) }, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatResolved(now.resolved)}\n`);
    }
    return;
  }

  const then = resolveWith(gitReader(opts.compare), opts, opts.compare);
  const changes = diffResolved(then.resolved, now.resolved);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ environment: opts.env, ref: opts.compare, changes }, null, 2)}\n`);
  } else if (changes.length === 0) {
    process.stdout.write(`No differences for --env ${opts.env} between ${opts.compare} and the working tree.\n`);
  } else {
    process.stdout.write(`${changes.length} difference(s) for --env ${opts.env} between ${opts.compare} and the working tree:\n`);
    process.stdout.write(`${formatDiff(changes)}\n`);
  }
  process.exit(changes.length === 0 ? 0 : 1);
}

try {
  main();
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(2);
}
