import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { TenantRepositories } from "@/lib/tenant";
import { sourceFiles, stripComments } from "./storeScan";

/**
 * The event history is append only, and agent actions change only through their writer. The
 * admin SDK ignores Firestore rules, so this is a convention: this source scan (in the style of
 * scripts/config/feature-switches.mjs, comments left out, tests and testing/ folders left out),
 * the repository's type and review keep it. forTenant gives the two stores as a
 * HistoryCollection (src/lib/tenant/repository.ts): reads and the erase's deleteWhere only, so
 * any other write on them fails typecheck however the store is reached.
 *
 * 1. Only the two writers call a mutating method on forTenant's ontologyEvents or agentActions,
 *    whether by property, by a destructured name or across lines; and nobody else reaches them
 *    by a string key or destructures them out of forTenant.
 * 2. Only the writers, the repository and the registry name the two collections, and only the
 *    writers use their collection constants or eventRef, or import a writer whole; everyone else
 *    names a store by its repository key (HistoryStore).
 * 3. In each writer, every set, update or delete sits in a function allowed to change a row.
 * 4. Only agentActions.ts stages agent.* rows.
 * 5. Nothing outside src/lib/tenant imports the two writers directly: @/lib/tenant gives the
 *    context level functions only.
 */

const ROOT = process.cwd();
const EVENTS_WRITER = "src/lib/tenant/ontologyEvents.ts";
const ACTIONS_WRITER = "src/lib/tenant/agentActions.ts";
const WRITERS = [EVENTS_WRITER, ACTIONS_WRITER];

/** The functions in each writer allowed to change or remove a stored row, each with its reason. */
const ALLOWED_CHANGES: Record<string, Record<string, string>> = {
  [EVENTS_WRITER]: {
    blankFieldEvents: "blank an erased archived field",
    repointHistoryPage: "repoint personId and a person subject or target",
    writeRecordWithEvents: "updates the contact, company or campaign record, never an event",
    eraseHistory: "erase a person's, a product user's or a record's history",
  },
  [ACTIONS_WRITER]: {
    stageAgentTransition: "move an action's state, with its agent.* row in the same commit",
    clearAgentActionDetails: "clear a closed action's proposal and basis",
    blankFieldInAgentActions: "blank an erased field in an action's proposal, basis, result and undo",
  },
};

type Problem = string;

const STORE = "(ontologyEvents|agentActions)";
const MUTATOR = "(create|update|upsert|claim|set|delete|deleteWhere|updateWhere)";
/** A writer's module, from inside or outside src/lib/tenant. */
const WRITER_MODULE = String.raw`((?:@\/lib\/tenant\/|(?:\.\.?\/)+(?:[\w.-]+\/)*tenant\/|\.\/)(?:ontologyEvents|agentActions))`;

const MUTATING_CALL = new RegExp(String.raw`(?:\b${STORE}|\[\s*(["'\`])${STORE}\2\s*\])\s*\.\s*${MUTATOR}\s*\(`, "g");
/** A member access by a string key (after a name, a call or an index), not an array literal. */
const STRING_KEY = new RegExp(String.raw`(?<=[$\w)\]]\s*)\[\s*(["'\`])${STORE}\1\s*\]`, "g");
const DESTRUCTURED = /\b(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*(?:await\s+)?forTenant\s*\(/g;
const COLLECTION_LITERAL = /(["'`])(ontology_events|agent_actions)\1/g;
const COLLECTION_CONST = /\b(HISTORY_COLLECTIONS|ONTOLOGY_EVENTS|AGENT_ACTIONS)\b/g;
const NAMED_WRITER_IMPORT = new RegExp(String.raw`\b(?:import|export)\s*(?:type\s+)?\{([^}]*)\}\s*from\s*(["'])${WRITER_MODULE}\2`, "g");
const NAMESPACE_WRITER_IMPORT = new RegExp(String.raw`\b(?:import|export)\s*\*\s*(?:as\s+\w+\s*)?from\s*(["'])${WRITER_MODULE}\1`, "g");
/** Exports of the writers that only the writers may use. */
const WRITER_ONLY = ["eventRef"];
const AGENT_STAGING = /\b(stageAgentEventTx|prepareTrailEvent)\b/g;
const WRITER_IMPORT = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)(["'])((?:@\/lib\/tenant|(?:\.\.?\/)+(?:[\w.-]+\/)*tenant)\/(?:ontologyEvents|agentActions))\1/g;

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** Rules 1, 2, 4 and 5 for one file. */
function fileProblems(file: string, source: string): Problem[] {
  const code = stripComments(source);
  const problems: Problem[] = [];
  const at = (m: RegExpMatchArray) => `${file}:${lineOf(code, m.index ?? 0)}`;
  if (!WRITERS.includes(file)) {
    for (const m of code.matchAll(MUTATING_CALL)) problems.push(`${at(m)}: ${m[0].replace(/\s+/g, "")} outside the writers`);
    for (const m of code.matchAll(STRING_KEY)) problems.push(`${at(m)}: ${m[2]} reached by a string key: read it as forTenant(ctx).${m[2]}`);
    for (const m of code.matchAll(DESTRUCTURED)) {
      const store = /\b(ontologyEvents|agentActions)\b/.exec(m[1]!);
      if (store) problems.push(`${at(m)}: ${store[1]} destructured from forTenant: read it as forTenant(ctx).${store[1]}`);
    }
    for (const m of code.matchAll(COLLECTION_CONST)) problems.push(`${at(m)}: ${m[1]} is for the writers only: use the repository key`);
    for (const m of code.matchAll(NAMESPACE_WRITER_IMPORT)) problems.push(`${at(m)}: imports all of ${m[2]}: import the names you need from @/lib/tenant`);
    for (const m of code.matchAll(NAMED_WRITER_IMPORT)) {
      for (const name of m[1]!.split(",").map((part) => part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim())) {
        if (WRITER_ONLY.includes(name)) problems.push(`${at(m)}: ${name} is for the writers only`);
      }
    }
    if (file !== "src/lib/tenant/repository.ts" && file !== "src/lib/ontology/registry.ts") {
      for (const m of code.matchAll(COLLECTION_LITERAL)) problems.push(`${at(m)}: the ${m[2]} collection is named outside the writers: use the repository key`);
    }
  }
  if (file !== ACTIONS_WRITER && file !== EVENTS_WRITER) {
    for (const m of code.matchAll(AGENT_STAGING)) problems.push(`${at(m)}: ${m[1]} is for ${ACTIONS_WRITER} only`);
  }
  if (!file.startsWith("src/lib/tenant/")) {
    for (const m of code.matchAll(WRITER_IMPORT)) problems.push(`${at(m)}: imports ${m[2]}: use @/lib/tenant`);
  }
  return problems;
}

/** Rule 3: every set, update or delete in a writer, with the top level function it sits in. */
function changeProblems(file: string, source: string, allowed: Record<string, string> = ALLOWED_CHANGES[file] ?? {}): Problem[] {
  const lines = stripComments(source).split("\n");
  const problems: Problem[] = [];
  let current: string | null = null;
  lines.forEach((line, i) => {
    const start = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*=/.exec(line);
    if (start) current = start[1] ?? start[2] ?? null;
    const change = /\.\s*(set|update|delete|deleteWhere|updateWhere)\s*\(/.exec(line);
    if (change && (!current || !(current in allowed))) {
      problems.push(`${file}:${i + 1}: a ${change[1]} in ${current ?? "top level code"}, which may not change a stored row (add it to ALLOWED_CHANGES with a reason only if it must)`);
    }
    if (/^\}/.test(line)) current = null;
  });
  return problems;
}

describe("the append only guard", () => {
  const files = sourceFiles("src");

  it("passes on the code as it is", () => {
    const problems = files.flatMap((file) => fileProblems(file, readFileSync(join(ROOT, file), "utf8")));
    for (const writer of WRITERS) problems.push(...changeProblems(writer, readFileSync(join(ROOT, writer), "utf8")));
    expect(problems).toEqual([]);
    expect(files).toEqual(expect.arrayContaining([...WRITERS, "src/lib/ontology/repoint.ts"]));
  });

  it("gives the two stores through forTenant with reads and the erase's deleteWhere only (checked by typecheck)", () => {
    type Reach = "find" | "getById" | "count" | "deleteWhere";
    expectTypeOf<keyof TenantRepositories["ontologyEvents"]>().toEqualTypeOf<Reach>();
    expectTypeOf<keyof TenantRepositories["agentActions"]>().toEqualTypeOf<Reach>();
  });

  it("gives every allowed change a reason, and each names a function in its writer", () => {
    expect(Object.keys(ALLOWED_CHANGES).sort()).toEqual([...WRITERS].sort());
    for (const [file, allowed] of Object.entries(ALLOWED_CHANGES)) {
      const writer = readFileSync(join(ROOT, file), "utf8");
      for (const [name, reason] of Object.entries(allowed)) {
        expect(reason.trim(), name).not.toBe("");
        expect(new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`).test(writer), `${file} ${name}`).toBe(true);
      }
    }
  });

  it("fails on a mutating call outside the writers", () => {
    const bad = `import { forTenant } from "@/lib/tenant";\nexport async function f(ctx) {\n  await forTenant(ctx).ontologyEvents.update("ev_1", { personId: null });\n  await repo.agentActions.deleteWhere([]);\n}\n`;
    expect(fileProblems("src/lib/audience/somewhere.ts", bad)).toEqual([
      expect.stringContaining("somewhere.ts:3: ontologyEvents.update("),
      expect.stringContaining("somewhere.ts:4: agentActions.deleteWhere("),
    ]);
    expect(fileProblems(EVENTS_WRITER, bad)).toEqual([]);
    // A comment that mentions it is fine, and so are reads.
    expect(fileProblems("src/lib/audience/somewhere.ts", "// repo.ontologyEvents.update( is for the writers\n")).toEqual([]);
    expect(fileProblems("src/lib/audience/somewhere.ts", "await forTenant(ctx).agentActions\n  .find({ limit: 1 });\nconst { events, agentActions } = history;\nconst full = flag ? [\"agentActions\"] : [];\n")).toEqual([]);
  });

  it("fails on a mutating call written across lines, on a destructured store, or by a string key", () => {
    const where = "src/lib/crm/somewhere.ts";
    expect(fileProblems(where, `await repo.ontologyEvents\n  .update(id, { personId: null })\n  .catch(() => {});\n`)).toEqual([expect.stringContaining(`${where}:1: ontologyEvents.update(`)]);
    expect(fileProblems(where, `const { ontologyEvents } = forTenant(ctx);\nawait ontologyEvents.delete(id);\n`)).toEqual([
      expect.stringContaining(`${where}:2: ontologyEvents.delete(`),
      expect.stringContaining(`${where}:1: ontologyEvents destructured from forTenant`),
    ]);
    expect(fileProblems(where, `const { agentActions: actions } = await forTenant(ctx, db);\n`)).toEqual([expect.stringContaining("agentActions destructured from forTenant")]);
    expect(fileProblems(where, `await forTenant(ctx)["agentActions"].update(id, {});\n`)).toEqual([
      expect.stringContaining(`${where}:1: ["agentActions"].update(`),
      expect.stringContaining("agentActions reached by a string key"),
    ]);
  });

  it("keeps the collection constants, eventRef and whole writer imports to the writers", () => {
    const where = "src/lib/tenant/somewhere.ts";
    expect(fileProblems(where, `import { HISTORY_COLLECTIONS } from "./ontologyEvents";\nstore.collection(HISTORY_COLLECTIONS.ontologyEvents);\n`)).toEqual([
      expect.stringContaining(`${where}:1: HISTORY_COLLECTIONS is for the writers only`),
      expect.stringContaining(`${where}:2: HISTORY_COLLECTIONS is for the writers only`),
    ]);
    expect(fileProblems(where, `import { eventRef, appendEvents as add } from "./ontologyEvents";\n`)).toEqual([expect.stringContaining("eventRef is for the writers only")]);
    expect(fileProblems(where, `import * as events from "./ontologyEvents";\n`)).toEqual([expect.stringContaining("imports all of ./ontologyEvents")]);
    expect(fileProblems(where, `import { eraseHistory } from "./ontologyEvents";\n`)).toEqual([]);
    expect(fileProblems(EVENTS_WRITER, `export const ONTOLOGY_EVENTS = "ontology_events";\nexport function eventRef() {}\n`)).toEqual([]);
  });

  it("fails on the collection names outside the writers, the repository and the registry", () => {
    expect(fileProblems("src/lib/ontology/repoint.ts", `const STORE = "ontology_events";\n`)).toEqual([expect.stringContaining("the ontology_events collection")]);
    expect(fileProblems("src/lib/ontology/repoint.ts", "db.collection(`agent_actions`);\n")).toEqual([expect.stringContaining("the agent_actions collection")]);
    expect(fileProblems("src/lib/tenant/repository.ts", `new TenantCollection(regionalDb, "ontology_events", t)\n`)).toEqual([]);
    expect(fileProblems("src/lib/ontology/registry.ts", `regional("agent_actions")\n`)).toEqual([]);
  });

  it("fails on a new set, update or delete in either writer outside the allowed functions", () => {
    const writer = [
      "export async function appendEvents(ctx) {",
      "  txn.update(ref, { personId: null });",
      "  txn.set(ref, row);",
      "}",
      "export async function blankFieldEvents(ctx) {",
      "  txn.update(ref, { blankedAt: now });",
      "}",
      "export async function pruneEvents(ctx) {",
      "  await repo.ontologyEvents",
      "    .deleteWhere([]);",
      "  txn.delete(ref);",
      "}",
    ].join("\n");
    expect(changeProblems(EVENTS_WRITER, writer)).toEqual([
      expect.stringContaining(`${EVENTS_WRITER}:2: a update in appendEvents`),
      expect.stringContaining(`${EVENTS_WRITER}:3: a set in appendEvents`),
      expect.stringContaining(`${EVENTS_WRITER}:10: a deleteWhere in pruneEvents`),
      expect.stringContaining(`${EVENTS_WRITER}:11: a delete in pruneEvents`),
    ]);
    // The agent action writer is held to its own list: an update to an event row there fails too.
    const actions = ["export function proposeAgentAction(txn, store) {", "  txn.update(store.collection(EVENTS).doc(id), { personId: null });", "}"].join("\n");
    expect(changeProblems(ACTIONS_WRITER, actions)).toEqual([expect.stringContaining(`${ACTIONS_WRITER}:2: a update in proposeAgentAction`)]);
    expect(changeProblems(ACTIONS_WRITER, ["export function stageAgentTransition(txn) {", "  txn.update(ref, patch);", "}"].join("\n"))).toEqual([]);
  });

  it("fails on staging agent rows anywhere but the agent action writer", () => {
    expect(fileProblems("src/lib/tenant/recordFieldWrites.ts", `import { stageAgentEventTx } from "./ontologyEvents";\n`)).toEqual([expect.stringContaining("stageAgentEventTx is for")]);
    expect(fileProblems(ACTIONS_WRITER, `import { stageAgentEventTx, prepareTrailEvent } from "./ontologyEvents";\n`)).toEqual([]);
  });

  it("fails on importing the writers from outside src/lib/tenant", () => {
    expect(fileProblems("src/lib/audience/x.ts", `import { stageEvent } from "@/lib/tenant/ontologyEvents";\n`)).toEqual([expect.stringContaining("imports @/lib/tenant/ontologyEvents")]);
    expect(fileProblems("src/lib/ontology/x.ts", `import type { AgentProposal } from "../tenant/agentActions";\n`)).toEqual([expect.stringContaining("imports ../tenant/agentActions")]);
    expect(fileProblems("src/lib/tenant/recordFieldWrites.ts", `import { prepareEventsTx } from "./ontologyEvents";\n`)).toEqual([]);
    expect(fileProblems("src/lib/audience/x.ts", `import { appendEvents } from "@/lib/tenant";\n`)).toEqual([]);
  });
});
