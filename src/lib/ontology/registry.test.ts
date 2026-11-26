import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { MEANINGS } from "@/lib/metrics/meanings";
import { LOOPS } from "@/lib/loops/registry";
import { readSearchKind, SEARCH_KIND_ALIASES, SEARCH_KINDS } from "@/lib/search/types";
import { EVENT_KINDS } from "./events";
import { ONTOLOGY, storesOf, typeById } from "./registry";
import { PATH_TRIGGERS, PERSONALS, PLACES, PLANNED_IN, SPINE_STEPS, STORE_DBS, type OntologyType, type PathDecision, type PathRef } from "./types";

const ROOT = process.cwd();

/**
 * Meanings no tool returns yet, each with its reason. The list only shrinks: a meaning leaves it
 * once a type claims it with the tool that returns it.
 */
const NOT_SERVED_YET: Record<string, string> = {
  editShare: "the learning loops count it once they stamp what YouGrow makes (ADR-0017)",
  keptShare: "the learning loops count it once they stamp what YouGrow makes (ADR-0017)",
  declineShare: "the learning loops count it once they stamp what YouGrow makes (ADR-0017)",
  likedShare: "the learning loops count it once they stamp what YouGrow makes (ADR-0017)",
  unusedShare: "the learning loops count it once they stamp what YouGrow makes (ADR-0017)",
  remadeShare: "the learning loops count it once they stamp what YouGrow makes (ADR-0017)",
};

/**
 * Choices in the learning registry that no type's madeBy names, each with its reason. Every other
 * kind is held by some type, so a new kind with nowhere to live shows up here.
 */
const HELD_NOWHERE: Record<string, string> = {
  other: "no code spends under it, and every new call names its real purpose",
  next_action_order: "Home works the order out on each visit from the brand's answers and where it is, and keeps none of it",
};

/**
 * People types whose search may name kinds anyway, each with its reason. Every other type that
 * holds the brand's people stays out of search until the data processing agreement covers it.
 */
const PEOPLE_IN_SEARCH: Record<string, string> = {
  brand_note: "the team's own notes; a note marked as naming a customer is left out of search (noteSource in src/lib/search/feeders.ts, noteSearchSources in src/lib/search/family.ts)",
};

function pathsOf(d: PathDecision): readonly PathRef[] {
  return "paths" in d ? d.paths : [];
}

/** Every string anywhere in a value, for the house style check. */
function stringsIn(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsIn(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) stringsIn(v, out);
  return out;
}

describe("the ontology registry", () => {
  it("gives every type a unique snake case id", () => {
    const ids = ONTOLOGY.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id, id).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(typeById("person")?.name).toBe("Person");
    expect(typeById("nobody")).toBeUndefined();
  });

  it("uses only known places, personal flags, store kinds and triggers", () => {
    for (const t of ONTOLOGY) {
      expect(PLACES, t.id).toContain(t.place);
      expect([...PERSONALS, "undecided"], t.id).toContain(t.personal);
      expect(["control", "brand", "organisation", "undecided"], t.id).toContain(t.home);
      for (const s of t.stores) expect(STORE_DBS, `${t.id} ${s.collection}`).toContain(s.db);
      for (const p of [...pathsOf(t.erase), ...pathsOf(t.export)]) expect(PATH_TRIGGERS, `${t.id} ${p.fn}`).toContain(p.trigger);
    }
  });

  it("links only to types it knows", () => {
    for (const t of ONTOLOGY) for (const l of t.links) expect(typeById(l.to), `${t.id} links to ${l.to}`).toBeDefined();
  });

  it("names only event kinds the envelope has, and never plan.*, which is the organisation's", () => {
    for (const t of ONTOLOGY) {
      for (const k of t.events) {
        expect(EVENT_KINDS, `${t.id}: ${k}`).toContain(k);
        expect(k.startsWith("plan."), `${t.id}: ${k}`).toBe(false);
      }
    }
  });

  it("gives built types stores, and planned types a piece and no stores", () => {
    for (const t of ONTOLOGY) {
      if (t.status === "built") {
        expect(t.stores.length, `${t.id} has no store`).toBeGreaterThan(0);
        expect(t.plannedIn, `${t.id} is built`).toBeUndefined();
      } else {
        expect(PLANNED_IN, `${t.id} needs a piece`).toContain(t.plannedIn);
        expect(t.stores, `${t.id} is planned`).toEqual([]);
      }
    }
  });

  it("allows undecided only on planned types", () => {
    for (const t of ONTOLOGY.filter((x) => x.status === "built")) {
      expect(t.home, t.id).not.toBe("undecided");
      expect(t.personal, t.id).not.toBe("undecided");
    }
  });

  it("decides search and numbers for every type, with nothing left blank", () => {
    for (const t of ONTOLOGY) {
      if ("kinds" in t.search) expect(t.search.kinds.length, t.id).toBeGreaterThan(0);
      else expect(t.search.none.trim(), t.id).not.toBe("");
      if ("meanings" in t.numbers) {
        expect(t.numbers.meanings.length, t.id).toBeGreaterThan(0);
        expect(t.numbers.tool.trim(), t.id).not.toBe("");
      } else expect(("none" in t.numbers ? t.numbers.none : t.numbers.gap).trim(), t.id).not.toBe("");
      for (const d of [t.erase, t.export]) {
        if ("paths" in d) expect(d.paths.length, t.id).toBeGreaterThan(0);
        else expect(("none" in d ? d.none : d.gap).trim(), t.id).not.toBe("");
      }
    }
  });

  it("decides erase and export for every type that holds the brand's people, and keeps them out of search", () => {
    const people = ONTOLOGY.filter((t) => t.personal === "people");
    expect(people.length).toBeGreaterThan(0);
    for (const t of people) {
      for (const [what, d] of [["erase", t.erase], ["export", t.export]] as const) {
        const reachesPerson = pathsOf(d).some((p) => p.trigger === "person" || p.trigger === "product_user");
        const gaps = "gap" in d ? [d.gap] : "paths" in d ? (d.gaps ?? []) : [];
        expect(reachesPerson || gaps.some((g) => g.trim()), `${t.id}: ${what} reaches no person and names no gap`).toBe(true);
      }
      if (t.id in PEOPLE_IN_SEARCH) expect("kinds" in t.search, `${t.id} is allowed in search but has no kinds`).toBe(true);
      else expect("none" in t.search, `${t.id} holds people and is searched`).toBe(true);
    }
    for (const id of Object.keys(PEOPLE_IN_SEARCH)) expect(typeById(id)?.personal, id).toBe("people");
  });

  it("names erase and export paths that exist", () => {
    for (const t of ONTOLOGY) {
      for (const p of [...pathsOf(t.erase), ...pathsOf(t.export)]) {
        const file = join(ROOT, p.file);
        expect(existsSync(file), `${t.id}: ${p.file} is missing`).toBe(true);
        const exported = new RegExp(`export\\s+(?:async\\s+)?(?:function\\*?|const|let)\\s+${p.fn}\\b`);
        expect(exported.test(readFileSync(file, "utf8")), `${t.id}: ${p.file} doesn't export ${p.fn}`).toBe(true);
      }
    }
  });

  it("names store files that exist", () => {
    for (const s of storesOf()) expect(existsSync(join(ROOT, s.definedIn)), `${s.typeId}: ${s.definedIn}`).toBe(true);
  });

  it("claims every search kind, and every alias through the kind it reads as", () => {
    const claimed = new Set<string>(ONTOLOGY.flatMap((t) => ("kinds" in t.search ? t.search.kinds : [])));
    for (const k of SEARCH_KINDS) expect(claimed.has(k), `no type claims the search kind ${k}`).toBe(true);
    for (const alias of Object.keys(SEARCH_KIND_ALIASES)) {
      const kind = readSearchKind(alias);
      expect(kind !== null && (claimed.has(alias) || claimed.has(kind)), `no type claims the alias ${alias}`).toBe(true);
    }
  });

  it("claims every number's meaning, apart from those no tool returns yet", () => {
    const claimed = new Set<string>(ONTOLOGY.flatMap((t) => ("meanings" in t.numbers ? t.numbers.meanings : [])));
    for (const k of Object.keys(MEANINGS)) {
      if (k in NOT_SERVED_YET) expect(claimed.has(k), `${k} is claimed now: take it off NOT_SERVED_YET`).toBe(false);
      else expect(claimed.has(k), `no type claims the meaning ${k}`).toBe(true);
    }
    for (const [k, why] of Object.entries(NOT_SERVED_YET)) {
      expect(Object.keys(MEANINGS), k).toContain(k);
      expect(why.trim(), k).not.toBe("");
    }
  });

  it("says which choices YouGrow makes each type holds, naming only kinds the learning registry has", () => {
    const kinds = new Set(Object.keys(LOOPS));
    for (const t of ONTOLOGY) {
      expect(Array.isArray(t.madeBy), t.id).toBe(true);
      expect(new Set(t.madeBy).size, `${t.id} names a kind twice`).toBe(t.madeBy.length);
      for (const k of t.madeBy) expect(kinds.has(k), `${t.id} names ${k}, which src/lib/loops/registry.ts has no line for`).toBe(true);
      if (t.status === "planned") expect(t.madeBy, `${t.id} is planned, so it holds nothing yet`).toEqual([]);
    }
    // A sanity check on the lists: the stores of what YouGrow makes say so, not just a few.
    expect(ONTOLOGY.filter((t) => t.madeBy.length > 0).length).toBeGreaterThan(20);
  });

  it("holds every choice in the learning registry in some type, or says why no store keeps it", () => {
    const held = new Set<string>(ONTOLOGY.flatMap((t) => t.madeBy));
    for (const k of Object.keys(LOOPS)) {
      if (k in HELD_NOWHERE) expect(held.has(k), `${k} is held now: take it off HELD_NOWHERE`).toBe(false);
      else expect(held.has(k), `no type's madeBy names ${k}`).toBe(true);
    }
    for (const [k, why] of Object.entries(HELD_NOWHERE)) {
      expect(Object.keys(LOOPS), k).toContain(k);
      expect([...dashesIn(why), ...aiTellsIn(why)], k).toEqual([]);
    }
  });

  it("has a type on each step of the spine", () => {
    for (const step of SPINE_STEPS) expect(ONTOLOGY.some((t) => t.place === step), step).toBe(true);
  });

  it("says why every Cloud Storage store keeps to its region, or doesn't", () => {
    for (const s of storesOf().filter((x) => x.db === "gcs")) {
      expect(Boolean(s.residencyGap?.trim() || s.note?.trim()), `${s.typeId}: ${s.collection}`).toBe(true);
    }
  });

  it("writes in house style: no dashes as punctuation and no AI tells", () => {
    const all = ONTOLOGY.flatMap((t: OntologyType) => stringsIn(t));
    for (const text of all) {
      expect(dashesIn(text), text).toEqual([]);
      expect(aiTellsIn(text), text).toEqual([]);
    }
    for (const reason of Object.values(PEOPLE_IN_SEARCH)) expect(dashesIn(reason)).toEqual([]);
  });
});
