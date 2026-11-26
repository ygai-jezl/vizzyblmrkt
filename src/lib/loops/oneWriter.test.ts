import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sourceFiles, stripComments } from "@/lib/ontology/storeScan";
import { reasonProblems } from "./reason";

/**
 * The one writer (learning loops step 4, 3.4 of the plan for steps 4 and 5): what a loop learns
 * reaches a brand only through src/lib/loops/write.ts, called only by the learners in
 * src/lib/loops/learners/, and a learner never reads text from outside the brand's own votes.
 * Today's learned writers from before the loops are frozen to the files that call them now, each
 * with its reason; the list may only shrink, as each one moves onto the one writer.
 *
 * Plain text scans of the source, comments left out.
 */

const ROOT = process.cwd();
const FILES = sourceFiles("src", ROOT).map((file) => ({ file, code: stripComments(readFileSync(join(ROOT, file), "utf8")) }));

/** Files whose code names this identifier. */
const using = (name: string) => FILES.filter((f) => new RegExp(`\\b${name}\\b`).test(f.code)).map((f) => f.file).sort();

/** Every module a file imports, as written. */
const importsOf = (code: string): string[] => [...code.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g)].map((m) => m[1]!);

const under = (dir: string) => FILES.filter((f) => f.file.startsWith(`${dir}/`));

/**
 * The learned writers from before the loops, each frozen to the files that name it today: its
 * definition, the tenant layer's index where it is passed on, and its callers. A new caller fails
 * here. When a writer moves onto proposeLearned, its entry shrinks or goes.
 */
const LEGACY_WRITERS: Record<string, { files: readonly string[]; why: string }> = {
  setTenantLearnedImageStyle: {
    files: ["src/lib/content/create/styleProfile.ts", "src/lib/tenant/control.ts"],
    why: "The brand look learned from image votes before versions, kept on the brand record and used only while image style versions are off.",
  },
  setTenantStyleLearned: {
    files: ["src/lib/content/create/styleProfile.ts", "src/lib/tenant/control.ts"],
    why: "Each style's look learned from image votes before versions, kept on the brand record and used only while image style versions are off.",
  },
  setTenantLearnedChannelPatterns: {
    files: ["src/lib/distribute/feedback/patterns.ts", "src/lib/tenant/control.ts", "src/lib/tenant/index.ts"],
    why: "The post patterns lane keeps the patterns in use for each channel on the brand record, learned from how the brand's own posts did.",
  },
  recordExemplar: {
    files: ["src/lib/distribute/feedback/patterns.ts", "src/lib/distribute/feedback/reconcile.ts", "src/lib/distribute/feedback/recordExemplar.ts"],
    why: "The best posts are kept from the brand's own post results, which the post patterns lane learns from.",
  },
  addLearned: {
    files: ["src/lib/autopilot/adminApi.ts", "src/lib/autopilot/learned.ts", "src/lib/contentStrategy/adminApi.ts", "src/lib/nextUp/repeats.ts"],
    why: "The Learned list keeps what a person skipped, moved or added while planning, with the reason they gave.",
  },
  learnFromEdits: {
    files: ["src/app/api/admin/editor/vizzy/learn/route.ts", "src/lib/agents/memoryBank.ts"],
    why: "Memory Bank learns how each team member edits in Edit mode, behind its plan key and each person's own choice.",
  },
  learnFromEventTexts: {
    files: ["src/lib/agents/memoryBank.ts", "src/lib/distribute/learnFromPostEdit.ts"],
    why: "Memory Bank learns how each team member edits a post before it is published, behind its plan key and each person's own choice.",
  },
  appendPatternVersion: {
    files: ["src/lib/distribute/feedback/patterns.ts", "src/lib/tenant/index.ts", "src/lib/tenant/patternVersions.ts"],
    why: "The post patterns lane writes each version of a channel's patterns outside a transaction, as it did before the loops.",
  },
};

/**
 * What these writers keep that a learner must not take for a person's own words. addLearned
 * stores the text it is given under from: "person" because a person chose to skip or add it, yet
 * that text can be words research found, such as a question's text or an article's title.
 */
const TRUST_NOTES: Partial<Record<keyof typeof LEGACY_WRITERS, string>> = {
  addLearned: "It keeps research's words, such as a question or an article title, under from person because a person acted on them, so a learner must never read them as a person's own words.",
};

/** Exports of the tenant layer whose names hold "learn" and write nothing learned, each with its reason. */
const TENANT_LEARN_HELPERS: Record<string, string> = {
  withPreservedLearnedStyle: "It carries the learned looks over when the brand kit is saved, so a save never wipes them, and writes nothing new itself.",
};

/** Where the version row and the brand's pointer are written together: the one writer, the seed, and later the person actions. */
const TOGETHER_WRITERS: Record<string, readonly string[]> = {
  appendPatternVersionTx: ["src/lib/loops/seed.ts", "src/lib/loops/write.ts", "src/lib/tenant/patternVersions.ts"],
  writeBrandPointersTx: ["src/lib/loops/seed.ts", "src/lib/loops/write.ts", "src/lib/tenant/loops.ts"],
};

describe("the one writer", () => {
  it("is called only by the learners in src/lib/loops/learners/", () => {
    const callers = using("proposeLearned").filter((f) => f !== "src/lib/loops/write.ts");
    expect(callers.length).toBeGreaterThan(0);
    for (const f of callers) expect(f, `${f} calls proposeLearned`).toMatch(/^src\/lib\/loops\/learners\//);
  });

  it("is the only place, with the seed and the person actions to come, that writes a version row and its pointer together", () => {
    for (const [name, files] of Object.entries(TOGETHER_WRITERS)) expect(using(name), name).toEqual([...files].sort());
  });

  it("keeps today's learned writers to the files that name them now, each with its reason", () => {
    for (const [name, { files, why }] of Object.entries(LEGACY_WRITERS)) {
      expect(using(name), `${name}: a new caller writes learning around the one writer; move it onto proposeLearned instead`).toEqual([...files].sort());
      expect(reasonProblems(why), name).toEqual([]);
    }
    for (const [name, note] of Object.entries(TRUST_NOTES)) {
      expect(name in LEGACY_WRITERS, name).toBe(true);
      expect(reasonProblems(note!), name).toEqual([]);
    }
  });

  it("knows every export of the tenant layer whose name holds learn", () => {
    const found = under("src/lib/tenant").flatMap((f) =>
      [...f.code.matchAll(/export\s+(?:async\s+)?function\s+(\w*[Ll]earn\w*)|export\s+const\s+(\w*[Ll]earn\w*)\s*=\s*(?:async\s*)?(?:\(|function\b)/g)].map((m) => (m[1] ?? m[2])!),
    );
    expect(found.length).toBeGreaterThan(0);
    for (const name of found) {
      expect(name in LEGACY_WRITERS || name in TENANT_LEARN_HELPERS, `${name} in src/lib/tenant: a learned writer goes through proposeLearned, or onto LEGACY_WRITERS with its reason`).toBe(true);
    }
    for (const why of Object.values(TENANT_LEARN_HELPERS)) expect(reasonProblems(why)).toEqual([]);
  });
});

describe("what the loops may not do", () => {
  const loops = under("src/lib/loops");

  it("never gates or meters learning: no brandCanUse, no METERED_FEATURES, no meter check", () => {
    for (const f of loops) {
      expect(f.code, f.file).not.toMatch(/\bbrandCanUse\b/);
      expect(f.code, f.file).not.toMatch(/\bMETERED_FEATURES\b/);
      expect(f.code, f.file).not.toMatch(/\.check\(/);
    }
  });

  it("makes no outbound network call", () => {
    for (const f of loops) {
      expect(f.code, f.file).not.toMatch(/\bfetch\(/);
      for (const m of importsOf(f.code)) expect(m, f.file).not.toMatch(/^(?:node:)?(?:https?|net|tls|dgram)$|^(?:axios|undici|node-fetch)$/);
    }
  });

  it("keeps the learners away from connectors, competitors, knowledge, search and agent routes", () => {
    const learners = under("src/lib/loops/learners");
    expect(learners.length).toBeGreaterThan(0);
    for (const f of learners) {
      for (const m of importsOf(f.code)) {
        expect(m, f.file).not.toMatch(/^@\/lib\/(?:connectors|competitors|knowledge|search)(?:\/|$)/);
        expect(m, f.file).not.toMatch(/^@\/lib\/agents\/(?:knowledge\w*|embeddings)$|^@\/lib\/tenant\/(?:knowledge|searchIndex)$/);
        expect(m, f.file).not.toMatch(/^@\/app\/api\/agent(?:\/|$)/);
      }
    }
  });

  it("keeps Vizzy's routes from writing what was learned", () => {
    const agent = under("src/app/api/agent");
    expect(agent.length).toBeGreaterThan(0);
    for (const f of agent) {
      for (const m of importsOf(f.code)) expect(m, f.file).not.toMatch(/^@\/lib\/loops\/(?:write|actions|learners)(?:\/|$)/);
      expect(f.code, f.file).not.toMatch(/\b(?:proposeLearned|appendPatternVersionTx|writeBrandPointersTx)\b/);
    }
  });
});
