#!/usr/bin/env node
// npm run agents:check: keeps the guides for coding agents and newcomers true to the repo.
// It fails, with one line per problem, when:
//   - a guide names an npm script that package.json doesn't have;
//   - a guide names a repository path (in backticks or a link) that doesn't exist;
//   - a skill's frontmatter breaks the Agent Skills spec;
//   - an agent settings file (.claude/settings.json, .mcp.json, .cursor/mcp.json) or a
//     workflow doesn't parse;
//   - AGENTS.md is over 200 lines or a SKILL.md over 500;
//   - .env.example doesn't mention a variable the code in src/, scripts/ or workers/ reads.
// The guides: every AGENTS.md and CLAUDE.md, .claude/skills/*/SKILL.md, README.md,
// CONTRIBUTING.md, docs/self-host.md and docs/agents/cloud.md. The pieces are in
// scripts/lib/agents-check.mjs.
//
// Paths are checked against git's view of the repo (tracked files, plus new ones that
// aren't ignored), so a fresh clone and a working laptop give the same answer.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import yaml from "js-yaml";
import {
  ENV_NOT_SETTINGS,
  codeSnippets,
  envDocumented,
  envReads,
  isCreatedPath,
  isEnvSourceFile,
  lineCount,
  npmCommandProblem,
  npmCommands,
  pathIndex,
  pathWords,
  repoPathRef,
  skillProblems,
} from "./lib/agents-check.mjs";
import { REPO_ROOT } from "./lib/local-env.mjs";

const MAX_AGENTS_LINES = 200;
const MAX_SKILL_LINES = 500;
const ROOT_GUIDES = ["README.md", "CONTRIBUTING.md", "docs/self-host.md", "docs/agents/cloud.md"];
const JSON_FILES = [".claude/settings.json", ".mcp.json", ".cursor/mcp.json"];

/** Every file git would commit: tracked plus new and not ignored. */
function repoFiles() {
  const out = execFileSync("git", ["-C", REPO_ROOT, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return [...new Set(out.split("\0").filter(Boolean))].sort();
}

const files = repoFiles();
const exists = pathIndex(files);
const read = (path) => readFileSync(join(REPO_ROOT, path), "utf8");
const problems = [];
const report = (where, message) => problems.push(`${where}: ${message}`);

const guides = [
  ...files.filter((f) => /(^|\/)(AGENTS|CLAUDE)\.md$/.test(f)),
  ...files.filter((f) => /^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(f)),
  ...ROOT_GUIDES,
];

/** The nearest package.json at or above `dir`, as [path, scripts]. */
const packageCache = new Map();
function packageFor(dir) {
  let d = dir.replace(/\/+$/, "");
  for (;;) {
    const file = d ? `${d}/package.json` : "package.json";
    if (exists(file)) {
      if (!packageCache.has(file)) packageCache.set(file, JSON.parse(read(file)).scripts || {});
      return [file, packageCache.get(file)];
    }
    if (!d) return ["package.json", {}];
    d = d.includes("/") ? d.slice(0, d.lastIndexOf("/")) : "";
  }
}

/** The folder a `cd` in a guide moves to: from the root when it exists there, else from the guide's folder. */
function cdTarget(docDir, cd) {
  if (!cd) return docDir;
  const fromRoot = posix.normalize(cd);
  if (exists(fromRoot)) return fromRoot;
  return posix.normalize(posix.join(docDir, cd));
}

function checkPath(where, word, docDir) {
  const ref = repoPathRef(word, docDir, exists);
  if (!ref || ref.candidates.some((c) => isCreatedPath(c))) return;
  if (ref.candidates.some((c) => exists(c))) return;
  const shown = ref.glob ? `${ref.target} (the fixed part of ${word})` : ref.target;
  report(where, `\`${word}\` names ${shown}, which isn't in the repo`);
}

for (const guide of guides) {
  if (!exists(guide)) {
    report(guide, "is missing");
    continue;
  }
  const text = read(guide);
  const docDir = posix.dirname(guide) === "." ? "" : posix.dirname(guide);

  for (const snippet of codeSnippets(text)) {
    const where = `${guide}:${snippet.line}`;
    for (const cmd of npmCommands(snippet.text)) {
      const cd = [snippet.cd, cmd.cd].filter(Boolean).join("/");
      const [pkgFile, scripts] = packageFor(cdTarget(docDir, cd));
      const problem = npmCommandProblem(cmd, scripts, pkgFile);
      // A subfolder's guide may mean its own package or the root one ("the root `npm run lint`"),
      // unless a `cd` says which.
      const rootToo = !cd && pkgFile !== "package.json" && !npmCommandProblem(cmd, packageFor("")[1], "package.json");
      if (problem && !rootToo) report(where, problem);
    }
    for (const word of pathWords(snippet.text)) checkPath(where, word, cdTarget(docDir, snippet.cd));
  }

  // Relative links: [text](path) and CLAUDE.md imports (@path on a line of its own).
  text.split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^[a-z]+:|^#|^\//i.test(target)) continue;
      const path = posix.normalize(posix.join(docDir, target.replace(/#.*$/, "")));
      if (!exists(path) && !isCreatedPath(path)) report(`${guide}:${i + 1}`, `the link to ${target} goes nowhere (${path} isn't in the repo)`);
    }
    const imported = guide.endsWith("CLAUDE.md") && line.match(/^@(\S+)\s*$/);
    if (imported) {
      const path = posix.normalize(posix.join(docDir, imported[1]));
      if (!exists(path)) report(`${guide}:${i + 1}`, `imports @${imported[1]}, which isn't in the repo`);
    }
  });

  if (/(^|\/)AGENTS\.md$/.test(guide) && lineCount(text) > MAX_AGENTS_LINES) {
    report(guide, `is ${lineCount(text)} lines (${MAX_AGENTS_LINES} at most): move detail into a skill or a doc it links to`);
  }
  const skill = guide.match(/^\.claude\/skills\/([^/]+)\/SKILL\.md$/);
  if (skill) {
    for (const p of skillProblems(skill[1], text)) report(guide, p);
    if (lineCount(text) > MAX_SKILL_LINES) report(guide, `is ${lineCount(text)} lines (${MAX_SKILL_LINES} at most): move detail into files beside it`);
  }
}

for (const file of JSON_FILES) {
  if (!exists(file)) {
    report(file, "is missing");
    continue;
  }
  try {
    JSON.parse(read(file));
  } catch (err) {
    report(file, `isn't valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

for (const file of files.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f))) {
  try {
    const doc = yaml.load(read(file));
    if (!doc || typeof doc !== "object" || !("jobs" in doc)) report(file, "has no jobs");
  } catch (err) {
    report(file, `isn't valid YAML: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  }
}

// .env.example names every variable the code reads.
const documented = envDocumented(read(".env.example"));
const readBy = new Map();
for (const file of files.filter(isEnvSourceFile)) {
  for (const name of envReads(read(file))) {
    if (!readBy.has(name)) readBy.set(name, file);
  }
}
for (const [name, file] of [...readBy].sort(([a], [b]) => (a < b ? -1 : 1))) {
  if (!documented.has(name) && !(name in ENV_NOT_SETTINGS)) {
    report(".env.example", `doesn't mention ${name}, which ${file} reads: add it, empty or commented with its default`);
  }
}

if (problems.length) {
  process.stderr.write(`agents:check: ${problems.length} problem${problems.length === 1 ? "" : "s"}\n`);
  for (const p of problems) process.stderr.write(`  ${p}\n`);
  process.exit(1);
}
process.stdout.write(`agents:check: ${guides.length} guides, ${JSON_FILES.length} settings files and ${readBy.size} environment variables are in step with the repo.\n`);
