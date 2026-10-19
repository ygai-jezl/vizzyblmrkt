#!/usr/bin/env node
// Print the settings one App Hosting backend ends up with: apphosting.yaml, with
// apphosting.<env>.yaml merged over it when that file exists.
//
//   node scripts/config/resolve-apphosting.mjs --env dev
//   node scripts/config/resolve-apphosting.mjs --env prod --json
//   node scripts/config/resolve-apphosting.mjs --env prod --compare main
//   node scripts/config/resolve-apphosting.mjs --env prod --overlay ../deploy/apphosting.prod.yaml \
//     --compare-files 956de68:apphosting.yaml 956de68:apphosting.prod.yaml --classify
//
// Options:
//   --env <name>       required. The overlay is apphosting.<name>.yaml (none if it doesn't exist).
//   --base <file>      the base file (default apphosting.yaml).
//   --overlay <file>   the overlay file (default apphosting.<env>.yaml). "none" for base only.
//   --json             print JSON instead of one line per setting.
//   --compare <ref>    resolve the same files from a git ref and print what differs.
//   --compare-files <base> <overlay|none>
//                      resolve these two files as the "before" side instead.
//   --classify         with a compare: list switches that are now "false" where they were
//                      unset apart from the real differences. The code reads every switch
//                      as === "true", so those behave exactly the same. Only real
//                      differences make it exit 1.
//
// Any file can be a path or <git ref>:<path in the repository>, e.g. 956de68:apphosting.yaml.
// A compare exits 1 when anything (anything real, with --classify) differs, 0 when nothing
// does. The output is sorted, so two runs can be diffed. Secrets are only ever names here.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { classifyChanges, diffResolved, formatDiff, formatResolved, mergeApphosting, toJson } from "./apphosting-merge.mjs";
import { codeFeatureSwitches } from "./feature-switches.mjs";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");

function usage(message) {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write(
    "Usage: node scripts/config/resolve-apphosting.mjs --env <name> [--base apphosting.yaml] [--overlay apphosting.<name>.yaml|none]\n" +
      "         [--json] [--compare <git ref> | --compare-files <base> <overlay|none>] [--classify]\n" +
      "Any file can be a path or <git ref>:<path>.\n",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const opts = { env: null, base: null, overlay: null, json: false, compare: null, compareFiles: null, classify: false };
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
    else if (arg === "--compare-files") opts.compareFiles = { base: next(), overlay: next() };
    else if (arg === "--classify") opts.classify = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--help" || arg === "-h") usage();
    else usage(`Unknown option: ${arg}`);
  }
  if (!opts.env) usage("--env is required (for example --env dev or --env prod).");
  if (!/^[A-Za-z0-9_-]+$/.test(opts.env)) usage(`--env ${opts.env} is not a valid environment name.`);
  if (opts.compare && opts.compareFiles) usage("Use --compare or --compare-files, not both.");
  if (opts.classify && !opts.compare && !opts.compareFiles) usage("--classify needs --compare or --compare-files.");
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

/** `file` as it was at git `ref`, or null when it doesn't exist there. */
function gitShow(ref, file) {
  const abs = isAbsolute(file) ? file : resolve(repoRoot, file);
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
}

/**
 * Reads a file named on the command line: a path (relative to where you run this), or
 * <git ref>:<path in the repository> when no such file exists on disk. Missing → null.
 */
function readSpec(spec) {
  const path = isAbsolute(spec) ? spec : resolve(process.cwd(), spec);
  if (existsSync(path)) return readFileSync(path, "utf8");
  const at = spec.indexOf(":");
  if (at > 0) return gitShow(spec.slice(0, at), spec.slice(at + 1));
  return null;
}

/** Reads every file as it was at a git ref (for --compare). Missing at that ref → null. */
function gitReader(ref) {
  return (file) => gitShow(ref, isAbsolute(file) ? file : resolve(process.cwd(), file));
}

/**
 * Resolves one backend. `files` names the base and overlay ("none", or null for the
 * default apphosting.<env>.yaml, which may simply not exist).
 */
function resolveWith(read, files, env, label) {
  // Defaults live at the repository root; paths given on the command line are relative to here.
  const baseFile = files.base ?? join(repoRoot, "apphosting.yaml");
  const baseText = read(baseFile);
  if (baseText === null) throw new Error(`${label}: ${baseFile} not found.`);
  const base = parseYaml(baseText, `${label} ${baseFile}`);
  let overlay = null;
  let overlayFile = null;
  if (files.overlay !== "none") {
    overlayFile = files.overlay ?? join(repoRoot, `apphosting.${env}.yaml`);
    const overlayText = read(overlayFile);
    if (overlayText === null) {
      // An explicit overlay that doesn't exist is a mistake; the default one may simply not exist.
      if (files.overlay) throw new Error(`${label}: ${files.overlay} not found.`);
      overlayFile = null;
    } else {
      overlay = parseYaml(overlayText, `${label} ${overlayFile}`);
    }
  }
  const resolved = mergeApphosting(base, overlay);
  for (const w of resolved.warnings) process.stderr.write(`warning (${label}): ${w}\n`);
  return { resolved, baseFile, overlayFile };
}

/** A short name for one side of a compare, for the report. */
function describe(side) {
  const name = (f) => (f && isAbsolute(f) && f.startsWith(`${repoRoot}/`) ? relative(repoRoot, f) : f);
  return side.overlayFile ? `${name(side.baseFile)} + ${name(side.overlayFile)}` : `${name(side.baseFile)} alone`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const now = resolveWith(readSpec, { base: opts.base, overlay: opts.overlay }, opts.env, "now");

  if (!opts.compare && !opts.compareFiles) {
    if (opts.json) {
      const overlay = now.overlayFile ? relative(repoRoot, resolve(now.overlayFile)) : null;
      process.stdout.write(`${JSON.stringify({ environment: opts.env, overlay, ...toJson(now.resolved) }, null, 2)}\n`);
    } else {
      process.stdout.write(`${formatResolved(now.resolved)}\n`);
    }
    return;
  }

  const then = opts.compare
    ? resolveWith(gitReader(opts.compare), { base: opts.base, overlay: opts.overlay }, opts.env, opts.compare)
    : resolveWith(readSpec, opts.compareFiles, opts.env, "before");
  const thenLabel = opts.compare ? `${opts.compare} (${describe(then)})` : describe(then);
  const nowLabel = describe(now);
  const changes = diffResolved(then.resolved, now.resolved);

  if (!opts.classify) {
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ environment: opts.env, before: thenLabel, after: nowLabel, changes }, null, 2)}\n`);
    } else if (changes.length === 0) {
      process.stdout.write(`No differences for --env ${opts.env} between ${thenLabel} and ${nowLabel}.\n`);
    } else {
      process.stdout.write(`${changes.length} difference(s) for --env ${opts.env} between ${thenLabel} and ${nowLabel}:\n`);
      process.stdout.write(`${formatDiff(changes)}\n`);
    }
    process.exit(changes.length === 0 ? 0 : 1);
  }

  const { real, switchOff } = classifyChanges(changes, now.resolved, codeFeatureSwitches(repoRoot));
  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({ environment: opts.env, before: thenLabel, after: nowLabel, real, switchOff }, null, 2)}\n`,
    );
  } else {
    const lines = [
      `--env ${opts.env}`,
      `  before: ${thenLabel}`,
      `  after:  ${nowLabel}`,
      `Real differences: ${real.length}`,
    ];
    if (real.length) lines.push(formatDiff(real));
    lines.push(`Switches now "false" that were unset (same behaviour, read as === "true"): ${switchOff.length}`);
    if (switchOff.length) lines.push(formatDiff(switchOff));
    process.stdout.write(`${lines.join("\n")}\n`);
  }
  process.exit(real.length === 0 ? 0 : 1);
}

try {
  main();
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(2);
}
