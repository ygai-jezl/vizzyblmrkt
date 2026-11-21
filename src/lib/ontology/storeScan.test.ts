import { describe, expect, it } from "vitest";
import type { StoreRef } from "./types";
import {
  coverageProblems,
  homeOfFile,
  parseRepository,
  scanCollectionCalls,
  scanStoreImports,
  stripComments,
  type CoverageInput,
  type ImportReader,
  type ScannedFile,
} from "./storeScan";

const noImports: ImportReader = () => null;
const scan = (text: string, file = "src/lib/tenant/fixture.ts", readImport: ImportReader = noImports) => scanCollectionCalls(file, text, readImport);
const names = (text: string, readImport?: ImportReader) => scan(text, undefined, readImport).resolved.map((r) => r.name);

describe("stripComments", () => {
  it("blanks line and block comments, keeping lengths and lines", () => {
    const text = 'a // .collection("x")\n/* .collection("y")\n */ b';
    const out = stripComments(text);
    expect(out.length).toBe(text.length);
    expect(out.split("\n").length).toBe(text.split("\n").length);
    expect(out).not.toContain("collection");
    expect(out.trim().startsWith("a")).toBe(true);
    expect(out.trim().endsWith("b")).toBe(true);
  });

  it("leaves a URL inside a string or a template alone", () => {
    const text = 'const u = "https://example.test/a"; const t = `http://x.test/${p}//q`; // gone';
    const out = stripComments(text);
    expect(out).toContain('"https://example.test/a"');
    expect(out).toContain("`http://x.test/${p}//q`");
    expect(out).not.toContain("gone");
  });

  it("doesn't read a regular expression as the start of a comment", () => {
    const text = 'const re = /^\\/*x/; db.collection("kept");';
    expect(stripComments(text)).toContain('db.collection("kept")');
  });
});

describe("parseRepository", () => {
  it("reads every collection, on one line or several, with its database", () => {
    const text = `
      return {
        signups: new TenantCollection<Signup>(regionalDb, "signups", t),
        // old: new TenantCollection<Old>(regionalDb, "old_store", t),
        members: new TenantCollection<TenantUser>(controlDb, "tenant_users", t),
        emailSuppressions: new TenantCollection<EmailSuppression>(
          regionalDb,
          "email_suppressions",
          t,
        ),
      };`;
    expect(parseRepository(text)).toEqual([
      { key: "signups", collection: "signups", db: "regional" },
      { key: "members", collection: "tenant_users", db: "control" },
      { key: "emailSuppressions", collection: "email_suppressions", db: "regional" },
    ]);
  });
});

describe("scanCollectionCalls", () => {
  it("resolves a string, a constant, a map value and a template literal's last segment", () => {
    expect(names('db.collection("signups").doc(id)')).toEqual(["signups"]);
    expect(names('const COLLECTION = "launch_keys";\ndb.collection(COLLECTION)')).toEqual(["launch_keys"]);
    expect(names('export const SEARCH_DOCS = "search_docs" as const;\ndb.collection(`${root}/${SEARCH_DOCS}`)')).toEqual(["search_docs"]);
    expect(names("db.collection(`workspaces/${id}/templates`)")).toEqual(["templates"]);
    expect(names('const OWNER: Record<Kind, string> = {\n  campaign: "campaigns",\n  workspace: "workspaces",\n};\ndb.collection(OWNER[kind])')).toEqual([
      "campaigns",
      "workspaces",
    ]);
  });

  it("resolves a constant imported from a relative file", () => {
    const readImport: ImportReader = (from, spec) =>
      from === "workers/x/src/run.ts" && spec === "./names" ? 'export const ANALYSIS = "repo_analyses";' : null;
    const out = scan('import { ANALYSIS } from "./names";\ndb.collection(ANALYSIS)', "workers/x/src/run.ts", readImport);
    expect(out.resolved.map((r) => r.name)).toEqual(["repo_analyses"]);
  });

  it("reports what it can't resolve, with the file, line and expression", () => {
    const out = scan('const a = 1;\nstore.collection(enrolments);\ndb.collection(ownerCollection(env.kind));\ndb.collection(MISSING);');
    expect(out.resolved).toEqual([]);
    expect(out.unresolved).toEqual([
      { file: "src/lib/tenant/fixture.ts", line: 2, expr: "enrolments" },
      { file: "src/lib/tenant/fixture.ts", line: 3, expr: "ownerCollection(env.kind)" },
      { file: "src/lib/tenant/fixture.ts", line: 4, expr: "MISSING" },
    ]);
  });

  it("ignores calls in comments and strings", () => {
    const text = '// db.collection("a")\n/* db.collection("b") */\nconst s = "db.collection(\\"c\\")";\n// and DocRefLike need not expose a `.collection()`';
    const out = scan(text);
    expect(out.resolved).toEqual([]);
    expect(out.unresolved).toEqual([]);
  });
});

describe("homeOfFile", () => {
  it("tells the control plane, the region and the search database apart", () => {
    expect(homeOfFile("const db = getDb();")).toBe("control");
    expect(homeOfFile('getDb("(default)").collection("tenants")')).toBe("control");
    expect(homeOfFile("getDb(databaseIdForRegion(ctx.region))")).toBe("regional");
    expect(homeOfFile("const db = regionalDb(ctx, db);")).toBe("regional");
    expect(homeOfFile("searchDatabaseIdForRegion(region)")).toBe("search");
    expect(homeOfFile("getDb(); getDb(databaseIdForRegion(r));")).toBe("mixed");
    expect(homeOfFile("export function f(db) {}")).toBe("mixed");
    // A getDb() in a comment says nothing.
    expect(homeOfFile("// for the real getDb()\ngetDb(databaseIdForRegion(r))")).toBe("regional");
  });
});

describe("scanStoreImports", () => {
  it("finds static and dynamic imports of Cloud Storage and BigQuery, not commented ones", () => {
    const files = [
      { file: "a.ts", text: 'import { getStorage } from "firebase-admin/storage";' },
      { file: "b.ts", text: 'const mod = await import("@google-cloud/bigquery");' },
      { file: "c.ts", text: '// import { getStorage } from "firebase-admin/storage";' },
      { file: "d.ts", text: 'import { getDb } from "./firestore";' },
    ];
    expect(scanStoreImports(files)).toEqual(["a.ts", "b.ts"]);
  });
});

describe("coverageProblems", () => {
  const REPO = "src/lib/tenant/repository.ts";
  const store = (collection: string, db: StoreRef["db"], definedIn: string): StoreRef => ({ collection, db, definedIn });
  const file = (path: string, text: string, readImport: ImportReader = noImports): ScannedFile => ({
    file: path,
    home: homeOfFile(text),
    calls: scanCollectionCalls(path, text, readImport),
  });
  const base = (scanned: ScannedFile[], stores: StoreRef[], extra: Partial<CoverageInput> = {}): CoverageInput => ({
    repositoryFile: REPO,
    repository: [{ key: "signups", collection: "signups", db: "regional" }],
    scanned,
    stores: [store("signups", "regional", REPO), ...stores],
    allowed: [],
    storeFiles: [],
    ...extra,
  });
  const REGIONAL = "getDb(databaseIdForRegion(ctx.region))";

  it("passes when the code and the registry agree", () => {
    const f = file("src/lib/tenant/x.ts", `${REGIONAL}.collection("x_store");`);
    expect(coverageProblems(base([f], [store("x_store", "regional", "src/lib/tenant/x.ts")]))).toEqual([]);
  });

  it("fails on an unknown literal, constant, map value and template literal", () => {
    const cases = [
      `${REGIONAL}.collection("y_probe")`,
      `const PROBE = "y_probe";\n${REGIONAL}.collection(PROBE)`,
      `const MAP = { a: "x_store", b: "y_probe" };\n${REGIONAL}.collection(MAP[k])`,
      `const PROBE = "y_probe";\n${REGIONAL}.collection(\`workspaces/\${id}/\${PROBE}\`)`,
    ];
    for (const text of cases) {
      const f = file("src/lib/tenant/x.ts", `${REGIONAL};\n${text};\n${REGIONAL}.collection("x_store");`);
      const problems = coverageProblems(base([f], [store("x_store", "regional", "src/lib/tenant/x.ts")]));
      expect(problems, text).toHaveLength(1);
      expect(problems[0], text).toContain("reaches y_probe, which has no registry entry");
    }
  });

  it("fails on a repository collection the registry doesn't have", () => {
    const problems = coverageProblems(
      base([], [], { repository: [{ key: "signups", collection: "signups", db: "regional" }, { key: "probe", collection: "x_probe", db: "regional" }] }),
    );
    expect(problems.join("\n")).toContain("forTenant's probe (x_probe, regional) has no registry store");
  });

  it("fails on an unresolved call that isn't allowed, and on an allowance that no longer matches", () => {
    const f = file("src/lib/tenant/x.ts", `${REGIONAL};\nstore.collection(which);`);
    expect(coverageProblems(base([f], [])).join("\n")).toContain(".collection(which) can't be resolved");
    const allowed = [{ file: "src/lib/tenant/x.ts", expr: "which", names: ["signups"], reason: "picked by the caller" }];
    expect(coverageProblems(base([f], [], { allowed }))).toEqual([]);
    const stale = [{ file: "src/lib/tenant/x.ts", expr: "gone", names: ["signups"], reason: "old" }];
    expect(coverageProblems(base([f], [], { allowed: [...allowed, ...stale] })).join("\n")).toContain("no longer has .collection(gone)");
  });

  it("checks the database a file reaches against the registry", () => {
    const f = file("src/lib/tenant/x.ts", 'getDb().collection("x_store");');
    const problems = coverageProblems(base([f], [store("x_store", "regional", "src/lib/tenant/x.ts")]));
    expect(problems.join("\n")).toContain("x_store is used in the control database here");
  });

  it("takes the control plane set from the registry, both ways", () => {
    const f = file("src/lib/tenant/orgs.ts", 'getDb().collection("organisations");');
    // The code uses a control collection the registry lacks.
    expect(coverageProblems(base([f], [])).join("\n")).toContain("control plane: the code uses organisations");
    // Registered: passes, with nothing hard coded in the test.
    expect(coverageProblems(base([f], [store("organisations", "control", "src/lib/tenant/orgs.ts")]))).toEqual([]);
    // The registry has a control store no code uses.
    const extra = [store("organisations", "control", "src/lib/tenant/orgs.ts"), store("ghosts", "control", "src/lib/tenant/orgs.ts")];
    const problems = coverageProblems(base([f], extra)).join("\n");
    expect(problems).toContain("control plane: the registry has ghosts");
    expect(problems).toContain("registry: ghosts says src/lib/tenant/orgs.ts, but no .collection() call there reaches it");
  });

  it("fails when a registry store names a file the scan doesn't read", () => {
    const problems = coverageProblems(base([], [store("x_store", "regional", "src/lib/elsewhere.ts")]));
    expect(problems.join("\n")).toContain("which the scan doesn't read");
  });

  it("fails when a file that writes outside Firestore has no store", () => {
    const problems = coverageProblems(base([], [], { storeFiles: ["src/lib/x/files.ts"] }));
    expect(problems.join("\n")).toContain("src/lib/x/files.ts writes to a store outside Firestore");
    const named = [{ collection: "files", db: "gcs" as const, definedIn: "src/lib/x/files.ts", residencyGap: "one bucket" }];
    expect(coverageProblems(base([], named, { storeFiles: ["src/lib/x/files.ts"] }))).toEqual([]);
  });
});
