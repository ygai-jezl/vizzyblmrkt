import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import type { StoreDb, StoreRef } from "./types";

/**
 * Finds the stores the code uses by reading its source, so a test can check that each one has an
 * entry in the ontology registry (src/lib/ontology/coverage.test.ts). Modelled on
 * scripts/config/feature-switches.mjs: plain text scanning, Node built-ins only, nothing run.
 *
 * What it reads:
 * - repository.ts: every `key: new TenantCollection<...>(regionalDb | controlDb, "name", t)`;
 * - every other file: each `.collection(...)` call, with its argument resolved to a name where
 *   it can be (a string, an UPPER_CASE constant here or in an imported relative file, a value of
 *   an UPPER_CASE map in the same file, or the last segment of a template literal);
 * - which database a file reaches (control, regional or search), from how it gets its database;
 * - which files import Cloud Storage or BigQuery.
 * A call it can't resolve comes back unresolved, so it must be named in an allowlist with a reason.
 */

// --- Reading source text -------------------------------------------------------------------

/** Characters after which a `/` starts a regular expression rather than a division. */
const REGEX_AFTER = /[(,=:[!&|?{};+\-*%<>~^]$/;
const REGEX_AFTER_WORD = /(?:^|[^\w$])(?:return|typeof|instanceof|case|do|else|in|of|new|delete|void|throw|yield|await)$/;

interface Lexed {
  /** The text with comments blanked out (same length, same lines). */
  stripped: string;
  /** As `stripped`, with the insides of strings, templates and regular expressions blanked too. */
  masked: string;
}

function lex(text: string): Lexed {
  const stripped: string[] = [];
  const masked: string[] = [];
  const blank = (c: string) => (c === "\n" ? "\n" : " ");
  /** Copy text[from, to) into stripped, and blanks into masked (or into both when `both`). */
  const copy = (from: number, to: number, mode: "keep" | "mask" | "blank") => {
    for (let k = from; k < to; k++) {
      const c = text[k]!;
      stripped.push(mode === "blank" ? blank(c) : c);
      masked.push(mode === "keep" ? c : blank(c));
    }
  };
  // Code inside `${...}` of a template counts its own braces; a template is its own mode.
  const stack: Array<{ mode: "code"; depth: number } | { mode: "template" }> = [{ mode: "code", depth: 0 }];
  let recent = ""; // the last code characters, for telling a regular expression from a division
  const remember = (s: string) => {
    recent = (recent + s).slice(-24);
  };
  let i = 0;
  const n = text.length;
  while (i < n) {
    const top = stack[stack.length - 1]!;
    const c = text[i]!;
    const next = text[i + 1];
    if (top.mode === "template") {
      if (c === "\\") {
        copy(i, Math.min(n, i + 2), "mask");
        i += 2;
      } else if (c === "`") {
        copy(i, i + 1, "keep");
        stack.pop();
        remember("`");
        i += 1;
      } else if (c === "$" && next === "{") {
        copy(i, i + 2, "keep");
        stack.push({ mode: "code", depth: 0 });
        remember("{");
        i += 2;
      } else {
        copy(i, i + 1, "mask");
        i += 1;
      }
      continue;
    }
    if (c === "/" && next === "/") {
      let j = i;
      while (j < n && text[j] !== "\n") j++;
      copy(i, j, "blank");
      i = j;
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const j = end < 0 ? n : end + 2;
      copy(i, j, "blank");
      i = j;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      const end = Math.min(n, j + 1);
      copy(i, i + 1, "keep");
      copy(i + 1, Math.max(i + 1, end - 1), "mask");
      if (end - 1 > i) copy(end - 1, end, "keep");
      remember(c);
      i = end;
    } else if (c === "`") {
      copy(i, i + 1, "keep");
      stack.push({ mode: "template" });
      i += 1;
    } else if (c === "/" && (REGEX_AFTER.test(recent.trimEnd()) || recent.trim() === "" || REGEX_AFTER_WORD.test(recent.trimEnd()))) {
      let j = i + 1;
      let inClass = false;
      while (j < n && text[j] !== "\n") {
        const ch = text[j]!;
        if (ch === "\\") {
          j += 2;
          continue;
        }
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) break;
        j++;
      }
      if (text[j] === "/") {
        let k = j + 1;
        while (k < n && /[a-z]/i.test(text[k]!)) k++;
        copy(i, i + 1, "keep");
        copy(i + 1, j, "mask");
        copy(j, k, "keep");
        remember("/");
        i = k;
      } else {
        copy(i, i + 1, "keep");
        remember("/");
        i += 1;
      }
    } else {
      if (c === "{") top.depth += 1;
      if (c === "}") {
        if (top.depth === 0 && stack.length > 1) {
          copy(i, i + 1, "keep");
          stack.pop();
          i += 1;
          continue;
        }
        top.depth -= 1;
      }
      copy(i, i + 1, "keep");
      if (!/\s/.test(c)) remember(c);
      else if (!/\s$/.test(recent)) remember(" ");
      i += 1;
    }
  }
  return { stripped: stripped.join(""), masked: masked.join("") };
}

/**
 * The text with // and /* *\/ comments replaced by spaces. Strings, templates and regular
 * expressions are left alone, so "https://" in a string survives. Lengths and lines are kept,
 * so positions in the result are positions in the source.
 */
export function stripComments(text: string): string {
  return lex(text).stripped;
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let k = 0; k < index; k++) if (text.charCodeAt(k) === 10) line++;
  return line;
}

// --- repository.ts -------------------------------------------------------------------------

export interface RepositoryEntry {
  /** The key on forTenant's result, e.g. "emailSends". */
  key: string;
  collection: string;
  db: "regional" | "control";
}

const REPOSITORY_ENTRY =
  /(\w+)\s*:\s*new\s+TenantCollection\s*<[^>(]*>\s*\(\s*(regionalDb|controlDb)\s*,\s*(["'])([^"'\n]+)\3/g;

/** Every collection forTenant gives, from the text of src/lib/tenant/repository.ts. */
export function parseRepository(text: string): RepositoryEntry[] {
  const code = stripComments(text);
  return [...code.matchAll(REPOSITORY_ENTRY)].map((m) => ({
    key: m[1]!,
    collection: m[4]!,
    db: m[2] === "controlDb" ? "control" : "regional",
  }));
}

// --- .collection() calls -------------------------------------------------------------------

export interface ResolvedSite {
  file: string;
  line: number;
  /** The call's argument, as written (spaces collapsed). */
  expr: string;
  name: string;
}

export interface UnresolvedSite {
  file: string;
  line: number;
  expr: string;
}

export interface CallScan {
  resolved: ResolvedSite[];
  unresolved: UnresolvedSite[];
}

/** Reads a relative import: the importing file and the specifier, both repo relative. Null when not found. */
export type ImportReader = (fromFile: string, specifier: string) => string | null;

/** Reads a relative import from the repo on disk (run from the repo root). */
export function readImportFromDisk(fromFile: string, specifier: string): string | null {
  const base = posix.join(posix.dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base]) {
    const full = join(process.cwd(), candidate);
    if (existsSync(full) && statSync(full).isFile()) return readFileSync(full, "utf8");
  }
  return null;
}

const CONST_STRING = /\b(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::[^=;]+)?=\s*(["'])([^"'\n]*)\2/g;
const CONST_MAP = /\b(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::[^=;{]+)?=\s*\{/g;
const RELATIVE_IMPORT = /\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*(["'])(\.[^"']*)\2/g;

/** The last path segment of a collection path: "workspaces/x/templates" is "templates". */
function lastSegment(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1]!;
}

function constStrings(code: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of code.matchAll(CONST_STRING)) out.set(m[1]!, m[3]!);
  return out;
}

function constMaps(lexed: Lexed): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of lexed.stripped.matchAll(CONST_MAP)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const close = matching(lexed.masked, open, "{", "}");
    if (close < 0) continue;
    const body = lexed.stripped.slice(open + 1, close);
    out.set(m[1]!, [...body.matchAll(/:\s*(["'])([^"'\n]+)\1/g)].map((v) => v[2]!));
  }
  return out;
}

/** The index of the bracket that closes the one at `open`, counting nested ones; -1 if none. */
function matching(masked: string, open: number, opener: string, closer: string): number {
  let depth = 0;
  for (let k = open; k < masked.length; k++) {
    if (masked[k] === opener) depth++;
    else if (masked[k] === closer) {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

function importedNames(code: string): Map<string, { specifier: string; name: string }> {
  const out = new Map<string, { specifier: string; name: string }>();
  for (const m of code.matchAll(RELATIVE_IMPORT)) {
    for (const part of m[1]!.split(",")) {
      const [name, local] = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/);
      if (name) out.set((local ?? name).trim(), { specifier: m[3]!, name: name.trim() });
    }
  }
  return out;
}

/**
 * Every `.collection(...)` (and `.collectionGroup(...)`) call in one file, with the collection
 * name each one reaches where it can be worked out. A map indexed by a variable reaches every
 * value of the map. Comments are ignored, and so is anything inside a string.
 */
export function scanCollectionCalls(file: string, text: string, readImport: ImportReader = readImportFromDisk): CallScan {
  const lexed = lex(text);
  const consts = constStrings(lexed.stripped);
  const maps = constMaps(lexed);
  const imports = importedNames(lexed.stripped);
  const importedConst = (local: string): string | null => {
    const from = imports.get(local);
    if (!from) return null;
    const target = readImport(file, from.specifier);
    if (target === null) return null;
    const value = constStrings(stripComments(target)).get(from.name);
    return value ?? null;
  };
  const constant = (name: string): string | null => consts.get(name) ?? importedConst(name);

  const resolve = (expr: string): string[] | null => {
    const literal = /^(["'])([^"'\n]+)\1$/.exec(expr);
    if (literal) return [lastSegment(literal[2]!)];
    const template = /^`([^`]*)`$/.exec(expr);
    if (template) {
      const last = lastSegment(template[1]!);
      const ref = /^\$\{\s*([A-Z][A-Z0-9_]*)\s*\}$/.exec(last);
      if (ref) {
        const value = constant(ref[1]!);
        return value === null ? null : [lastSegment(value)];
      }
      return /^[A-Za-z0-9_-]+$/.test(last) ? [last] : null;
    }
    if (/^[A-Z][A-Z0-9_]*$/.test(expr)) {
      const value = constant(expr);
      return value === null ? null : [lastSegment(value)];
    }
    const indexed = /^([A-Z][A-Z0-9_]*)\s*\[[^\]]+\]$/.exec(expr);
    if (indexed) {
      const values = maps.get(indexed[1]!);
      return values && values.length ? values.map(lastSegment) : null;
    }
    return null;
  };

  const out: CallScan = { resolved: [], unresolved: [] };
  for (const m of lexed.masked.matchAll(/\.collection(?:Group)?\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const close = matching(lexed.masked, open, "(", ")");
    if (close < 0) continue;
    const expr = lexed.stripped.slice(open + 1, close).replace(/\s+/g, " ").trim();
    const line = lineAt(text, m.index ?? 0);
    const names = resolve(expr);
    if (names) for (const name of names) out.resolved.push({ file, line, expr, name });
    else out.unresolved.push({ file, line, expr });
  }
  return out;
}

// --- Which database a file reaches ---------------------------------------------------------

export type FileHome = "control" | "regional" | "search" | "mixed";

/**
 * The database a file's collections live in, from how it gets its database: the search database
 * through searchDatabaseIdForRegion; regional through databaseIdForRegion or a regionalDb helper;
 * control when it only calls getDb() with no argument or "(default)". Anything else, both, or
 * neither (a database passed in) is mixed, and its names are not checked for home.
 */
export function homeOfFile(text: string): FileHome {
  const code = stripComments(text);
  if (/\bsearchDatabaseIdForRegion\b/.test(code)) return "search";
  const regional = /\b(?:databaseIdForRegion|regionalDb)\b/.test(code);
  const control = /\bgetDb\(\s*(?:\)|(["'])\(default\)\1\s*\))/.test(code);
  if (regional && !control) return "regional";
  if (control && !regional) return "control";
  return "mixed";
}

// --- Cloud Storage and BigQuery ------------------------------------------------------------

const STORE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)(["'])(?:firebase-admin\/storage|@google-cloud\/storage|@google-cloud\/bigquery)\1/;

/** The files that import Cloud Storage or BigQuery, statically or not. */
export function scanStoreImports(files: ReadonlyArray<{ file: string; text: string }>): string[] {
  return files.filter((f) => STORE_IMPORT.test(stripComments(f.text))).map((f) => f.file);
}

// --- Listing source files ------------------------------------------------------------------

const TEST_FILE = /\.test\.tsx?$/;

/** Repo relative .ts files under `dir`, tests and `testing/` folders left out, sorted. */
export function sourceFiles(dir: string, root: string = process.cwd()): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const full = join(root, rel);
    if (!existsSync(full)) return;
    for (const entry of readdirSync(full, { withFileTypes: true })) {
      const path = posix.join(rel, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "testing" && entry.name !== "node_modules") walk(path);
      } else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !TEST_FILE.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        out.push(path);
      }
    }
  };
  walk(dir);
  return out.sort();
}

/** The `src` folder of every worker under workers/, repo relative. */
export function workerSourceDirs(root: string = process.cwd()): string[] {
  const workers = join(root, "workers");
  if (!existsSync(workers)) return [];
  return readdirSync(workers, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(workers, e.name, "src")))
    .map((e) => `workers/${e.name}/src`)
    .sort();
}

// --- Comparing the code with the registry --------------------------------------------------

export interface ScannedFile {
  file: string;
  home: FileHome;
  calls: CallScan;
}

/** A call the scan can't resolve, the names it reaches and why it is written that way. */
export interface AllowedUnresolved {
  file: string;
  expr: string;
  names: readonly string[];
  reason: string;
}

export interface CoverageInput {
  /** The repo path of repository.ts. */
  repositoryFile: string;
  repository: readonly RepositoryEntry[];
  /** Every other scanned file. */
  scanned: readonly ScannedFile[];
  /** Every store in the registry. */
  stores: readonly StoreRef[];
  allowed: readonly AllowedUnresolved[];
  /** Files that must be the definedIn of some registry store (Cloud Storage, BigQuery and Memory Bank writers). */
  storeFiles: readonly string[];
}

const FIRESTORE: readonly StoreDb[] = ["control", "regional", "search"];

/**
 * Where the code and the registry disagree, one line each; empty when every store the code uses
 * has an entry and every Firestore entry is found in the code. The control plane set is taken
 * from the registry, so a new control collection needs only a registry entry.
 */
export function coverageProblems(input: CoverageInput): string[] {
  const problems: string[] = [];
  const firestore = input.stores.filter((s) => FIRESTORE.includes(s.db));
  const registryHas = (name: string, db?: StoreDb) => firestore.some((s) => s.collection === name && (!db || s.db === db));
  const fix = "add it to src/lib/ontology/registry.ts, then run npm run ontology:doc";

  // 1. Every repository collection, with its database.
  for (const e of input.repository) {
    const ok = firestore.some((s) => s.collection === e.collection && s.db === e.db && s.definedIn === input.repositoryFile);
    if (!ok) problems.push(`${input.repositoryFile}: forTenant's ${e.key} (${e.collection}, ${e.db}) has no registry store defined in ${input.repositoryFile}: ${fix}`);
  }

  // 3 and 4. Every other call: resolved names are registered (in the right database), and the rest are allowed.
  for (const f of input.scanned) {
    for (const site of f.calls.resolved) {
      if (!registryHas(site.name)) {
        problems.push(`${site.file}:${site.line}: .collection(${site.expr}) reaches ${site.name}, which has no registry entry: ${fix}`);
      } else if (f.home !== "mixed" && !registryHas(site.name, f.home)) {
        problems.push(`${site.file}:${site.line}: ${site.name} is used in the ${f.home} database here, but the registry has no ${f.home} store by that name`);
      }
    }
    for (const site of f.calls.unresolved) {
      if (!input.allowed.some((a) => a.file === site.file && a.expr === site.expr)) {
        problems.push(
          `${site.file}:${site.line}: .collection(${site.expr}) can't be resolved to a name: use a string or an UPPER_CASE constant, or list it in the allowlist with the names it reaches and why`,
        );
      }
    }
  }
  for (const a of input.allowed) {
    const f = input.scanned.find((s) => s.file === a.file);
    if (!f || !f.calls.unresolved.some((u) => u.expr === a.expr)) problems.push(`allowlist: ${a.file} no longer has .collection(${a.expr}); remove the entry`);
    if (!a.reason.trim()) problems.push(`allowlist: ${a.file} .collection(${a.expr}) needs a reason`);
    for (const name of a.names) if (!registryHas(name)) problems.push(`allowlist: ${a.file} reaches ${name}, which has no registry entry: ${fix}`);
  }

  // 5. Every Firestore store in the registry is found in the file it names.
  for (const s of firestore) {
    if (s.definedIn === input.repositoryFile) {
      if (!input.repository.some((e) => e.collection === s.collection && e.db === s.db)) {
        problems.push(`registry: ${s.collection} (${s.db}) says ${s.definedIn}, but forTenant has no such collection there`);
      }
      continue;
    }
    const f = input.scanned.find((x) => x.file === s.definedIn);
    if (!f) {
      problems.push(`registry: ${s.collection} says ${s.definedIn}, which the scan doesn't read (src/lib/tenant and workers/*/src)`);
      continue;
    }
    const found =
      f.calls.resolved.some((r) => r.name === s.collection) ||
      input.allowed.some((a) => a.file === s.definedIn && a.names.includes(s.collection));
    if (!found) problems.push(`registry: ${s.collection} says ${s.definedIn}, but no .collection() call there reaches it`);
  }

  // 6. The control plane: the scan and the registry name the same collections.
  const scanControl = new Set([
    ...input.repository.filter((e) => e.db === "control").map((e) => e.collection),
    ...input.scanned.filter((f) => f.home === "control").flatMap((f) => f.calls.resolved.map((r) => r.name)),
  ]);
  const registryControl = new Set(firestore.filter((s) => s.db === "control").map((s) => s.collection));
  for (const name of scanControl) if (!registryControl.has(name)) problems.push(`control plane: the code uses ${name}, which the registry has no control store for: ${fix}`);
  for (const name of registryControl) if (!scanControl.has(name)) problems.push(`control plane: the registry has ${name}, which no control plane code uses`);

  // 7. Every Cloud Storage, BigQuery and Memory Bank writer is named by a store.
  for (const file of input.storeFiles) {
    if (!input.stores.some((s) => s.definedIn === file)) problems.push(`${file} writes to a store outside Firestore but no registry store names it: ${fix}`);
  }
  return problems;
}
