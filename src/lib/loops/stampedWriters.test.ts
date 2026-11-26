import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sourceFiles, stripComments } from "@/lib/ontology/storeScan";

/**
 * The create scan (learning loops step 5, 4.1 of the plan for steps 4 and 5): the records that
 * keep a stamp are created only through the writer that takes `made`, so a new path can't write
 * one and forget to say what made it. A source scan in the style of
 * src/lib/ontology/appendOnly.test.ts (comments, tests and testing/ folders left out):
 *
 * 1. a create, upsert or set on one of these stores, by forTenant's key, by a name it was given
 *    (`const repo = forTenant(ctx).scheduledPosts`) or by the writer's own reference, sits only in
 *    its writer's file, in one of the functions named here;
 * 2. only the files named here reach these collections by name (`.collection("...")`), so nothing
 *    goes around forTenant to create one.
 * The node writer, updateContentPlanNode, is the only writer of a node's stamps; a Save and a
 * create drop them (src/lib/tenant/workspaceContent.stamps.test.ts). Agent actions have their own
 * scan (appendOnly.test.ts): only proposeAgentAction creates one.
 */

const ROOT = process.cwd();

interface Stamped {
  /** forTenant's key for the store, when it has one. */
  key?: string;
  collection: string;
  /** The writer's file, and the functions in it that create a record, each with why. */
  file: string;
  creates: Record<string, string>;
}

const STAMPED: Stamped[] = [
  {
    key: "imageAssets",
    collection: "image_assets",
    file: "src/lib/admin/brandKit.ts",
    creates: { recordImageAsset: "the one image writer, which takes made" },
  },
  {
    key: "scheduledPosts",
    collection: "campaign_scheduled_posts",
    file: "src/lib/distribute/scheduler.ts",
    creates: {
      schedulePost: "takes made, the node's stamp",
      enqueueAutoPlug: "stamps the comment auto_plug, rooted at its post",
      enqueuePerformanceFetch: "a job that only reads a post's numbers, so it makes nothing to stamp",
    },
  },
  {
    key: "emailSends",
    collection: "email_sends",
    file: "src/lib/email/sends.ts",
    creates: {
      sendMetadata: "takes made from the sender",
      upsertEarlierSend: "the webhook's record of an email sent while send records were off: records_off",
    },
  },
  {
    key: "lifecycleDrafts",
    collection: "lifecycle_drafts",
    file: "src/lib/lifecycle/drafts.ts",
    creates: { scheduleDraft: "a pending draft with no line yet; prepareDraft writes the line and its stamp" },
  },
  {
    key: "nextUp",
    collection: "next_up",
    file: "src/lib/nextUp/pick.ts",
    creates: { pickNextUp: "stamps every pick" },
  },
  {
    key: "inviteWaves",
    collection: "invite_waves",
    file: "src/lib/invites/waves.ts",
    creates: { createWaveDraft: "takes made, Vizzy's canvas stamp or person_wrote" },
  },
  {
    collection: "content_plans",
    file: "src/lib/tenant/workspaceContent.ts",
    creates: { createContentPlan: "drops every node's stamps and keeps the plan's own made" },
  },
];

/** Files that reach a stamped collection by name, each with why. */
const NAMED_BY: Record<string, Record<string, string>> = {
  content_plans: { "src/lib/tenant/workspaceContent.ts": "the content plan writer" },
  lifecycle_drafts: { "src/lib/tenant/lifecycleSend.ts": "updates a draft in the send's transaction, never creates one" },
};

const MUTATOR = "(create|upsert|set)";

/** The top level function each line sits in, by its start. */
function functionAt(lines: string[], index: number): string | null {
  for (let i = index; i >= 0; i--) {
    const m = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*=/.exec(lines[i]!);
    if (m) return m[1] ?? m[2] ?? null;
  }
  return null;
}

/** Whether a file can name a stamped store at all: a cheap look before the scan. */
const mentions = (source: string, s: Stamped): boolean => (s.key ? source.includes(s.key) : false) || source.includes(s.collection) || (s.collection === "content_plans" && source.includes("contentPlans("));

/** Creates of a store in one file (comments left out): by key, by a name bound to it, and (for its writer) by its own reference. */
function createsIn(file: string, code: string, s: Stamped): Array<{ line: number; fn: string | null }> {
  const lines = code.split("\n");
  const patterns: RegExp[] = [];
  if (s.key) {
    patterns.push(new RegExp(String.raw`\.\s*${s.key}\s*\.\s*${MUTATOR}\s*\(`));
    const names = new Set<string>();
    for (const m of code.matchAll(new RegExp(String.raw`\b(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?forTenant\s*\([^;()]*(?:\([^;()]*\)[^;()]*)*\)\s*\.\s*${s.key}\b`, "g"))) names.add(m[1]!);
    for (const m of code.matchAll(new RegExp(String.raw`\b(\w+)\s*:\s*ReturnType<typeof forTenant>\[\s*["']${s.key}["']\s*\]`, "g"))) names.add(m[1]!);
    for (const n of names) patterns.push(new RegExp(String.raw`\b${n}\s*\.\s*${MUTATOR}\s*\(`));
  }
  if (file === s.file && s.collection === "content_plans") patterns.push(/\bcontentPlans\s*\([^)]*\)\s*\.\s*doc\s*\([^)]*\)\s*\.\s*(set|create)\s*\(/);
  const out: Array<{ line: number; fn: string | null }> = [];
  lines.forEach((line, i) => {
    if (patterns.some((p) => p.test(line))) out.push({ line: i + 1, fn: functionAt(lines, i) });
  });
  return out;
}

const files = [...sourceFiles("src")];
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

describe("the create scan: stamped records are created only by their writers", () => {
  it("finds each writer's creates where they are named (the scan still sees them)", () => {
    for (const s of STAMPED) {
      const found = createsIn(s.file, stripComments(read(s.file)), s);
      expect(found.length, `${s.collection} in ${s.file}`).toBeGreaterThan(0);
      expect(new Set(found.map((f) => f.fn)), s.collection).toEqual(new Set(Object.keys(s.creates)));
    }
  });

  it("finds no create of a stamped store anywhere else, or outside its writer functions", () => {
    const problems: string[] = [];
    for (const file of files) {
      const source = read(file);
      const near = STAMPED.filter((s) => mentions(source, s));
      if (near.length === 0) continue;
      const code = stripComments(source);
      for (const s of near) {
        for (const c of createsIn(file, code, s)) {
          if (file !== s.file) problems.push(`${file}:${c.line} creates ${s.collection}: create it through ${Object.keys(s.creates).join(" or ")} in ${s.file}, which takes made`);
          else if (!c.fn || !(c.fn in s.creates)) problems.push(`${file}:${c.line} creates ${s.collection} in ${c.fn ?? "top level code"}, which isn't a writer that takes made`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("finds no file reaching a stamped collection by name but the repository and the files named", () => {
    const problems: string[] = [];
    for (const file of files) {
      if (file === "src/lib/tenant/repository.ts") continue;
      const source = read(file);
      if (!source.includes(".collection(")) continue;
      const code = stripComments(source);
      for (const s of STAMPED) {
        const byName = new RegExp(String.raw`\.collection\(\s*(["'\`])[^"'\`]*\b${s.collection}\1`).test(code);
        const constant = s.collection === "content_plans" && /\bCONTENT_PLANS\b/.test(code);
        if ((byName || constant) && !(file in (NAMED_BY[s.collection] ?? {}))) problems.push(`${file} reaches ${s.collection} by name: go through forTenant and ${s.file}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("gives every writer function and named file a reason", () => {
    for (const s of STAMPED) for (const [fn, why] of Object.entries(s.creates)) expect(why.length, `${s.file} ${fn}`).toBeGreaterThan(10);
    for (const byFile of Object.values(NAMED_BY)) for (const why of Object.values(byFile)) expect(why.length).toBeGreaterThan(10);
  });

  it("would catch a new path that creates a stamped record around its writer", () => {
    const s = STAMPED.find((x) => x.key === "scheduledPosts")!;
    const stray = `export async function quickPost(ctx) {\n  const repo = forTenant(ctx).scheduledPosts;\n  await repo.create("p1", {});\n}\n`;
    expect(createsIn("src/lib/distribute/quick.ts", stray, s)).toEqual([{ line: 3, fn: "quickPost" }]);
    const direct = `export async function quickSend(ctx) {\n  await forTenant(ctx).emailSends.upsert("es_1", () => ({}), () => null);\n}\n`;
    expect(createsIn("src/lib/email/quick.ts", direct, STAMPED.find((x) => x.key === "emailSends")!)).toEqual([{ line: 2, fn: "quickSend" }]);
  });
});
