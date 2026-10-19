import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { FEATURES, FEATURE_TAGS, STAGES } from "./content";
import { CHAPTERS, FAQ, HERO_LABEL } from "./home";
import { STACK, STACK_WORDS } from "./stack";
import { DICTS, translator } from "./i18n";
import { OTHER_LANGS } from "./langs";

/** Every English string the site puts through t(): content, homepage, and literals in the site's code. */
function siteStrings(): Set<string> {
  const out = new Set<string>([HERO_LABEL]);
  for (const s of Object.values(STAGES)) {
    for (const x of [s.name, s.half, s.promise, s.body, s.who, s.decide, `Explore ${s.name}`, ...s.reads, ...s.writes, ...s.live, ...s.next]) out.add(x);
  }
  for (const f of Object.values(FEATURES)) {
    for (const x of [f.name, f.aside, f.sub, f.h1.join("|"), f.close.join("|")]) out.add(x);
    for (const st of f.steps) for (const x of [st.tab, st.title, st.desc]) out.add(x);
  }
  for (const x of Object.values(FEATURE_TAGS)) out.add(x);
  for (const ch of CHAPTERS) {
    if (ch.kind === "core") for (const x of [ch.name, ch.label, ch.title, ch.body, ...ch.facts.flatMap((f) => [f.term, f.value])]) out.add(x);
    if (ch.kind === "stage") for (const x of [ch.label, ch.body, ch.agent, ch.adds, ch.status.text, ...(ch.status.note ? [ch.status.note] : [])]) out.add(x);
    if (ch.kind === "cross") for (const x of [ch.name, ch.label, ch.title, ch.body, ...(ch.now ?? []), ...(ch.next ?? [])]) out.add(x);
  }
  for (const x of STACK_WORDS) out.add(x);
  for (const c of [...STACK.learnsFrom, ...STACK.connectsThrough, ...STACK.memory, ...STACK.inCharge, ...STACK.connectsTo]) out.add(c.label);
  for (const x of [STACK.team, STACK.gate, STACK.audience]) { out.add(x.title); out.add(x.sub); }
  for (const s of [...STACK.make, ...STACK.grow]) out.add(s.sub);
  for (const e of FAQ) { out.add(e.q); out.add(e.a); if (e.link && !e.link.href.startsWith("http")) out.add(e.link.label); }
  for (const dir of ["src/components/site", "src/lib/site"]) {
    for (const name of readdirSync(dir)) {
      if (!/\.tsx?$/.test(name) || name.endsWith(".test.ts")) continue;
      const src = readFileSync(join(dir, name), "utf8");
      for (const m of src.matchAll(/\b(?:t|fmt)\("((?:[^"\\]|\\.)+)"/g)) out.add(m[1]!.replace(/\\"/g, '"'));
    }
  }
  return out;
}

const FREE_LINES = new Set(["Growth|that|compounds", "GROWTH|MEMORY"]);
const placeholders = (s: string) => [...s.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort();

describe("site translations", () => {
  const strings = siteStrings();

  it("finds the strings it checks", () => {
    expect(strings.size).toBeGreaterThan(300);
    expect(strings.has("How it works")).toBe(true);
    expect(strings.has("What is YouGrow?")).toBe(true);
  });

  for (const lang of OTHER_LANGS) {
    it(`${lang}: translates every string the site shows, keeping placeholders and line splits`, () => {
      const d = DICTS[lang];
      const missing = [...strings].filter((s) => !d[s]?.trim());
      expect(missing).toEqual([]);
      for (const s of strings) {
        const v = d[s]!;
        expect(placeholders(v), s).toEqual(placeholders(s));
        if (s.includes("|") && !FREE_LINES.has(s)) expect(v.split("|").length, s).toBe(s.split("|").length);
      }
    });
  }

  it("uses no dashes as punctuation (house style), in English or any translation", () => {
    const dash = /[\u2013\u2014]| - /;
    expect([...strings].filter((s) => dash.test(s))).toEqual([]);
    for (const lang of OTHER_LANGS) expect(Object.values(DICTS[lang]).filter((v) => dash.test(v))).toEqual([]);
  });

  it("falls back to English and fills placeholders", () => {
    expect(translator("fr").t("No such string")).toBe("No such string");
    expect(translator("en").fmt("Step {n} of {m}", { n: 2, m: 5 })).toBe("Step 2 of 5");
    expect(translator("de").fmt("Step {n} of {m}", { n: 2, m: 5 })).not.toContain("{");
    expect(translator("ja").lines("Start your|first lap")).toHaveLength(2);
  });
});
