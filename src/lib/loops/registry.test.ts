import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { CANVAS_KIND_NAMES } from "@/lib/canvas/names";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { MEANINGS } from "@/lib/metrics/meanings";
import { typeById } from "@/lib/ontology/registry";
import { sourceFiles } from "@/lib/ontology/storeScan";
import { RESOURCES } from "@/lib/plans/resources";
import { METERED_FEATURES } from "@/lib/plans/brandAccess";
import { IMAGE_STYLES } from "@/lib/content/imageStyle/catalogue";
import { learnsFromThumbs } from "@/lib/content/imageStyle/learning";
import { DATA_SIGNAL_RULES } from "@/lib/types/dataSignal";
import { BY_LEARNER, decisionKind, IMAGE_STYLE_SCOPES, LEARNED_STORES, LOOP_RULES, LOOPS, RULE_DECISIONS, UNMETERED_CALLS, VENDOR, type Decision, type Loop } from "./registry";
import { reasonProblems } from "./reason";
import { LOOP_SWITCHES } from "./switches";
import { SWITCHES_BEFORE_LOOPS } from "./testing/switchesBeforeLoops";

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
  unmetered: Object.keys(UNMETERED_CALLS),
};

const LINES = Object.entries(LOOPS) as Array<[string, Decision]>;

/**
 * Plan keys that hold learning back, each with its reason. Learning is never metered (decision 1
 * of the plan for steps 4 and 5): this one is from before the loops and leaves with step 7.
 */
const LEGACY_METERED_LEARNING: Record<string, string> = {
  edit_vizzy_learning: "Memory Bank learning from edits came with its plan key before the loops, and the edits loop in step 7 takes the key away.",
};

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

const SWITCHES_FILE = "src/lib/loops/switches.ts";

/** What the switch check reads: the lists, the switches file and every other source file. */
interface SwitchScan {
  /** Switches apphosting.yaml lists "false". */
  off: ReadonlySet<string>;
  /** The frozen list of switches from before the loops (testing/switchesBeforeLoops.ts). */
  before: ReadonlySet<string>;
  /** The text of src/lib/loops/switches.ts. */
  switchesText: string;
  /** Every other source file under src, repo relative, with its text. */
  others: ReadonlyArray<{ file: string; text: string }>;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Any read of a variable, as process.env.X or process.env["X"]. */
const readsOf = (sw: string) => new RegExp(`process\\.env(?:\\.${escapeRe(sw)}\\b|\\[\\s*["'\`]${escapeRe(sw)}["'\`]\\s*\\])`, "g");

/**
 * What is wrong with one loop switch; empty when it is fine. It is listed "false", it is new since
 * the loops began, it is read exactly once in switches.ts as === "true", and nowhere else. Pure.
 */
function switchProblems(sw: string, scan: SwitchScan): string[] {
  const out: string[] = [];
  if (!scan.off.has(sw)) out.push(`${sw} is not listed "false" in apphosting.yaml`);
  if (scan.before.has(sw)) out.push(`${sw} is a switch from before the loops; a loop gets a new one`);
  const reads = [...scan.switchesText.matchAll(readsOf(sw))].length;
  const exact = scan.switchesText.split(`process.env.${sw} === "true"`).length - 1;
  if (reads !== 1 || exact !== 1) out.push(`${sw} is not read exactly once in ${SWITCHES_FILE}, as process.env.${sw} === "true"`);
  const readers = scan.others.filter((f) => f.file !== SWITCHES_FILE && readsOf(sw).test(f.text)).map((f) => f.file);
  if (readers.length) out.push(`${sw} is read outside ${SWITCHES_FILE}: ${readers.join(", ")}`);
  return out;
}

describe("the learning registry", () => {
  it("has one line for every kind, and the five groups never share a name", () => {
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

  it("checks every loop that learns, the image kinds, by its numbers, scopes, mode and switch", () => {
    const off = switchesListedOff();
    for (const [kind, d] of LINES) expect(loopProblems(kind, d, off), kind).toEqual([]);
    // Step 4: the five image kinds learn one look per style from votes; nothing is fleet only yet.
    const learning = LINES.filter(([, d]) => decisionKind(d) === "learns").map(([k]) => k);
    expect(learning.sort()).toEqual(["blog_hero", "ebook_image", "email_block_image", "email_hero", "post_image"]);
    for (const k of learning) {
      expect(LOOPS[k as keyof typeof LOOPS], k).toEqual({
        loop: { switch: "IMAGE_STYLE_VERSIONS_ENABLED", learner: "votes", scopes: IMAGE_STYLE_SCOPES, ...BY_LEARNER.votes, pool: "image_style" },
      });
    }
    expect(LINES.filter(([, d]) => decisionKind(d) === "fleet")).toEqual([]);
    // Customise and carousels never take a learned look; the learners themselves never learn.
    for (const k of ["customize_image", "carousel", "images", "loop_learn"] as const) expect(decisionKind(LOOPS[k]), k).toBe("none");
  });

  it("learns images in one scope per painted style, and the brand look", () => {
    const painted = IMAGE_STYLES.filter((s) => s.engine === "model").map((s) => `image_style.${s.id}`);
    expect([...IMAGE_STYLE_SCOPES].sort()).toEqual([...painted, "image_style.brand"].sort());
    for (const s of IMAGE_STYLES) expect(learnsFromThumbs(s.id), s.id).toBe(IMAGE_STYLE_SCOPES.includes(`image_style.${s.id}` as never));
  });

  it("keeps learning off the meter: loop_learn is counted and never capped, and no plan key meters learning but the one from before", () => {
    expect(RESOURCES.model_tokens.purposes).toContain("loop_learn");
    expect(RESOURCES.model_tokens.capped).toBe(false);
    const learningKeys = METERED_FEATURES.filter((f) => /learn|loop/.test(f));
    expect(learningKeys).toEqual(Object.keys(LEGACY_METERED_LEARNING));
    for (const why of Object.values(LEGACY_METERED_LEARNING)) expect(reasonProblems(why)).toEqual([]);
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

  it("has the image style switch, and holds each one to its rules: off, new, and read once in switches.ts", () => {
    // The image style loop (step 4) adds the first switch. LOOPS_ENABLED is the platform's switch,
    // never a loop's own, so it is not here (src/lib/loops/flags.test.ts).
    expect(Object.keys(LOOP_SWITCHES)).toEqual(["IMAGE_STYLE_VERSIONS_ENABLED"]);
    const files = sourceFiles("src", ROOT);
    // The scan sees the source, in the same repo relative form as SWITCHES_FILE.
    expect(files).toContain(SWITCHES_FILE);
    expect(files.length).toBeGreaterThan(1000);
    const scan: SwitchScan = {
      off: switchesListedOff(),
      before: new Set(SWITCHES_BEFORE_LOOPS),
      switchesText: readFileSync(join(ROOT, SWITCHES_FILE), "utf8"),
      others: files.filter((f) => f !== SWITCHES_FILE).map((file) => ({ file, text: readFileSync(join(ROOT, file), "utf8") })),
    };
    for (const sw of Object.keys(LOOP_SWITCHES)) expect(switchProblems(sw, scan), sw).toEqual([]);
  });

  it("would catch a loop switch that breaks a rule (the check above is not empty by accident)", () => {
    const good = 'export const LOOP_SWITCHES = { LOOP_A_ENABLED: () => process.env.LOOP_A_ENABLED === "true" };';
    const scan = (more: Partial<SwitchScan> = {}): SwitchScan => ({
      off: new Set(["LOOP_A_ENABLED", "OLD_FEATURE_ENABLED"]),
      before: new Set(["OLD_FEATURE_ENABLED"]),
      switchesText: good,
      others: [{ file: "src/lib/other.ts", text: 'if (process.env.SOME_FEATURE_ENABLED === "true") run();' }],
      ...more,
    });
    const once = (sw: string) => `${sw} is not read exactly once in src/lib/loops/switches.ts, as process.env.${sw} === "true"`;
    expect(switchProblems("LOOP_A_ENABLED", scan())).toEqual([]);
    // Missing from apphosting.yaml.
    expect(switchProblems("LOOP_B_ENABLED", scan({ switchesText: good.replace(/LOOP_A/g, "LOOP_B") }))).toEqual(['LOOP_B_ENABLED is not listed "false" in apphosting.yaml']);
    // A switch from before the loops.
    expect(switchProblems("OLD_FEATURE_ENABLED", scan({ switchesText: good.replace(/LOOP_A/g, "OLD_FEATURE") }))).toEqual(["OLD_FEATURE_ENABLED is a switch from before the loops; a loop gets a new one"]);
    // Read with another comparison, or read twice.
    expect(switchProblems("LOOP_A_ENABLED", scan({ switchesText: good.replace('=== "true"', '!== "false"') }))).toEqual([once("LOOP_A_ENABLED")]);
    expect(switchProblems("LOOP_A_ENABLED", scan({ switchesText: `${good}\nconst raw = process.env["LOOP_A_ENABLED"];` }))).toEqual([once("LOOP_A_ENABLED")]);
    // Also read in another file, either way of writing it.
    expect(switchProblems("LOOP_A_ENABLED", scan({ others: [{ file: "src/lib/content/x.ts", text: 'const on = process.env.LOOP_A_ENABLED === "true";' }] }))).toEqual([
      "LOOP_A_ENABLED is read outside src/lib/loops/switches.ts: src/lib/content/x.ts",
    ]);
    expect(switchProblems("LOOP_A_ENABLED", scan({ others: [{ file: "src/lib/content/y.ts", text: "const on = process.env['LOOP_A_ENABLED'];" }] }))).toEqual([
      "LOOP_A_ENABLED is read outside src/lib/loops/switches.ts: src/lib/content/y.ts",
    ]);
    // A longer name that starts the same is another variable.
    expect(switchProblems("LOOP_A_ENABLED", scan({ others: [{ file: "src/lib/content/z.ts", text: "const n = process.env.LOOP_A_ENABLED_UNTIL;" }] }))).toEqual([]);
  });

  it("keeps the frozen list of switches from before the loops as it was", () => {
    expect(SWITCHES_BEFORE_LOOPS.length).toBe(194);
    expect([...SWITCHES_BEFORE_LOOPS].sort()).toEqual(SWITCHES_BEFORE_LOOPS);
    expect(new Set(SWITCHES_BEFORE_LOOPS).size).toBe(SWITCHES_BEFORE_LOOPS.length);
    for (const sw of SWITCHES_BEFORE_LOOPS) expect(sw).toMatch(/^[A-Z][A-Z0-9_]*_ENABLED$/);
  });

  it("names a real file and a plain label for every rule decision and every model call with no meter", () => {
    const listed = [...Object.entries(RULE_DECISIONS), ...Object.entries(UNMETERED_CALLS)];
    const labels = listed.map(([, r]) => r.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const [key, r] of listed) {
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
