import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { forTenant } from "@/lib/tenant";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { LOOPS } from "@/lib/loops/registry";
import { ONTOLOGY, storesOf, typeById } from "./registry";
import { FIRESTORE_DBS, type StoreRef } from "./types";
import {
  coverageProblems,
  homeOfFile,
  parseRepository,
  scanCollectionCalls,
  scanStoreImports,
  sourceFiles,
  workerSourceDirs,
  type AllowedUnresolved,
  type ScannedFile,
} from "./storeScan";

/**
 * Every store the code uses has an entry in the ontology registry, and every Firestore entry in
 * the registry is found in the code. A new collection or file store fails here until it is added
 * to src/lib/ontology/registry.ts (then run npm run ontology:doc).
 */

const ROOT = process.cwd();
const REPOSITORY = "src/lib/tenant/repository.ts";
const MEMORY_BANK = "src/lib/agents/memoryBank.ts";
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

/** Calls whose collection is chosen at run time, the names they can reach and why. */
const UNRESOLVED: AllowedUnresolved[] = [
  {
    file: "src/lib/tenant/lifecycleSend.ts",
    expr: "enrolments",
    names: ["lifecycle_enrolments", "waitlist_enrolments"],
    reason: "one send path serves product journeys and waitlist journeys; the caller passes which enrolments it claims",
  },
  {
    file: "workers/knowledge-scraper/src/pipeline.ts",
    expr: "ownerCollection(env.ownerKind)",
    names: ["campaigns", "workspaces"],
    reason: "knowledge belongs to a launch or a programme (workers/knowledge-scraper/src/config.ts ownerCollection)",
  },
];

const ctx: TenantContext = { tenantId: "ten_demo", region: "us", source: "system" };

function scanAll(): { scanned: ScannedFile[]; all: string[] } {
  const tenantFiles = sourceFiles("src/lib/tenant");
  const workerFiles = workerSourceDirs().flatMap((dir) => sourceFiles(dir));
  const scanned = [...tenantFiles, ...workerFiles]
    .filter((file) => file !== REPOSITORY)
    .map((file) => {
      const text = read(file);
      return { file, home: homeOfFile(text), calls: scanCollectionCalls(file, text) };
    });
  return { scanned, all: [...sourceFiles("src"), ...workerFiles] };
}

describe("store coverage", () => {
  const repository = parseRepository(read(REPOSITORY));
  const { scanned, all } = scanAll();
  const storeFiles = [...scanStoreImports(all.map((file) => ({ file, text: read(file) }))), MEMORY_BANK];

  it("reads every collection forTenant gives", () => {
    const keys = Object.keys(forTenant(ctx, new FakeFirestore()));
    expect(repository.length).toBe(keys.length);
    expect(repository.map((e) => e.key).sort()).toEqual([...keys].sort());
  });

  it("finds the stores outside the repository, and the files that write outside Firestore", () => {
    const names = new Set(scanned.flatMap((f) => f.calls.resolved.map((r) => r.name)));
    for (const name of ["tenants", "search_docs", "idea_items", "content_plans", "knowledge_bases", "brand_map_questions", "repo_analyses"]) {
      expect(names.has(name), name).toBe(true);
    }
    expect(storeFiles).toEqual(
      expect.arrayContaining(["src/lib/tenant/auditSink.ts", "src/lib/analytics/bigquery.ts", "src/lib/workspace/assetStore.ts", MEMORY_BANK]),
    );
  });

  it("has a registry entry for every store, and finds every Firestore entry in the code", () => {
    const problems = coverageProblems({ repositoryFile: REPOSITORY, repository, scanned, stores: storesOf(), allowed: UNRESOLVED, storeFiles });
    expect(problems).toEqual([]);
  });

  it("keeps what each kind made, and what each own line learned, in stores the code uses", () => {
    const names = new Set([...repository.map((e) => e.collection), ...scanned.flatMap((f) => f.calls.resolved.map((r) => r.name)), ...UNRESOLVED.flatMap((a) => a.names)]);
    const inCode = (s: StoreRef) => ((FIRESTORE_DBS as readonly string[]).includes(s.db) ? names.has(s.collection) : storeFiles.includes(s.definedIn) || existsSync(join(ROOT, s.definedIn)));
    const holders = ONTOLOGY.filter((t) => t.madeBy.length > 0).map((t) => t.id);
    const learnedIn = Object.values(LOOPS).flatMap((d) => ("own" in d ? [d.own as string] : []));
    for (const id of new Set([...holders, ...learnedIn])) {
      const t = typeById(id);
      expect(t, id).toBeDefined();
      expect(t!.stores.some(inCode), `${id} says it holds what YouGrow made or learned, but the code uses none of its stores`).toBe(true);
    }
  });

  it("gives every allowlisted call a reason", () => {
    for (const a of UNRESOLVED) expect(a.reason.trim(), `${a.file} ${a.expr}`).not.toBe("");
  });
});
