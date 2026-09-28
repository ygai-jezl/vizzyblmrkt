import { describe, it, expect } from "vitest";
import type { z } from "zod";
import { ConnectionCatalogSchema, type ConnectionCatalog } from "@/lib/types/productConnection";
import { catalogProblems, fieldLabel, fieldLimit, serverProblemKey } from "./catalogProblems";

const cat = (c: z.input<typeof ConnectionCatalogSchema>) => ConnectionCatalogSchema.parse(c);
const FACT = { id: "share_of_voice", label: "Share of voice", type: "number" as const, unit: "%", description: "", source: "" };
const GOOD = cat({
  onboardingSteps: [{ id: "brand-settings", label: "Complete brand settings", order: 0 }],
  facts: [FACT],
  glossary: [{ term: "GEO", definition: "" }],
});

describe("catalog problems", () => {
  it("finds none in a catalog the server would accept", () => {
    expect(catalogProblems(GOOD)).toEqual({});
  });

  it("names the field and says what's wrong, in words", () => {
    const bad = {
      ...GOOD,
      facts: [FACT, { ...FACT, id: "journey-stage", label: "" }, { ...FACT, id: "reach", label: "x".repeat(121) }],
      onboardingSteps: [{ id: "Brand Settings", label: "Complete brand settings", order: 0 }],
    };
    expect(catalogProblems(bad)).toEqual({
      "facts.1.id": "Use lower case letters, digits and _, starting with a letter — e.g. share_of_voice.",
      "facts.1.label": "Required.",
      "facts.2.label": "Too long — up to 120 characters.",
      "onboardingSteps.0.id": "Use lower case letters, digits, _ or -, e.g. create_brand.",
    });
    expect(fieldLabel("facts", "label")).toBe("Label");
    expect(fieldLabel("onboardingSteps", "id")).toBe("Step id");
  });

  it("treats a missing value like an empty one", () => {
    const missing = { ...GOOD, facts: [{ ...FACT, label: undefined }] } as unknown as ConnectionCatalog;
    expect(catalogProblems(missing)).toEqual({ "facts.0.label": "Required." });
  });

  it("marks an id used twice (glossary terms whatever their case)", () => {
    const twice = { ...GOOD, facts: [FACT, { ...FACT }], glossary: [{ term: "GEO", definition: "" }, { term: "geo ", definition: "" }] };
    expect(catalogProblems(twice)).toEqual({
      "facts.1.id": "Another fact already uses this.",
      "glossary.1.term": "Another term already uses this.",
    });
  });

  it("reports a whole list that's too long", () => {
    const many = { ...GOOD, facts: Array.from({ length: 51 }, (_, i) => ({ ...FACT, id: `fact_${i}` })) };
    expect(catalogProblems(many)).toEqual({ facts: "Too many facts — up to 50." });
  });

  it("reads the field out of a server refusal", () => {
    expect(serverProblemKey("catalog.facts.6.label: Invalid input")).toBe("facts.6.label");
    expect(serverProblemKey("name: Invalid input")).toBeNull();
    expect(serverProblemKey(undefined)).toBeNull();
  });
});

describe("field limits", () => {
  it("reads each text field's limit from the schema the server checks", () => {
    expect(fieldLimit("facts", "label")).toBe(120);
    expect(fieldLimit("facts", "source")).toBe(500);
    expect(fieldLimit("facts", "unit")).toBe(20);
    expect(fieldLimit("glossary", "definition")).toBe(500);
  });

  it("has none for fields that aren't text, or don't exist", () => {
    expect(fieldLimit("onboardingSteps", "order")).toBeNull();
    expect(fieldLimit("facts", "nope")).toBeNull();
    expect(fieldLimit("nope", "label")).toBeNull();
  });
});
