#!/usr/bin/env node
// PreToolUse hook (Claude Code, and Cursor, which runs Claude Code hooks): before a shell
// command that deploys, changes a cloud project, pushes code or prints a secret, it asks the
// user to confirm and names the project the command targets.
//
// Reads the hook's JSON on stdin and uses `tool_input.command` (or a top-level `command`).
// For anything else it prints nothing and exits 0. It never fails a tool call: input it
// can't read means no opinion, so the normal permission rules decide.
//
//   echo '{"tool_name":"Bash","tool_input":{"command":"firebase deploy --project my-proj"}}' \
//     | node .claude/hooks/guard-deploy.mjs
//
// Node built-ins only. Tests: guard-deploy.test.ts beside this file (part of npm test).

import { realpathSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_INPUT = 1024 * 1024;
const MAX_DEPTH = 6;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
/** Variables the repo's scripts (and gcloud) read the target project from. */
const PROJECT_VARS = ["PROJECT", "ROOT_AGENT_PROJECT", "GOOGLE_CLOUD_PROJECT", "CLOUDSDK_CORE_PROJECT"];
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const RUNNERS = new Set(["node", "tsx", "ts-node", "bun", "deno"]);
/** Subcommands of the infra setup scripts that only read (no subcommand prints the help). */
const READ_ONLY_SUBCOMMANDS = new Set(["verify", "validate", "help", "-h", "--help"]);

/** Parts of a firebase subcommand (split on ":") that change a project, or print a secret. */
const FIREBASE_WRITES = new Set([
  "deploy", "create", "delete", "update", "set", "push", "remove", "grantaccess", "access", "import",
  "install", "uninstall", "rollback", "restore", "disable", "enable", "addfirebase", "destroy", "clone", "rotate",
]);
const FIREBASE_VALUE_FLAGS = new Set(["--project", "-P", "--config", "-c", "--only", "--except", "--account", "--token", "-m", "--message", "--import", "--export-on-exit"]);

/** gcloud command words that change something. Checked after the first group word. */
const GCLOUD_WRITES = new Set([
  "deploy", "create", "update", "delete", "patch", "submit", "enable", "disable", "execute", "import", "restore",
  "undelete", "rollback", "link", "unlink", "cp", "mv", "rm", "rsync", "set", "add", "remove", "destroy", "resume",
  "pause", "access",
]);
const GCLOUD_VALUE_FLAGS = new Set([
  "--project", "--account", "--configuration", "--billing-project", "--impersonate-service-account", "--verbosity",
  "--format", "--filter", "--region", "--location", "--zone", "--limit", "--sort-by", "--page-size", "--flatten",
  "--flags-file", "--trace-token",
]);

const GSUTIL_WRITES = new Set(["cp", "mv", "rm", "rsync", "mb", "rb", "setmeta", "rewrite", "compose"]);
const GSUTIL_SETTINGS = new Set(["iam", "acl", "defacl", "retention", "lifecycle", "versioning", "label", "cors", "web", "notification", "kms", "ubla", "pap", "autoclass", "requesterpays", "logging", "hmac"]);
const BQ_WRITES = new Set(["mk", "rm", "load", "insert", "update", "cp", "truncate", "undelete", "cancel", "set-iam-policy", "add-iam-policy-binding", "remove-iam-policy-binding"]);

// ---------------------------------------------------------------------------
// A small shell reader: enough to find each command in a line, not a full parser.
// ---------------------------------------------------------------------------

/** Text from `start` up to the `)` that closes it (quotes respected), and the index after it. */
function takeParen(text, start) {
  let depth = 1;
  let quote = "";
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = "";
      else if (c === "\\" && quote === '"') i++;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === "\\") i++;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return { inner: text.slice(start, i), next: i + 1 };
  }
  return { inner: text.slice(start), next: text.length };
}

/**
 * Split a command line into simple commands, each a list of words with quotes removed.
 * Splits on ; & | && || newlines and brackets; `$(...)` and backticks become commands of
 * their own. Comments are dropped.
 * @param {string} text
 * @returns {string[][]}
 */
export function splitCommands(text, depth = 0) {
  if (depth > MAX_DEPTH) return [];
  const commands = [];
  let words = [];
  let word = "";
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  const nested = (inner) => commands.push(...splitCommands(inner, depth + 1));
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === "\\") {
      if (i + 1 < n && text[i + 1] !== "\n") {
        word += text[i + 1];
        inWord = true;
      }
      i += 2;
    } else if (c === "'") {
      const end = text.indexOf("'", i + 1);
      const stop = end < 0 ? n : end;
      word += text.slice(i + 1, stop);
      inWord = true;
      i = stop + 1;
    } else if (c === '"') {
      inWord = true;
      i++;
      while (i < n && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < n) {
          word += text[i + 1];
          i += 2;
        } else if (text[i] === "$" && text[i + 1] === "(") {
          const p = takeParen(text, i + 2);
          nested(p.inner);
          i = p.next;
        } else if (text[i] === "`") {
          const end = text.indexOf("`", i + 1);
          const stop = end < 0 ? n : end;
          nested(text.slice(i + 1, stop));
          i = stop + 1;
        } else {
          word += text[i];
          i++;
        }
      }
      i++;
    } else if (c === "$" && text[i + 1] === "(") {
      const p = takeParen(text, i + 2);
      nested(p.inner);
      inWord = true;
      i = p.next;
    } else if (c === "`") {
      const end = text.indexOf("`", i + 1);
      const stop = end < 0 ? n : end;
      nested(text.slice(i + 1, stop));
      inWord = true;
      i = stop + 1;
    } else if (c === "&" && (text[i - 1] === ">" || text[i - 1] === "<" || text[i + 1] === ">")) {
      word += c; // a redirection such as 2>&1 or &>file, not a separator
      inWord = true;
      i++;
    } else if (c === ";" || c === "&" || c === "|" || c === "\n" || c === "\r" || c === "(" || c === ")") {
      endCommand();
      i++;
    } else if (c === " " || c === "\t") {
      endWord();
      i++;
    } else if (c === "#" && !inWord) {
      const end = text.indexOf("\n", i);
      i = end < 0 ? n : end;
    } else {
      word += c;
      inWord = true;
      i++;
    }
  }
  endCommand();
  return commands;
}

// ---------------------------------------------------------------------------
// What each command does.
// ---------------------------------------------------------------------------

const lastPart = (word) => word.split("/").pop() || "";
/** A program's name: the last path part, without an npx version (`firebase-tools@15.27.0`). */
const programName = (word) => lastPart(word).replace(/(.)@[^/]*$/, "$1");
const isFlag = (word) => word.startsWith("-");

/** The value of `--name value` or `--name=value` (any of `names`), else "". */
function optionValue(args, names) {
  for (let i = 0; i < args.length; i++) {
    for (const name of names) {
      if (args[i] === name && i + 1 < args.length && !isFlag(args[i + 1])) return args[i + 1];
      if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
    }
  }
  return "";
}

/** The words that aren't flags, skipping the values of the given flags. */
function positionals(args, valueFlags) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") continue;
    if (isFlag(a)) {
      if (valueFlags.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** Drop leading VAR=value words and wrappers (sudo, env, timeout, npx ...), noting assignments. */
function stripWrappers(words, env) {
  const w = words.slice();
  const assign = (word) => {
    const at = word.indexOf("=");
    env[word.slice(0, at)] = word.slice(at + 1);
  };
  for (let guard = 0; guard < 32 && w.length; guard++) {
    const head = w[0];
    if (ASSIGNMENT.test(head)) {
      assign(w.shift());
      continue;
    }
    const name = lastPart(head);
    if (name === "sudo") {
      w.shift();
      while (w.length && isFlag(w[0])) if (["-u", "-g", "-h", "-p", "-U", "-C", "-D", "-r", "-t"].includes(w.shift())) w.shift();
    } else if (name === "env") {
      w.shift();
      while (w.length && (isFlag(w[0]) || ASSIGNMENT.test(w[0]))) {
        const f = w.shift();
        if (ASSIGNMENT.test(f)) assign(f);
        else if (["-u", "-C", "-S"].includes(f)) w.shift();
      }
    } else if (["command", "builtin", "exec", "nohup", "time", "noglob", "stdbuf"].includes(name)) {
      w.shift();
      while (w.length && isFlag(w[0])) w.shift();
    } else if (name === "nice") {
      w.shift();
      if (w[0] === "-n") w.splice(0, 2);
      else if (/^-\d+$/.test(w[0] ?? "")) w.shift();
    } else if (name === "timeout") {
      w.shift();
      while (w.length && isFlag(w[0])) if (["-s", "-k", "--signal", "--kill-after"].includes(w.shift())) w.shift();
      w.shift(); // the duration
    } else if (name === "npx" || name === "bunx") {
      w.shift();
      while (w.length && isFlag(w[0])) if (["-p", "--package", "-c", "--call"].includes(w.shift())) w.shift();
    } else if ((name === "pnpm" || name === "yarn") && w[1] === "dlx") {
      w.splice(0, 2);
    } else if (name === "npm" && (w[1] === "exec" || w[1] === "x")) {
      w.splice(0, 2);
      while (w.length && isFlag(w[0])) {
        const f = w.shift();
        if (f === "--") break;
        if (["-p", "--package", "-c"].includes(f)) w.shift();
      }
    } else break;
  }
  return w;
}

/** Where a command points when it names no project. */
function projectTarget(project, fallback) {
  return project ? `project ${project}` : fallback;
}

function envProject(env) {
  for (const name of PROJECT_VARS) if (env[name]) return env[name];
  return "";
}

const finding = (kind, words, target, note = "") => ({ kind, summary: words.join(" "), target, note });

function firebaseFinding(words, args) {
  const sub = positionals(args, FIREBASE_VALUE_FLAGS)[0] ?? "";
  if (!sub.split(":").some((part) => FIREBASE_WRITES.has(part))) return null;
  const project = optionValue(args, ["--project", "-P"]);
  const secret = sub.endsWith("secrets:access");
  return finding(secret ? "secret" : "cloud", words, projectTarget(project, "the active Firebase project (none named)"));
}

function gcloudFinding(words, args, env) {
  const pos = positionals(args, GCLOUD_VALUE_FLAGS);
  const verbs = pos.slice(1);
  const secret = pos.includes("secrets") && verbs.includes("access");
  const schedulerRun = pos[0] === "scheduler" && verbs.includes("run");
  const writes = verbs.some((v) => GCLOUD_WRITES.has(v) || /^(add|remove|set)-/.test(v));
  if (!secret && !schedulerRun && !writes) return null;
  // `gcloud projects <verb> <project id>` names its project as a word, not with --project.
  const named = pos[0] === "projects" && PROJECT_ID.test(pos[2] ?? "") ? pos[2] : "";
  const project = optionValue(args, ["--project"]) || named || env.CLOUDSDK_CORE_PROJECT || "";
  const note = pos[0] === "config" && verbs.includes("set") ? "It changes which project later gcloud commands use." : "";
  return finding(secret ? "secret" : "cloud", words, projectTarget(project, "the active gcloud project (none named)"), note);
}

function gitFinding(words, args) {
  let i = 0;
  while (i < args.length && isFlag(args[i])) i += args[i] === "-C" || args[i] === "-c" ? 2 : 1;
  if (args[i] !== "push") return null;
  const rest = args.slice(i + 1);
  if (rest.some((a) => a === "-n" || a === "--dry-run")) return null;
  const pos = positionals(rest, new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]));
  const force = rest.some((a) => /^--force(-with-lease|-if-includes)?(=|$)/.test(a) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a)) || pos.slice(1).some((p) => p.startsWith("+"));
  const remove = rest.some((a) => a === "-d" || a === "--delete");
  const note = force ? "This is a force push: it rewrites history on the remote, which this repo's rules never allow." : remove ? "It deletes a branch on the remote." : "";
  return finding("push", words, pos[0] ? `remote ${pos[0]}${pos[1] ? ` (${pos[1]})` : ""}` : "the default remote", note);
}

/** A script run by path, through a shell or a runner, or directly. */
function scriptFinding(words, script, args, env, cwd) {
  const path = posix.normalize(cwd && !script.startsWith("/") ? posix.join(cwd, script) : script);
  const fromEnv = envProject(env);
  const named = (fallback) => projectTarget(optionValue(args, ["--project"]) || fromEnv, fallback);
  if (/(^|\/)deploy\.sh$/.test(path)) {
    if (args.some((a) => a === "--dry-run" || a === "--help" || a === "-h")) return null;
    return finding("cloud", words, projectTarget(fromEnv, "the project in PROJECT (not named in the command)"));
  }
  if (/(^|\/)setup\.sh$/.test(path)) {
    const sub = args[0] ?? "";
    if (!sub || READ_ONLY_SUBCOMMANDS.has(sub)) return null;
    const project = args.slice(1).find((a) => PROJECT_ID.test(a)) || fromEnv;
    let note = "";
    if (/(^|\/)x-oauth\/setup\.sh$/.test(path) && sub === "secret") {
      note = "Warning: on a project that already has social-token-enc-key this rotates that shared key, and every stored LinkedIn and X connection stops working.";
    } else if (/(^|\/)audit-log\/setup\.sh$/.test(path) && sub === "lock") {
      note = "Warning: locking the retention policy can't be undone.";
    }
    return finding("cloud", words, projectTarget(project, "the project named on the command line (none found)"), note);
  }
  if (/(^|\/)infra\/.+\.(mjs|cjs|js|ts)$/.test(path)) {
    if (args.some((a) => a === "--dry-run" || a === "--help" || a === "-h")) return null;
    return finding("cloud", words, named("the active gcloud project (none named)"));
  }
  if (/(^|\/)scripts\/selfhost\.mjs$/.test(path)) {
    return args.some((a) => a === "--apply" || a.startsWith("--apply=")) ? finding("cloud", words, named("the project given with --project (none found)")) : null;
  }
  if (/(^|\/)scripts\/selfhost\/create-workspace\.ts$/.test(path)) {
    return args.includes("--list") ? null : finding("cloud", words, named("the project given with --project (none found)"));
  }
  if (/(^|\/)scripts\/(backfill|recover|fix)-[\w-]+\.ts$/.test(path)) {
    return finding("cloud", words, named("the project in GOOGLE_CLOUD_PROJECT (not named in the command)"));
  }
  return null;
}

/** One simple command: a finding, or null. `state` carries exported variables and `cd` across commands. */
function inspect(words, state, depth) {
  const env = { ...state.env };
  const w = stripWrappers(words, env);
  if (!w.length) {
    Object.assign(state.env, env); // a bare VAR=value sets it for the commands after it
    return null;
  }
  const head = w[0];
  const name = programName(head);
  const args = w.slice(1);
  if (name === "export") {
    for (const a of args) if (ASSIGNMENT.test(a)) state.env[a.slice(0, a.indexOf("="))] = a.slice(a.indexOf("=") + 1);
    return null;
  }
  if (name === "cd") {
    const dir = args[0] ?? "";
    state.cwd = !dir || dir.startsWith("/") || dir.startsWith("~") ? "" : posix.normalize(posix.join(state.cwd, dir));
    return null;
  }
  if (SHELLS.has(name)) {
    const c = args.indexOf("-c");
    if (c >= 0) return firstFinding(args[c + 1] ?? "", { env, cwd: state.cwd }, depth + 1);
    const at = args.findIndex((a) => !isFlag(a));
    return at < 0 ? null : scriptFinding(w, args[at], args.slice(at + 1), env, state.cwd);
  }
  if (name === "source" || name === ".") return args[0] ? scriptFinding(w, args[0], args.slice(1), env, state.cwd) : null;
  if (RUNNERS.has(name)) {
    const at = args.findIndex((a) => !isFlag(a));
    return at < 0 ? null : scriptFinding(w, args[at], args.slice(at + 1), env, state.cwd);
  }
  if (name === "firebase" || name === "firebase-tools") return firebaseFinding(w, args);
  if (name === "gcloud") return gcloudFinding(w, args, env);
  if (name === "git") return gitFinding(w, args);
  if (name === "gsutil") {
    const pos = positionals(args, new Set(["-o", "-h", "-p"]));
    const writes = GSUTIL_WRITES.has(pos[0] ?? "") || (GSUTIL_SETTINGS.has(pos[0] ?? "") && pos[1] !== undefined && pos[1] !== "get");
    return writes ? finding("cloud", w, projectTarget(optionValue(args, ["-p"]), "the active gcloud project (none named)")) : null;
  }
  if (name === "bq") {
    const pos = positionals(args, new Set(["--location", "--format"]));
    return BQ_WRITES.has(pos[0] ?? "") ? finding("cloud", w, projectTarget(optionValue(args, ["--project_id"]), "the active gcloud project (none named)")) : null;
  }
  if (name === "terraform" || name === "tofu") {
    const sub = positionals(args, new Set(["-chdir"]))[0] ?? "";
    return ["apply", "destroy", "import"].includes(sub) ? finding("cloud", w, "the project in your Terraform settings") : null;
  }
  if (name === "adk") {
    return positionals(args, new Set())[0] === "deploy" ? finding("cloud", w, projectTarget(optionValue(args, ["--project"]) || envProject(env), "the active gcloud project (none named)")) : null;
  }
  if (name === "npm") {
    const pos = positionals(args, new Set(["--prefix", "-w", "--workspace"]));
    if (pos[0] === "publish") return finding("publish", w, "the npm registry");
    if ((pos[0] === "run" || pos[0] === "run-script") && pos[1] === "selfhost") return scriptFinding(w, "scripts/selfhost.mjs", args, env, "");
    return null;
  }
  if (head.includes("/") || /\.(sh|mjs|js|ts)$/.test(head)) return scriptFinding(w, head, args, env, state.cwd);
  return null;
}

function firstFinding(text, state, depth) {
  if (depth > MAX_DEPTH) return null;
  for (const words of splitCommands(text)) {
    const found = inspect(words, state, depth);
    if (found) return found;
  }
  return null;
}

const KIND_TEXT = {
  cloud: "Deploys or changes a cloud project",
  secret: "Prints a secret value",
  push: "Pushes code",
  publish: "Publishes a package",
};

/**
 * Why this shell command needs the user's go-ahead, naming its target, or null when it
 * doesn't look like a deploy, a cloud change, a push or a secret read.
 * @param {string} command
 * @returns {string | null}
 */
export function reasonFor(command) {
  if (typeof command !== "string" || !command.trim()) return null;
  const found = firstFinding(command.slice(0, MAX_INPUT), { env: {}, cwd: "" }, 0);
  if (!found) return null;
  const summary = found.summary.length > 120 ? `${found.summary.slice(0, 117)}...` : found.summary;
  const check = found.kind === "secret" ? "Secret values must never be printed." : found.kind === "push" ? "Approve only if you mean to push." : "Approve only if the target and the change are right.";
  return `${KIND_TEXT[found.kind]}: "${summary}" targets ${found.target}.${found.note ? ` ${found.note}` : ""} ${check}`;
}

/**
 * The hook's answer for one hook input (parsed JSON), or null for no opinion.
 * @param {unknown} input
 */
export function hookResponse(input) {
  if (!input || typeof input !== "object") return null;
  const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
  if (toolName && toolName !== "Bash" && toolName !== "Shell") return null;
  const toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  const command = typeof toolInput.command === "string" ? toolInput.command : typeof input.command === "string" ? input.command : "";
  const reason = reasonFor(command);
  if (!reason) return null;
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason } };
}

function readStdin() {
  return new Promise((resolve) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      if (text.length < MAX_INPUT) text += chunk;
    });
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", () => resolve(""));
  });
}

async function main() {
  try {
    if (process.stdin.isTTY) return;
    const raw = await readStdin();
    let input = null;
    try {
      input = JSON.parse(raw);
    } catch {
      return;
    }
    const out = hookResponse(input);
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch {
    // No opinion: the permission rules still apply.
  }
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  process.on("uncaughtException", () => process.exit(0));
  main().finally(() => {
    process.exitCode = 0;
  });
}
