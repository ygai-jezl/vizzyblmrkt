#!/usr/bin/env node
// The CLA check for one pull request: is everyone whose work is in it covered by a contributor
// licence agreement? .github/workflows/cla.yml runs it; the rules are in scripts/lib/cla.mjs.
//
//   node scripts/check-cla.mjs --repo <owner/name> --pr <number> [--summary <file>] [--trusted-dir <folder>]
//
// It reads through the gh CLI with GET requests only. gh takes its token from the environment
// it inherits (GH_TOKEN in the workflow step); this script reads no environment variable.
// Trusted files (docs/cla/policy.json and the signatures) come from the base branch, or from
// dev's head commit for a promotion. --trusted-dir reads them from a local folder that stands
// for docs/cla instead, for dry runs only. --summary appends the summary to that file.
//
// Node built-ins only. Exit 0 when everyone is covered, 1 when not or when the check can't
// finish: it fails closed.

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CLA_DIR,
  checkCla,
  failedResult,
  flatten,
  ghContentArgs,
  ghListArgs,
  ghPullArgs,
  parseCheckArgs,
  summaryMarkdown,
  trustedRef,
} from "./lib/cla.mjs";

/** gh's output, as text. Throws when gh fails. */
function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

/** A file's text at a ref, or null when GitHub says it isn't there (HTTP 404). Any other error throws. */
function readRemote(repo, path, ref) {
  if (!ref) throw new Error(`no ref to read ${path} at`);
  try {
    return gh(ghContentArgs(repo, path, ref));
  } catch (err) {
    if (/HTTP 404/.test(String(err?.stderr ?? ""))) return null;
    throw new Error(`gh could not read ${path} at ${ref}: ${String(err?.stderr ?? err?.message ?? err).trim().split("\n")[0]}`);
  }
}

/** A trusted file from the local folder that stands for docs/cla, or null when it isn't there. */
function readLocal(dir, path) {
  if (!path.startsWith(CLA_DIR)) throw new Error(`${path} is not in ${CLA_DIR}`);
  try {
    return readFileSync(join(dir, path.slice(CLA_DIR.length)), "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

async function main() {
  let args;
  try {
    args = parseCheckArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`check-cla: ${err instanceof Error ? err.message : String(err)}\n`);
    process.stderr.write("Usage: node scripts/check-cla.mjs --repo <owner/name> --pr <number> [--summary <file>] [--trusted-dir <folder>]\n");
    process.exit(1);
  }
  const { repo, pr, summary, trustedDir } = args;

  let result;
  try {
    const pull = JSON.parse(gh(ghPullArgs(repo, pr)));
    const commits = flatten(JSON.parse(gh(ghListArgs(repo, pr, "commits"))));
    const files = flatten(JSON.parse(gh(ghListArgs(repo, pr, "files"))));
    const ref = trustedRef(pull);
    result = await checkCla(
      { pull, commits, files },
      {
        readTrusted: trustedDir ? (path) => readLocal(trustedDir, path) : (path) => readRemote(repo, path, ref),
        readHead: (path) => readRemote(repo, path, `refs/pull/${pr}/head`),
      },
    );
  } catch (err) {
    const why = String(err?.stderr || err?.message || err).trim().split("\n")[0].slice(0, 300);
    result = failedResult(`Pull request ${pr} could not be read: ${why}`);
  }

  const text = summaryMarkdown(result);
  if (trustedDir) process.stdout.write(`(dry run: trusted files read from ${trustedDir})\n\n`);
  process.stdout.write(text);
  if (summary) appendFileSync(summary, text);
  process.exit(result.ok ? 0 : 1);
}

main();
