import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Rule 1 of ADR-0014, one door, as a source scan. Only the session door
 * (`ensureAdminAccess` in src/lib/auth/session.ts, behind /api/auth/session) gives an account
 * claims or a session cookie, and token verification, session cookies, custom claims, revoking
 * and deleting Auth users happen only in src/lib/auth. So no other file in src may call those
 * Admin SDK methods or import firebase-admin/auth. Code elsewhere that needs one of them asks
 * src/lib/auth for a function (as /api/auth/session calls revokeAllSessions).
 *
 * The TypeScript parser reads each file, so names in comments and strings never count. Tests
 * are skipped: they mock the SDK.
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** Admin SDK methods that verify, mint, grant, revoke or delete. */
const DOOR_METHODS = new Set([
  "verifyIdToken",
  "verifySessionCookie",
  "createSessionCookie",
  "setCustomUserClaims",
  "revokeRefreshTokens",
  "deleteUser",
  "deleteUsers",
]);

/** firebase-admin's Auth module, by its public path or a deep one. */
const AUTH_MODULE = /^firebase-admin\/(?:lib\/)?auth(?:\/|$)/;

/**
 * The only places allowed to do the above. On dev before this rule, the only files that imported
 * firebase-admin/auth or called these methods were src/lib/auth/session.ts,
 * src/lib/auth/adminAuth.ts and src/lib/dev/seedAdmin.ts.
 */
const ALLOWED: ReadonlyArray<{ path: string; why: string }> = [
  { path: "src/lib/auth/", why: "the door itself, and the auth helpers it is built from" },
  {
    path: "src/lib/dev/seedAdmin.ts",
    why: "creates the local demo admin on the Auth emulator only, with its claims, so `npm run local` and the smoke test can sign in",
  },
];

const SKIP_DIRS = new Set(["node_modules", ".next"]);
const isTest = (file: string) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file);
/** TypeScript and JavaScript sources alike: a .js route could call the Admin SDK just as well. */
const SOURCE = /\.[cm]?[jt]sx?$/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (SOURCE.test(name) && !/\.d\.[cm]?ts$/.test(name) && !isTest(name)) out.push(full);
  }
  return out;
}

/** What a file does that only the door may: "calls verifyIdToken", "imports firebase-admin/auth". */
function doorUses(text: string, file = "file.ts"): string[] {
  const kind = /\.tsx$/.test(file)
    ? ts.ScriptKind.TSX
    : /\.jsx$/.test(file)
      ? ts.ScriptKind.JSX
      : /\.[cm]?js$/.test(file)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind);
  const found: string[] = [];
  const spec = (node: ts.Node | undefined) => {
    if (node && ts.isStringLiteralLike(node) && AUTH_MODULE.test(node.text)) found.push(`imports ${node.text}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) spec(node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) spec(node.moduleReference.expression);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) spec(node.argument.literal);
    else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require")) {
        spec(node.arguments[0]);
      } else {
        const name = ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)
            ? callee.argumentExpression.text
            : null;
        if (name && DOOR_METHODS.has(name)) found.push(`calls ${name}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const toRepoPath = (full: string) => relative(ROOT, full).split(sep).join("/");
const isAllowed = (path: string) => ALLOWED.some((a) => (a.path.endsWith("/") ? path.startsWith(a.path) : path === a.path));

describe("doorUses", () => {
  it("finds calls and imports in any form", () => {
    const text = [
      'import { getAuth } from "firebase-admin/auth";',
      'import type { UserRecord } from "firebase-admin/auth";',
      'export { getAuth as g } from "firebase-admin/auth";',
      'const deep = require("firebase-admin/lib/auth/index");',
      'const lazy = await import("firebase-admin/auth");',
      "await adminAuth().verifyIdToken(token, true);",
      'await auth["setCustomUserClaims"](uid, {});',
      "await auth?.revokeRefreshTokens(uid);",
      "await a.createSessionCookie(t, {}); await a.verifySessionCookie(c, true); await a.deleteUser(u); await a.deleteUsers([u]);",
    ].join("\n");
    expect(doorUses(text)).toEqual([
      "imports firebase-admin/auth",
      "imports firebase-admin/auth",
      "imports firebase-admin/auth",
      "imports firebase-admin/lib/auth/index",
      "imports firebase-admin/auth",
      "calls verifyIdToken",
      "calls setCustomUserClaims",
      "calls revokeRefreshTokens",
      "calls createSessionCookie",
      "calls verifySessionCookie",
      "calls deleteUser",
      "calls deleteUsers",
    ]);
  });

  it("ignores comments, strings, the browser SDK and other methods", () => {
    const text = [
      "// the door calls .verifyIdToken( and .setCustomUserClaims( here",
      '/* import { getAuth } from "firebase-admin/auth"; */',
      'const s = "auth.verifyIdToken(t)";',
      'import { getAuth } from "firebase/auth";',
      'import { getApps } from "firebase-admin/app";',
      "await auth.getUser(uid); await auth.getUsers([]); const f = auth.verifyIdToken;",
      "const x = { verifyIdToken() {} };",
    ].join("\n");
    expect(doorUses(text)).toEqual([]);
  });

  it("reads JavaScript files too, so a .js or .mjs route can't slip past", () => {
    const text = 'import { getAuth } from "firebase-admin/auth";\nawait getAuth().verifyIdToken(t);';
    for (const file of ["route.js", "route.mjs", "route.cjs", "page.jsx"]) {
      expect(doorUses(text, file)).toEqual(["imports firebase-admin/auth", "calls verifyIdToken"]);
    }
  });
});

describe("one door (ADR-0014, rule 1)", () => {
  const files = sourceFiles(join(ROOT, "src"));

  it("scans the app's source (a sanity check on the scan)", () => {
    expect(files.length).toBeGreaterThan(500);
    const session = files.find((f) => toRepoPath(f) === "src/lib/auth/session.ts");
    expect(session).toBeDefined();
    expect(doorUses(readFileSync(session!, "utf8"), session)).toEqual(
      expect.arrayContaining(["calls verifyIdToken", "calls setCustomUserClaims", "calls createSessionCookie", "calls deleteUser"]),
    );
  });

  it("no file outside src/lib/auth (and the dev seed) verifies, mints, grants, revokes or deletes", () => {
    const outside = files
      .map((f) => ({ path: toRepoPath(f), uses: doorUses(readFileSync(f, "utf8"), f) }))
      .filter((f) => f.uses.length > 0 && !isAllowed(f.path))
      .map((f) => `${f.path}: ${f.uses.join(", ")}`);
    // Move the call into a function in src/lib/auth and call that instead.
    expect(outside).toEqual([]);
  });

  it("lists only places that exist", () => {
    for (const a of ALLOWED) expect(existsSync(join(ROOT, a.path)), a.path).toBe(true);
  });
});
