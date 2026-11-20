import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sourceFiles, stripComments } from "./storeScan";

/**
 * The event history is append only, and agent actions change only through their writer. The
 * admin SDK ignores Firestore rules, so this is a convention: this source scan (in the style of
 * scripts/config/feature-switches.mjs, comments left out, tests and testing/ folders left out)
 * and review keep it.
 *
 * 1. Only the two writers call a mutating method on forTenant's ontologyEvents or agentActions.
 * 2. Only the writers, the repository and the registry name the two collections; everyone else
 *    names a store by its repository key (HistoryStore).
 * 3. In the event history's writer, every update sits in a function allowed to change a row.
 * 4. Only agentActions.ts stages agent.* rows.
 * 5. Nothing outside src/lib/tenant imports the two writers directly: @/lib/tenant gives the
 *    context level functions only.
 */

const ROOT = process.cwd();
const EVENTS_WRITER = "src/lib/tenant/ontologyEvents.ts";
const ACTIONS_WRITER = "src/lib/tenant/agentActions.ts";
const WRITERS = [EVENTS_WRITER, ACTIONS_WRITER];

/** The functions in the event history's writer allowed to update, each with its reason. */
const ALLOWED_UPDATES: Record<string, string> = {
  blankFieldEvents: "blank an erased archived field",
  repointHistoryPage: "repoint personId and a person subject or target",
  writeRecordWithEvents: "updates the contact, company or campaign record, never an event",
};

type Problem = string;

const MUTATING_CALL = /\.(ontologyEvents|agentActions)\.(create|update|upsert|claim|delete|deleteWhere|updateWhere)\s*\(/g;
const COLLECTION_LITERAL = /(["'`])(ontology_events|agent_actions)\1/g;
const AGENT_STAGING = /\b(stageAgentEventTx|prepareTrailEvent)\b/g;
const WRITER_IMPORT = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)(["'])((?:@\/lib\/tenant|(?:\.\.?\/)+(?:[\w.-]+\/)*tenant)\/(?:ontologyEvents|agentActions))\1/g;

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

/** Rules 1, 2, 4 and 5 for one file. */
function fileProblems(file: string, source: string): Problem[] {
  const code = stripComments(source);
  const problems: Problem[] = [];
  if (!WRITERS.includes(file)) {
    for (const m of code.matchAll(MUTATING_CALL)) problems.push(`${file}:${lineOf(code, m.index ?? 0)}: ${m[0].trim()} outside the writers`);
    if (file !== "src/lib/tenant/repository.ts" && file !== "src/lib/ontology/registry.ts") {
      for (const m of code.matchAll(COLLECTION_LITERAL)) problems.push(`${file}:${lineOf(code, m.index ?? 0)}: the ${m[2]} collection is named outside the writers: use the repository key`);
    }
  }
  if (file !== ACTIONS_WRITER && file !== EVENTS_WRITER) {
    for (const m of code.matchAll(AGENT_STAGING)) problems.push(`${file}:${lineOf(code, m.index ?? 0)}: ${m[1]} is for ${ACTIONS_WRITER} only`);
  }
  if (!file.startsWith("src/lib/tenant/")) {
    for (const m of code.matchAll(WRITER_IMPORT)) problems.push(`${file}:${lineOf(code, m.index ?? 0)}: imports ${m[2]}: use @/lib/tenant`);
  }
  return problems;
}

/** Rule 3: every update in the event history's writer, with the top level function it sits in. */
function updateProblems(file: string, source: string, allowed: Record<string, string> = ALLOWED_UPDATES): Problem[] {
  const lines = stripComments(source).split("\n");
  const problems: Problem[] = [];
  let current: string | null = null;
  lines.forEach((line, i) => {
    const start = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*=/.exec(line);
    if (start) current = start[1] ?? start[2] ?? null;
    if (/\.update\s*\(/.test(line) && (!current || !(current in allowed))) {
      problems.push(`${file}:${i + 1}: an update in ${current ?? "top level code"}, which may not change a stored row (add it to ALLOWED_UPDATES with a reason only if it must)`);
    }
    if (/^\}/.test(line)) current = null;
  });
  return problems;
}

describe("the append only guard", () => {
  const files = sourceFiles("src");

  it("passes on the code as it is", () => {
    const problems = files.flatMap((file) => fileProblems(file, readFileSync(join(ROOT, file), "utf8")));
    problems.push(...updateProblems(EVENTS_WRITER, readFileSync(join(ROOT, EVENTS_WRITER), "utf8")));
    expect(problems).toEqual([]);
    expect(files).toContain(EVENTS_WRITER);
    expect(files).toContain("src/lib/ontology/repoint.ts");
  });

  it("gives every allowed update a reason, and each names a function in the writer", () => {
    const writer = readFileSync(join(ROOT, EVENTS_WRITER), "utf8");
    for (const [name, reason] of Object.entries(ALLOWED_UPDATES)) {
      expect(reason.trim(), name).not.toBe("");
      expect(new RegExp(`export\\s+async\\s+function\\s+${name}\\b`).test(writer), name).toBe(true);
    }
  });

  it("fails on a mutating call outside the writers", () => {
    const bad = `import { forTenant } from "@/lib/tenant";\nexport async function f(ctx) {\n  await forTenant(ctx).ontologyEvents.update("ev_1", { personId: null });\n  await repo.agentActions.deleteWhere([]);\n}\n`;
    expect(fileProblems("src/lib/audience/somewhere.ts", bad)).toEqual([
      expect.stringContaining("somewhere.ts:3: .ontologyEvents.update("),
      expect.stringContaining("somewhere.ts:4: .agentActions.deleteWhere("),
    ]);
    expect(fileProblems(EVENTS_WRITER, bad)).toEqual([]);
    // A comment that mentions it is fine.
    expect(fileProblems("src/lib/audience/somewhere.ts", "// repo.ontologyEvents.update( is for the writers\n")).toEqual([]);
  });

  it("fails on the collection names outside the writers, the repository and the registry", () => {
    expect(fileProblems("src/lib/ontology/repoint.ts", `const STORE = "ontology_events";\n`)).toEqual([expect.stringContaining("the ontology_events collection")]);
    expect(fileProblems("src/lib/ontology/repoint.ts", "db.collection(`agent_actions`);\n")).toEqual([expect.stringContaining("the agent_actions collection")]);
    expect(fileProblems("src/lib/tenant/repository.ts", `new TenantCollection(regionalDb, "ontology_events", t)\n`)).toEqual([]);
    expect(fileProblems("src/lib/ontology/registry.ts", `regional("agent_actions")\n`)).toEqual([]);
  });

  it("fails on a new update in the event history's writer outside the allowed functions", () => {
    const writer = [
      "export async function appendEvents(ctx) {",
      "  txn.update(ref, { personId: null });",
      "}",
      "export async function blankFieldEvents(ctx) {",
      "  txn.update(ref, { blankedAt: now });",
      "}",
    ].join("\n");
    expect(updateProblems(EVENTS_WRITER, writer)).toEqual([expect.stringContaining(`${EVENTS_WRITER}:2: an update in appendEvents`)]);
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
