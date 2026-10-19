#!/usr/bin/env node
// npm run check:private-paths: fails when this repo holds a file that belongs only in our
// private deployment repo (our backends' settings, project aliases, per project extension
// settings, operations, deployment workflows and skills). The list is in
// scripts/lib/private-paths.mjs. CI runs it on our public repository only: a fork may
// keep its own .firebaserc or environment files.
//
// Node built-ins only. Exit 0 when clean, 1 when a private file is here.

import { execFileSync } from "node:child_process";
import { findPrivatePaths } from "./lib/private-paths.mjs";
import { REPO_ROOT } from "./lib/local-env.mjs";

/** Every file git would commit: tracked plus new and not ignored. */
function repoFiles() {
  const out = execFileSync("git", ["-C", REPO_ROOT, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return [...new Set(out.split("\0").filter(Boolean))];
}

function main() {
  const files = repoFiles();
  const hits = findPrivatePaths(files);
  if (hits.length === 0) {
    process.stdout.write(`check:private-paths: none of ${files.length} files belong only in the private deployment repo.\n`);
    return;
  }
  process.stderr.write(`check:private-paths: ${hits.length} file(s) belong only in the private deployment repo:\n`);
  for (const h of hits) process.stderr.write(`  ${h.path}  (${h.why}; matches ${h.glob})\n`);
  process.stderr.write("\nRemove them from this repo (git rm --cached <file>) and keep them in the private repo.\n");
  process.exit(1);
}

main();
