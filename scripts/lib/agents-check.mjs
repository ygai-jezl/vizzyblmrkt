// The pieces of `npm run agents:check`: read the agent guides (AGENTS.md, CLAUDE.md, skills,
// README and the docs they point to) for the commands and paths they name, check skill
// frontmatter, and find the environment variables the code reads. Pure functions; the
// repo walk is in scripts/agents-check.mjs.

import { posix } from "node:path";
import yaml from "js-yaml";

// ---------------------------------------------------------------------------
// Code in Markdown
// ---------------------------------------------------------------------------

/**
 * The code in a Markdown text: each inline code span, and each line of a fenced block
 * (with the folder a `cd <dir>` line earlier in the same block moved to).
 * @param {string} markdown
 * @returns {{ text: string, line: number, fenced: boolean, cd: string }[]}
 */
export function codeSnippets(markdown) {
  const out = [];
  let fence = "";
  let cd = "";
  String(markdown)
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const line = i + 1;
      const opener = raw.match(/^\s*(`{3,}|~{3,})/);
      if (fence) {
        if (opener && opener[1][0] === fence[0] && opener[1].length >= fence.length && !raw.trim().slice(opener[1].length).trim()) {
          fence = "";
          return;
        }
        const text = raw.trim();
        const move = text.match(/^cd\s+(\S+)\s*$/);
        if (move) cd = posix.join(cd, move[1]);
        else if (text && !text.startsWith("#")) out.push({ text, line, fenced: true, cd });
        return;
      }
      if (opener) {
        fence = opener[1];
        cd = "";
        return;
      }
      for (const m of raw.matchAll(/`([^`\n]+)`/g)) out.push({ text: m[1].trim(), line, fenced: false, cd: "" });
    });
  return out;
}

/** npm's own commands and aliases (npm 10 and 11). `npm <one of these>` never runs a package script. */
export const NPM_BUILTINS = new Set(
  (
    "access adduser audit bugs cache ci completion config dedupe deprecate diff dist-tag docs doctor edit exec explain " +
    "explore find-dupes fund get help help-search init install install-ci-test install-test link ll login logout ls org " +
    "outdated owner pack ping pkg prefix profile prune publish query rebuild repo restart root run run-script sbom search " +
    "set shrinkwrap stage star stars start stop team test token undeprecate uninstall unpublish unstar update version view " +
    "whoami i add it t tst un rm r up x ln"
  ).split(" "),
);
/** The npm commands that run the package script of the same name. */
const SCRIPT_RUNNERS = new Set(["test", "t", "tst", "start", "stop", "restart"]);
const PLACEHOLDER = /[<>{}*?$]/;

/**
 * The npm commands in a snippet of code: `npm run <script>` and `npm <command>`, each with
 * the folder a `cd <dir> &&` before it moves to.
 * @param {string} text
 * @returns {{ kind: "run" | "command", name: string, cd: string }[]}
 */
export function npmCommands(text) {
  const out = [];
  const re = /(^|[\s;&|(])npm\s+([^\s;&|)]+)(?:\s+([^\s;&|)]+))?/g;
  for (const m of String(text).matchAll(re)) {
    const before = text.slice(0, m.index);
    const cds = [...before.matchAll(/\bcd\s+([^\s;&|]+)\s*&&/g)];
    const cd = cds.length ? cds[cds.length - 1][1] : "";
    const [first, second] = [m[2], m[3] || ""];
    if (first.startsWith("-") || PLACEHOLDER.test(first)) continue;
    if (first === "run" || first === "run-script") {
      const name = second.replace(/^["']|["']$/g, "");
      if (!name || name.startsWith("-") || PLACEHOLDER.test(name)) continue;
      out.push({ kind: "run", name, cd });
    } else {
      out.push({ kind: "command", name: first, cd });
    }
  }
  return out;
}

/**
 * What is wrong with one npm command, given the scripts of the package.json it runs in,
 * or "" when nothing is.
 * @param {{ kind: "run" | "command", name: string }} cmd
 * @param {Record<string, string>} scripts
 * @param {string} packageFile repository relative, for the message
 */
export function npmCommandProblem(cmd, scripts, packageFile) {
  const has = Object.prototype.hasOwnProperty.call(scripts, cmd.name);
  if (cmd.kind === "run") return has ? "" : `\`npm run ${cmd.name}\`: ${packageFile} has no "${cmd.name}" script`;
  if (SCRIPT_RUNNERS.has(cmd.name) || cmd.name === "run" || cmd.name === "run-script") return "";
  if (NPM_BUILTINS.has(cmd.name)) {
    return has ? `\`npm ${cmd.name}\` runs npm's own command, not the "${cmd.name}" script in ${packageFile}: write \`npm run ${cmd.name}\`` : "";
  }
  if (has) return `\`npm ${cmd.name}\` doesn't run the "${cmd.name}" script: write \`npm run ${cmd.name}\``;
  return `\`npm ${cmd.name}\` is neither an npm command nor a script in ${packageFile}`;
}

// ---------------------------------------------------------------------------
// Repository paths in Markdown
// ---------------------------------------------------------------------------

/** Folders whose paths are always checked, from the root, even when written inside a subfolder's guide. */
export const REPO_PATH_PREFIXES = ["src/", "scripts/", "docs/", "agents/", "workers/", "infra/", "sdk/", ".claude/", ".github/", ".cursor/", ".devcontainer/"];
/**
 * File names checked when written bare: the kinds that sit at the root of a package. Dotfiles
 * need a second dot or an rc ending, so `.test` (a domain) and `.env` (any env file) aren't
 * read as paths.
 */
const ROOT_FILE = /^(?:\.[\w-]+\.[\w.-]+|\.[\w-]+rc|\.gitignore|[\w.-]+\.(?:md|json|ya?ml|rules|example|template)|[\w-]+\.config\.(?:ts|mjs|js)|LICENSE|Dockerfile)$/;

/**
 * Paths named in the guides that people or tools create, so a fresh clone doesn't have
 * them. Each needs a reason. Subpaths count too.
 * @type {Record<string, string>}
 */
export const PATHS_PEOPLE_CREATE = {
  ".env.local": "npm run local writes it; git ignored",
  "agents/.venv": "the Python virtualenv the Vizzy setup creates; git ignored",
  "CLAUDE.local.md": "a person's own Claude Code notes; git ignored",
  ".claude/settings.local.json": "a person's own Claude Code settings; git ignored",
  "apphosting.live.yaml": "npm run selfhost writes it in a fork; never in this repo",
  ".firebaserc": "a deployment's own project aliases; never in this repo",
};

/**
 * The words in a snippet that may be repository paths, cleaned of quotes and punctuation.
 * @param {string} text
 * @returns {string[]}
 */
export function pathWords(text) {
  return String(text)
    .split(/\s+/)
    .map((w) => w.replace(/^[A-Za-z_][A-Za-z0-9_]*=/, "").replace(/^["'(]+|["'),;:.]+$/g, ""))
    // Not flags, variables, URLs, emails or package@version; `@/` is the app's import alias.
    .filter((w) => w && !w.startsWith("-") && !w.startsWith("$") && !w.includes("://") && (!w.includes("@") || w.startsWith("@/")));
}

/**
 * Turn a word into the repository path it names, relative to `docDir` (the guide's folder,
 * "" for the root), or null when it doesn't look like a path in this repo. `candidates` are
 * the places to look, in order, and `target` the one to name in a message; with `glob` only
 * the fixed start (before a placeholder or wildcard segment) is checked.
 * @param {string} word
 * @param {string} docDir
 * @param {(path: string) => boolean} exists
 * @returns {{ path: string, target: string, candidates: string[], glob: boolean } | null}
 */
export function repoPathRef(word, docDir, exists) {
  let w = word.replace(/#.*$/, "").replace(/:\d+(?::\d+)?$/, "");
  const isModule = w.startsWith("@/");
  if (isModule) w = `src/${w.slice(2)}`;
  w = w.replace(/^\.\//, "").replace(/\/+$/, "");
  if (!w || w.startsWith("/") || w.startsWith("~") || w.startsWith("..")) return null;
  if (!/^[\w.@/[\]<>{}*?-]+$/.test(w)) return null;

  const segments = w.split("/");
  const fixed = [];
  for (const s of segments) {
    if (/[<>{}*?]/.test(s)) break;
    fixed.push(s);
  }
  const glob = fixed.length < segments.length;
  if (!fixed.length) return null;
  const base = fixed.join("/");

  const prefixed = REPO_PATH_PREFIXES.some((p) => `${w}/`.startsWith(p));
  const nested = docDir ? posix.join(docDir, base) : base;
  let candidates;
  if (isModule) {
    candidates = [base];
  } else if (prefixed || (segments.length === 1 && ROOT_FILE.test(w))) {
    candidates = docDir ? [nested, base] : [base];
  } else if (exists(docDir ? posix.join(docDir, fixed[0]) : fixed[0]) && fixed.length > 1) {
    // A path inside a folder this guide's folder has (for example `test/vectors.json` in sdk/node).
    candidates = [nested];
  } else {
    return null;
  }
  const target = candidates.join(" or ");
  if (isModule && !glob) {
    const exts = [".ts", ".tsx", ".mjs", ".js", "/index.ts", "/index.tsx"];
    candidates = candidates.flatMap((c) => [c, ...exts.map((e) => c + e)]);
  }
  return { path: word, target, candidates, glob };
}

/** True when `path` is one PATHS_PEOPLE_CREATE lists, or inside one. */
export function isCreatedPath(path) {
  return Object.keys(PATHS_PEOPLE_CREATE).some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * An existence test over a list of repository files (git's view: tracked, or new and not
 * ignored), which also knows every folder that holds one.
 * @param {Iterable<string>} files
 * @returns {(path: string) => boolean}
 */
export function pathIndex(files) {
  const all = new Set();
  for (const f of files) {
    const parts = String(f).split("/");
    for (let i = 1; i <= parts.length; i++) all.add(parts.slice(0, i).join("/"));
  }
  return (path) => all.has(String(path).replace(/\/+$/, ""));
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/** The fields the Agent Skills specification allows in SKILL.md frontmatter. */
export const SKILL_FIELDS = new Set(["name", "description", "license", "compatibility", "metadata", "allowed-tools"]);

/**
 * The YAML between the opening `---` lines of a Markdown file.
 * @param {string} text
 * @returns {{ data: unknown, error: string }}
 */
export function frontmatter(text) {
  const m = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!m) return { data: null, error: "no frontmatter: the file must start with a --- block" };
  try {
    return { data: yaml.load(m[1]), error: "" };
  } catch (err) {
    return { data: null, error: `frontmatter isn't valid YAML: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` };
  }
}

/**
 * What is wrong with a skill's SKILL.md, given the folder it is in.
 * @param {string} folder the skill folder's name
 * @param {string} text the SKILL.md contents
 * @returns {string[]}
 */
export function skillProblems(folder, text) {
  const { data, error } = frontmatter(text);
  if (error) return [error];
  if (!data || typeof data !== "object" || Array.isArray(data)) return ["frontmatter must be a set of fields"];
  const problems = [];
  for (const key of Object.keys(data)) {
    if (!SKILL_FIELDS.has(key)) problems.push(`frontmatter field "${key}" isn't in the skills spec (allowed: ${[...SKILL_FIELDS].join(", ")})`);
  }
  const { name, description } = /** @type {Record<string, unknown>} */ (data);
  if (typeof name !== "string" || !name) problems.push("name is missing");
  else {
    if (name !== folder) problems.push(`name "${name}" must match its folder "${folder}"`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) problems.push(`name "${name}" must be lowercase letters, digits and single hyphens`);
    if (name.length > 64) problems.push(`name is ${name.length} characters (64 at most)`);
  }
  if (typeof description !== "string" || !description.trim()) problems.push("description is missing");
  else if (description.length > 1024) problems.push(`description is ${description.length} characters (1024 at most)`);
  const { compatibility, metadata, license } = /** @type {Record<string, unknown>} */ (data);
  if (license !== undefined && typeof license !== "string") problems.push("license must be text");
  if (compatibility !== undefined && (typeof compatibility !== "string" || !compatibility || compatibility.length > 500)) problems.push("compatibility must be text of 1 to 500 characters");
  if (metadata !== undefined && (typeof metadata !== "object" || metadata === null || Array.isArray(metadata))) problems.push("metadata must be a set of fields");
  if (data["allowed-tools"] !== undefined && typeof data["allowed-tools"] !== "string") problems.push("allowed-tools must be text");
  return problems;
}

/** Lines in a text, not counting a final newline. */
export function lineCount(text) {
  const lines = String(text).split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

// ---------------------------------------------------------------------------
// Environment variables
// ---------------------------------------------------------------------------

/**
 * Variables the code reads that .env.example leaves out on purpose, each with why. Keep it
 * short: a setting someone may need belongs in .env.example.
 * @type {Record<string, string>}
 */
export const ENV_NOT_SETTINGS = {
  PATH: "the operating system's",
  APPDATA: "the operating system's (Windows), where gcloud keeps its settings",
  // Tests only (scripts/selfhost/selfhost.test.ts): point npm run selfhost at fakes.
  SELFHOST_IDENTITY_TOOLKIT_URL: "tests only: a fake Identity Toolkit API",
  SELFHOST_FIREBASE_URL: "tests only: a fake Firebase Management API",
  SELFHOST_APPHOSTING_URL: "tests only: a fake App Hosting API",
  SELFHOST_WORKSPACE_TOOL: "tests only: a stub for the workspace tool",
  SELFHOST_HEALTH_WAIT_MS: "tests only: a shorter wait between health checks",
  // Code samples on the developer pages and in the setup prompt: a connected product reads these.
  YOUGROW_KEY_ID: "a connected product's setting, shown in code samples",
  YOUGROW_SECRET: "a connected product's setting, shown in code samples",
  YOUGROW_ORIGIN: "a connected product's setting, shown in code samples",
};

const ENV_READ = /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\])/g;

/**
 * The variables a source file reads (`process.env.X` or `process.env["X"]`), leaving out
 * mentions in comments.
 * @param {string} text
 * @returns {string[]}
 */
export function envReads(text) {
  const names = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    const comment = line.search(/(^|\s)\/\//);
    for (const m of line.matchAll(ENV_READ)) {
      if (comment >= 0 && m.index > comment) continue;
      names.add(m[1] || m[2]);
    }
  }
  return [...names];
}

/**
 * Every variable name .env.example mentions: as a setting (`X=`), commented out, or named
 * in a comment.
 * @param {string} text
 * @returns {Set<string>}
 */
export function envDocumented(text) {
  return new Set(String(text).match(/\b[A-Z][A-Z0-9_]*\b/g) || []);
}

/** Source files whose variables .env.example must cover: code in src/, scripts/ and workers/, no tests. */
export function isEnvSourceFile(path) {
  if (!/^(?:src|scripts|workers)\//.test(path)) return false;
  if (!/\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx)$/.test(path)) return false;
  if (/\.(?:test|spec)\.[^/]+$/.test(path) || /(^|\/)(?:testing|__tests__|test|tests)\//.test(path)) return false;
  return !/(^|\/)(?:node_modules|dist)\//.test(path);
}
