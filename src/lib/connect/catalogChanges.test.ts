import { describe, it, expect } from "vitest";
import type { z } from "zod";
import { ConnectionCatalogSchema, type ConnectionCatalog } from "@/lib/types/productConnection";
import { describeChanges, rebaseCatalog, sameCatalog } from "./catalogChanges";

const cat = (c: z.input<typeof ConnectionCatalogSchema>) => ConnectionCatalogSchema.parse(c);

const BASE = cat({
  onboardingSteps: [
    { id: "create_brand", label: "Add your brand", order: 0 },
    { id: "run_audit", label: "Run an audit", order: 1 },
  ],
  facts: [{ id: "share_of_voice", label: "Share of voice", type: "number", unit: "%" }],
  glossary: [{ term: "GEO", definition: "Generative engine optimisation" }],
});

describe("describing catalog changes", () => {
  it("names what was added, renamed, changed and removed", () => {
    const after = cat({
      ...BASE,
      onboardingSteps: [
        { id: "create_brand", label: "Add a brand", order: 0 },
        { id: "run_audit", label: "Run an audit", order: 1 },
        { id: "invite_team", label: "Invite your team", order: 2 },
      ],
      facts: [{ id: "share_of_voice", label: "Share of voice", type: "number", unit: "pts" }],
      glossary: [],
    });
    expect(describeChanges(BASE, after)).toEqual([
      "Renamed step ‘Add your brand’ to ‘Add a brand’",
      "Added step ‘Invite your team’",
      "Changed fact ‘Share of voice’",
      "Removed term ‘GEO’",
    ]);
  });

  it("treats blank, null and missing fields alike, and notices a new order", () => {
    const same = { ...BASE, facts: [{ ...BASE.facts[0]!, kind: null, appliesWhen: undefined }] };
    expect(sameCatalog(BASE, same)).toBe(true);
    // Lists saved before facts or kinds existed are simply empty.
    expect(sameCatalog(cat({}), { ...cat({}), facts: undefined, entityKinds: undefined } as unknown as ConnectionCatalog)).toBe(true);
    const swapped = { ...BASE, onboardingSteps: BASE.onboardingSteps.map((s) => ({ ...s, order: 1 - s.order })) };
    expect(describeChanges(BASE, swapped)).toEqual(["Reordered steps"]);
  });

  it("lists a new, not yet named row", () => {
    const after = { ...BASE, glossary: [...BASE.glossary, { term: "", definition: "" }] };
    expect(describeChanges(BASE, after)).toEqual(["Added term ‘unnamed’"]);
  });
});

describe("carrying edits over onto a newer catalog", () => {
  // You opened the catalog at BASE; meanwhile someone else saved THEIRS.
  const THEIRS = cat({
    ...BASE,
    onboardingSteps: [...BASE.onboardingSteps, { id: "connect_ga", label: "Connect Analytics", order: 2 }],
    glossary: [{ term: "GEO", definition: "Getting found in AI answers" }],
  });

  it("keeps both sides' edits when they touch different entries", () => {
    const mine = cat({
      ...BASE,
      onboardingSteps: [
        { id: "create_brand", label: "Add a brand", order: 0 },
        { id: "run_audit", label: "Run an audit", order: 1 },
        { id: "invite_team", label: "Invite your team", order: 2 },
      ],
    });
    const { catalog, notes } = rebaseCatalog(BASE, mine, THEIRS);
    expect(catalog.onboardingSteps).toEqual([
      { id: "create_brand", label: "Add a brand", order: 0 },
      { id: "run_audit", label: "Run an audit", order: 1 },
      { id: "connect_ga", label: "Connect Analytics", order: 2 },
      { id: "invite_team", label: "Invite your team", order: 3 },
    ]);
    expect(catalog.glossary).toEqual(THEIRS.glossary);
    expect(notes).toEqual([]);
  });

  it("keeps yours where both changed one entry, and says so", () => {
    const mine = cat({ ...BASE, glossary: [{ term: "GEO", definition: "Being cited by AI engines" }] });
    const { catalog, notes } = rebaseCatalog(BASE, mine, THEIRS);
    expect(catalog.glossary).toEqual(mine.glossary);
    expect(notes).toEqual(["Term ‘GEO’ was also changed elsewhere — yours is kept"]);
  });

  it("removes what you removed — unless it was changed elsewhere meanwhile", () => {
    const mine = cat({ ...BASE, onboardingSteps: [BASE.onboardingSteps[0]!], glossary: [] });
    const { catalog, notes } = rebaseCatalog(BASE, mine, THEIRS);
    expect(catalog.onboardingSteps.map((s) => s.id)).toEqual(["create_brand", "connect_ga"]);
    expect(catalog.glossary).toEqual(THEIRS.glossary);
    expect(notes).toEqual(["Term ‘GEO’ was changed elsewhere, so it wasn't removed"]);
  });

  it("keeps an entry you changed that was removed elsewhere", () => {
    const theirs = cat({ ...BASE, facts: [] });
    const mine = cat({ ...BASE, facts: [{ ...BASE.facts[0]!, label: "SoV" }] });
    const { catalog, notes } = rebaseCatalog(BASE, mine, theirs);
    expect(catalog.facts.map((f) => f.label)).toEqual(["SoV"]);
    expect(notes).toEqual(["Fact ‘SoV’ was removed elsewhere — kept because you changed it"]);
  });

  it("leaves an entry removed elsewhere removed when you didn't touch it", () => {
    const theirs = cat({ ...BASE, facts: [] });
    const mine = cat({ ...BASE, glossary: [...BASE.glossary, { term: "SoV", definition: "Share of voice" }] });
    const { catalog } = rebaseCatalog(BASE, mine, theirs);
    expect(catalog.facts).toEqual([]);
    expect(catalog.glossary.map((g) => g.term)).toEqual(["GEO", "SoV"]);
  });
});
