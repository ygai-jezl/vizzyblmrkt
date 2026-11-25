import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { CANVAS_KIND_NAMES } from "@/lib/canvas/names";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { MEANINGS } from "@/lib/metrics/meanings";
import { typeById } from "@/lib/ontology/registry";
import { RESOURCES } from "@/lib/plans/resources";
import { DATA_SIGNAL_RULES } from "@/lib/types/dataSignal";
import { BY_LEARNER, decisionKind, LEARNED_STORES, LOOP_RULES, LOOPS, RULE_DECISIONS, type Decision, type Loop } from "./registry";
import { reasonProblems } from "./reason";
import { LOOP_SWITCHES } from "./switches";

/**
 * The learning registry (src/lib/loops/registry.ts): one honest line per place YouGrow makes a
 * choice for a brand. Typecheck already fails on a missing line; these tests check what the types
 * can't: the reasons, the dates, the stores and, for loops that learn, their numbers and switches.
 */

const ROOT = process.cwd();
const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as { load: (text: string) => unknown };

/** The kinds, group by group, as the code defines them at run time. */
const GROUPS: Record<string, readonly string[]> = {
  purposes: [...new Set(Object.values(RESOURCES).flatMap((r) => r.purposes as readonly string[]))],
  canvases: CANVAS_KIND_NAMES.map((n) => `canvas.${n}`),
  signals: [...DATA_SIGNAL_RULES],
  rules: Object.keys(RULE_DECISIONS),
};

const LINES = Object.entries(LOOPS) as Array<[string, Decision]>;

/** The reason a line gives, whatever it decides. */
function reasonOf(d: Decision): string {
  if ("loop" in d) return "";
  if ("fleet" in d) return d.fleet;
  if ("own" in d) return d.why;
  if ("none" in d) return d.none;
  return d.gap;
}

/** A day as YYYY-MM-DD, in UTC. */
const dayOf = (d: Date) => d.toISOString().slice(0, 10);

/** What is wrong with a gap's revisit date, seen from today; a past date is fine (the retro lists it). */
function revisitProblem(revisit: string, today: Date): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(revisit) || dayOf(new Date(`${revisit}T00:00:00Z`)) !== revisit) return `${revisit} is not a real YYYY-MM-DD date`;
  const latest = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + LOOP_RULES.revisitMaxMonths, today.getUTCDate()));
  if (revisit > dayOf(latest)) return `${revisit} is more than ${LOOP_RULES.revisitMaxMonths} months after ${dayOf(today)}`;
  return null;
}

/** Results named after one provider: a loop's slow outcome must hold whatever source a brand connects. */
const VENDOR = /^(?:ga4|cf|linkedin|google)[A-Z]/;
const MAX_SCOPE = 40;

/**
 * What is wrong with a learns(...) or fleetOnly(...) line; empty when it is fine. Every number is a
 * meaning with a direction and a family, the guard never shares the check's family, and so on.
 */
function loopProblems(kind: string, d: Decision, switchesOff: ReadonlySet<string>): string[] {
  if (!("loop" in d) && !("fleet" in d)) return [];
  const out: string[] = [];
  const how = "loop" in d ? d.loop : d;
  const meanings = MEANINGS as unknown as Record<string, { better?: string; family?: string }>;
  const meaning = (k: string) => (Object.prototype.hasOwnProperty.call(meanings, k) ? meanings[k] : undefined);
  const named: Array<[string, string]> = [["check", how.check], ["guard", how.guard], ...(how.results ?? []).map((r): [string, string] => ["result", r])];
  for (const [role, k] of named) {
    const m = meaning(k);
    if (!m) out.push(`${kind}: its ${role} ${k} is not a key in src/lib/metrics/meanings.ts`);
    else if (!m.better || !m.family) out.push(`${kind}: its ${role} ${k} needs better and family in src/lib/metrics/meanings.ts`);
  }
  const check = meaning(how.check);
  const guard = meaning(how.guard);
  if (check?.family && guard?.family && check.family === guard.family) out.push(`${kind}: its guard ${how.guard} shares the family ${check.family} with its check ${how.check}`);
  for (const r of how.results ?? []) if (VENDOR.test(r)) out.push(`${kind}: the result ${r} is named after one provider`);
  if (!(how.band > 0 && how.band < 1)) out.push(`${kind}: its band ${how.band} is not between 0 and 1`);
  if ("fleet" in d) {
    const why = reasonProblems(d.fleet);
    if (why.length) out.push(`${kind}: its reason is ${why.join(", ")}`);
  }
  if ("loop" in d) {
    const loop = d.loop;
    if (!loop.scopes.length) out.push(`${kind}: it learns in no scope`);
    for (const s of loop.scopes) if (!s || s.length > MAX_SCOPE) out.push(`${kind}: the scope "${s}" is empty or longer than ${MAX_SCOPE} characters`);
    if (loop.mode === "suggest_only" && loop.learner === "votes") out.push(`${kind}: a suggest only loop never learns from votes`);
    if (!Object.prototype.hasOwnProperty.call(LOOP_SWITCHES, loop.switch)) out.push(`${kind}: its switch ${loop.switch} is not in src/lib/loops/switches.ts`);
    if (!switchesOff.has(loop.switch)) out.push(`${kind}: its switch ${loop.switch} is not listed "false" in apphosting.yaml`);
  }
  return out;
}

/** The switches the public apphosting.yaml lists off. */
function switchesListedOff(): Set<string> {
  const doc = yaml.load(readFileSync(join(ROOT, "apphosting.yaml"), "utf8")) as { env?: Array<{ variable: string; value?: string }> };
  return new Set((doc.env ?? []).filter((e) => e.value === "false").map((e) => e.variable));
}

/** Every non-test source file under src, for the switch read scan. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("the learning registry", () => {
  it("has one line for every kind, and the four groups never share a name", () => {
    const groups = Object.entries(GROUPS);
    for (const [a, aKinds] of groups) {
      expect(aKinds.length, a).toBeGreaterThan(0);
      for (const [b, bKinds] of groups) if (a < b) expect(aKinds.filter((k) => bKinds.includes(k)), `${a} and ${b}`).toEqual([]);
    }
    const all = groups.flatMap(([, kinds]) => kinds);
    expect(new Set(all).size).toBe(all.length);
    expect(Object.keys(LOOPS).sort()).toEqual([...all].sort());
    // A canvas's bare name never reads as another kind either.
    for (const n of CANVAS_KIND_NAMES) expect(all, n).not.toContain(n);
  });

  it("gives every line one plain reason of its own", () => {
    for (const [kind, d] of LINES) {
      if ("loop" in d) continue;
      expect(reasonProblems(reasonOf(d)), kind).toEqual([]);
    }
    const reasons = LINES.map(([, d]) => reasonOf(d)).filter(Boolean);
    const repeated = reasons.filter((r, i) => reasons.indexOf(r) !== i);
    expect(repeated, "two lines share a reason, so at least one is stock text").toEqual([]);
  });

  it("dates every gap within six months of today, and never fails on a date that has passed", () => {
    const today = new Date();
    for (const [kind, d] of LINES) if ("gap" in d) expect(revisitProblem(d.revisit, today), kind).toBeNull();
    const on = new Date("2026-11-25T12:00:00Z");
    expect(revisitProblem("2026-01-01", on)).toBeNull();
    expect(revisitProblem("2027-05-25", on)).toBeNull();
    expect(revisitProblem("2027-05-26", on)).toMatch(/more than 6 months/);
    expect(revisitProblem("2027-02-30", on)).toMatch(/not a real/);
    expect(revisitProblem("27-1-1", on)).toMatch(/not a real/);
  });

  it("names a built ontology type that keeps what people taught it on every own line", () => {
    const owned = new Set<string>();
    for (const [kind, d] of LINES) {
      if (!("own" in d)) continue;
      owned.add(d.own);
      expect(Object.keys(LEARNED_STORES), kind).toContain(d.own);
      expect(typeById(d.own)?.status, `${kind} names ${d.own}`).toBe("built");
    }
    for (const [id, where] of Object.entries(LEARNED_STORES)) {
      expect(typeById(id)?.status, `${id} in LEARNED_STORES`).toBe("built");
      expect(owned.has(id), `${id} in LEARNED_STORES is named by no own line; remove it`).toBe(true);
      expect(reasonProblems(where), id).toEqual([]);
    }
  });

  it("checks every loop that learns, today none, by its numbers, scopes, mode and switch", () => {
    const off = switchesListedOff();
    for (const [kind, d] of LINES) expect(loopProblems(kind, d, off), kind).toEqual([]);
    expect(LINES.filter(([, d]) => decisionKind(d) === "learns" || decisionKind(d) === "fleet")).toEqual([]);
  });

  it("would catch a loop line that breaks a rule (the check above is not empty by accident)", () => {
    const off = new Set(["LOOP_TEST_ENABLED"]);
    const loop = (more: Partial<Loop>): Decision => ({ loop: { switch: "LOOP_TEST_ENABLED" as never, learner: "edits", scopes: ["linkedin"], ...BY_LEARNER.edits, ...more } });
    // The switch alone fails: no such switch in switches.ts.
    expect(loopProblems("t", loop({}), off)).toEqual(["t: its switch LOOP_TEST_ENABLED is not in src/lib/loops/switches.ts"]);
    const rest = (d: Decision) => loopProblems("t", d, off).filter((p) => !p.includes("switches.ts"));
    expect(rest(loop({ results: ["engagementRate", "openRate"] }))).toEqual([]);
    expect(rest(loop({ guard: "keptShare" }))).toEqual(["t: its guard keptShare shares the family taste with its check editShare"]);
    expect(rest(loop({ check: "sends" }))).toEqual(["t: its check sends needs better and family in src/lib/metrics/meanings.ts"]);
    expect(rest(loop({ results: ["ga4KeyEvents"] }))).toContain("t: the result ga4KeyEvents is named after one provider");
    expect(rest(loop({ scopes: ["x".repeat(41)] }))).toEqual([`t: the scope "${"x".repeat(41)}" is empty or longer than 40 characters`]);
    expect(rest(loop({ learner: "votes", mode: "suggest_only" }))).toEqual(["t: a suggest only loop never learns from votes"]);
    expect(rest(loop({ band: 0 }))).toEqual(["t: its band 0 is not between 0 and 1"]);
    expect(loopProblems("t", loop({ switch: "LOOP_OTHER_ENABLED" as never }), off)).toContain('t: its switch LOOP_OTHER_ENABLED is not listed "false" in apphosting.yaml');
    const fleet: Decision = { fleet: "Too short.", check: "openRate", guard: "clickRate", band: 0.02 };
    expect(loopProblems("t", fleet, off)).toEqual([
      "t: its guard clickRate shares the family result with its check openRate",
      `t: its reason is shorter than 30 characters`,
    ]);
  });

  it("gives each learner a check and guard that the rules accept", () => {
    for (const [learner, how] of Object.entries(BY_LEARNER)) {
      const d: Decision = { fleet: `The ${learner} learner's own defaults, checked as a line would be.`, check: how.check, guard: how.guard, band: how.band };
      expect(loopProblems(learner, d, new Set()), learner).toEqual([]);
    }
  });

  it("lists each loop switch off in apphosting.yaml and reads it only in switches.ts", () => {
    const off = switchesListedOff();
    const switchesFile = join(ROOT, "src", "lib", "loops", "switches.ts");
    const own = readFileSync(switchesFile, "utf8");
    const files = sourceFiles(join(ROOT, "src")).filter((f) => f !== switchesFile);
    for (const sw of Object.keys(LOOP_SWITCHES)) {
      expect(off.has(sw), `${sw} is not listed "false" in apphosting.yaml`).toBe(true);
      expect(own, sw).toContain(`process.env.${sw} === "true"`);
      const readers = files.filter((f) => readFileSync(f, "utf8").includes(`process.env.${sw}`));
      expect(readers, `${sw} is read outside src/lib/loops/switches.ts`).toEqual([]);
    }
  });

  it("names a real file and a plain label for every rule decision", () => {
    const labels = Object.values(RULE_DECISIONS).map((r) => r.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const [key, r] of Object.entries(RULE_DECISIONS)) {
      expect(key, key).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(existsSync(join(ROOT, r.file)), `${key}: ${r.file}`).toBe(true);
      expect([...dashesIn(r.label), ...aiTellsIn(r.label)], key).toEqual([]);
    }
  });

  it("gives every number in LOOP_RULES its reason in the file", () => {
    const text = readFileSync(join(ROOT, "src", "lib", "loops", "registry.ts"), "utf8");
    const block = text.slice(text.indexOf("export const LOOP_RULES"), text.indexOf("} as const;", text.indexOf("export const LOOP_RULES")));
    const lines = block.split("\n");
    for (const key of Object.keys(LOOP_RULES)) {
      const at = lines.findIndex((l) => new RegExp(`^\\s+${key}:`).test(l));
      expect(at, key).toBeGreaterThan(0);
      const comment = lines[at - 1]!.trim();
      expect(comment, `${key} needs a one line reason comment above it`).toMatch(/^\/\*\* .{20,} \*\/$/);
      expect([...dashesIn(comment), ...aiTellsIn(comment)], key).toEqual([]);
    }
  });
});

describe("reasonProblems", () => {
  it("accepts one plain sentence about the choice", () => {
    expect(reasonProblems("Hearth Bakery's posts learn from how its team edits them.")).toEqual([]);
  });

  it("rejects stock text, short text, dashes, AI tells and two sentences", () => {
    expect(reasonProblems("Not needed.")).toEqual(expect.arrayContaining(["shorter than 30 characters", "stock text, not a reason"]));
    expect(reasonProblems("TODO: decide whether this one should learn.")).toContain("stock text, not a reason");
    expect(reasonProblems("Not applicable to this particular choice at all.")).toContain("stock text, not a reason");
    expect(reasonProblems("It learns from edits — once the team has made a few.")).toEqual([expect.stringMatching(/^a dash as punctuation/)]);
    expect(reasonProblems("It would leverage every edit the team makes to a draft.")).toEqual(["an AI tell: leverage"]);
    expect(reasonProblems("It learns from edits. Then it learns from votes too.")).toEqual(["more than one sentence"]);
    expect(reasonProblems("It learns from edits the team makes to every draft")).toEqual(["does not end with a full stop"]);
  });
});
