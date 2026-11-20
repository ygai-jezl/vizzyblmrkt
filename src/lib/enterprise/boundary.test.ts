import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The Enterprise boundary as a source scan: only src/lib/enterprise/registry.ts may import from
 * src/ee. ESLint enforces the same rule (eslint.config.mjs), but it skips a specifier it can't
 * resolve and never looks in infra, agents or workers, so this reads every code file instead:
 * src, scripts, sdk, .claude, workers, infra, agents and the code files at the repo root, tests
 * included. The TypeScript parser reads each file, so specifiers in comments and strings never
 * count. It never needs src/ee to exist: CI runs it with the folder deleted.
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const REGISTRY = "src/lib/enterprise/registry.ts";
const SCAN_DIRS = ["src", "scripts", "sdk", ".claude", "workers", "infra", "agents"];
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", ".venv", "coverage", ".git", "__pycache__"]);
const CODE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
/** vi calls that load a module by its specifier. */
const VI_LOADERS = new Set(["mock", "doMock", "unmock", "doUnmock", "importActual", "importMock"]);

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(?:ts|mts|cts)$/.test(file)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

/** import("x"), require("x"), require.resolve("x") and vi.mock("x") and its kin. */
function isLoader(callee: ts.Expression): boolean {
  if (callee.kind === ts.SyntaxKind.ImportKeyword) return true;
  if (ts.isIdentifier(callee)) return callee.text === "require";
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
    const owner = callee.expression.text;
    const name = callee.name.text;
    return (owner === "require" && name === "resolve") || (owner === "vi" && VI_LOADERS.has(name));
  }
  return false;
}

/** Every module specifier in a file, in order. */
function specifiersIn(text: string, file: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, scriptKind(file));
  const found: string[] = [];
  const take = (node: ts.Node | undefined) => {
    if (node && ts.isStringLiteralLike(node)) found.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) take(node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) take(node.moduleReference.expression);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) take(node.argument.literal);
    else if (ts.isCallExpression(node) && isLoader(node.expression)) take(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The repository path a specifier names, from a repository file, or null for a package. */
function resolveSpecifier(specifier: string, file: string): string | null {
  const spec = specifier.replace(/[?#].*$/, "");
  let path: string;
  if (spec.startsWith("@/")) path = posix.join("src", spec.slice(2));
  else if (spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../")) path = posix.join(posix.dirname(file), spec);
  else if (spec.startsWith("src/")) path = posix.normalize(spec);
  else return null;
  return path.replace(/\/+$/, "");
}

const insideEnterprise = (path: string) => path === "src/ee" || path.startsWith("src/ee/");

/** "file: specifier" for each import that reaches src/ee from a file that may not. */
function boundaryProblems(file: string, text: string): string[] {
  if (file === REGISTRY || insideEnterprise(file)) return [];
  return specifiersIn(text, file)
    .filter((spec) => {
      const path = resolveSpecifier(spec, file);
      return path !== null && insideEnterprise(path);
    })
    .map((spec) => `${file}: "${spec}"`);
}

/** Every code file the scan covers, as repository paths. */
function codeFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !insideEnterprise(path)) walk(path);
      } else if (entry.isFile() && CODE_FILE.test(entry.name)) {
        files.push(path);
      }
    }
  };
  for (const dir of SCAN_DIRS) if (existsSync(join(ROOT, dir))) walk(dir);
  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    if (entry.isFile() && CODE_FILE.test(entry.name)) files.push(entry.name);
  }
  return files;
}

describe("the Enterprise boundary scan", () => {
  it("finds every kind of specifier", () => {
    const sample = [
      'import a from "@/ee/a";',
      'import type { B } from "../../ee/b";',
      'import "./side-effect";',
      'export { c } from "src/ee/c";',
      'export * from "@/ee/d";',
      'const e = await import("@/ee/e");',
      'const f = require("../../ee/f");',
      'vi.mock("@/ee/g", () => ({}));',
      'const h = await vi.importActual("@/ee/h");',
      'type I = import("@/ee/i").I;',
      'import J = require("@/ee/j");',
      'const k = require.resolve("@/ee/k");',
      "const l = await import(`@/ee/l`);",
      'import { m } from "zod";',
    ].join("\n");
    expect(specifiersIn(sample, "src/lib/x/y.ts")).toEqual([
      "@/ee/a",
      "../../ee/b",
      "./side-effect",
      "src/ee/c",
      "@/ee/d",
      "@/ee/e",
      "../../ee/f",
      "@/ee/g",
      "@/ee/h",
      "@/ee/i",
      "@/ee/j",
      "@/ee/k",
      "@/ee/l",
      "zod",
    ]);
    // Every one but "./side-effect" and "zod" reaches src/ee.
    expect(boundaryProblems("src/lib/x/y.ts", sample)).toHaveLength(12);
  });

  it("reads JavaScript and JSX files too", () => {
    expect(specifiersIn('const x = require("../src/ee/x.js");\nmodule.exports = x;', "scripts/a.cjs")).toEqual(["../src/ee/x.js"]);
    expect(specifiersIn('import X from "@/ee/x";\nexport const Y = () => <X />;', "src/app/a.tsx")).toEqual(["@/ee/x"]);
  });

  it("ignores specifiers in comments and plain strings", () => {
    const sample = [
      '// import a from "@/ee/a";',
      '/* const b = require("@/ee/b"); */',
      '/** @see import("@/ee/c") */',
      "const d = \"import d from '@/ee/d'\";",
      'const e = "src/ee/e";',
      'const f = load("@/ee/f");',
    ].join("\n");
    expect(specifiersIn(sample, "src/lib/x.ts")).toEqual([]);
  });

  it("resolves relative, alias and src paths to the folder they name", () => {
    expect(resolveSpecifier("../../ee/x", "src/lib/enterprise/a.ts")).toBe("src/ee/x");
    expect(resolveSpecifier("../ee", "src/lib/a.ts")).toBe("src/ee");
    expect(resolveSpecifier("@/ee/", "src/a.ts")).toBe("src/ee");
    expect(resolveSpecifier("src/ee/x?raw", "vitest.config.ts")).toBe("src/ee/x");
    expect(resolveSpecifier("../src/ee/x", "scripts/a.mjs")).toBe("src/ee/x");
    expect(resolveSpecifier("node:fs", "scripts/a.mjs")).toBeNull();
    expect(resolveSpecifier("eslint", "src/a.ts")).toBeNull();
  });

  it("flags src/ee from anywhere, but not a folder that only starts with ee", () => {
    expect(boundaryProblems("scripts/tool.mjs", 'import x from "../src/ee/x/index.ts";')).toEqual([
      'scripts/tool.mjs: "../src/ee/x/index.ts"',
    ]);
    expect(boundaryProblems("src/app/page.tsx", 'import x from "../ee";')).toEqual(['src/app/page.tsx: "../ee"']);
    expect(boundaryProblems(".claude/hooks/a.ts", 'import x from "../../src/ee/x";')).toHaveLength(1);
    expect(boundaryProblems("src/lib/x.ts", 'import a from "@/eeg/x";\nimport b from "../eeg/y";\nimport c from "@/ee-tools";')).toEqual([]);
  });

  it("allows the registry, and files inside src/ee", () => {
    const sample = 'import { sso } from "@/ee/sso";';
    expect(boundaryProblems(REGISTRY, sample)).toEqual([]);
    expect(boundaryProblems("src/ee/scim/index.ts", sample)).toEqual([]);
    expect(boundaryProblems("src/lib/enterprise/licence.ts", sample)).toHaveLength(1);
  });

  it("finds no file outside src/ee and the registry that reaches src/ee", () => {
    const files = codeFiles();
    // The walk really covered the repo.
    expect(files.length).toBeGreaterThan(1000);
    for (const known of ["eslint.config.mjs", "vitest.config.ts", "scripts/check-private-paths.mjs", REGISTRY, "src/lib/enterprise/boundary.test.ts"]) {
      expect(files).toContain(known);
    }
    expect(files.filter(insideEnterprise)).toEqual([]);
    const problems = files.flatMap((file) => boundaryProblems(file, readFileSync(join(ROOT, file), "utf8")));
    expect(problems).toEqual([]);
  }, 30_000);
});
