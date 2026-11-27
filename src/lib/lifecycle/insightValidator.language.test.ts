import { describe, expect, it } from "vitest";
import { validateAiLine, validateAiSubject } from "./insightValidator";

describe("insight lines in another language", () => {
  const german = "Ihre Projekte laufen schneller, seit Sie die Vorlagen nutzen.";

  it("doesn't read German's capitalised nouns as names", () => {
    expect(validateAiLine(german, [], { language: "de" }).ok).toBe(true);
    expect(validateAiSubject("Ihre Vorlagen sparen Zeit", [], { language: "de" }).ok).toBe(true);
  });

  it("still reads capitals as names in English, and in languages that capitalise as English does", () => {
    expect(validateAiLine(german, []).ok).toBe(false);
    expect(validateAiLine("Vos projets avancent depuis que vous utilisez Trello.", [], { language: "fr" }).ok).toBe(false);
  });

  it("keeps every other rule in German", () => {
    expect(validateAiLine("Ihre Projekte laufen 3 mal schneller.", [], { language: "de" }).ok).toBe(false);
    expect(validateAiLine("Besuchen Sie example.com für mehr.", [], { language: "de" }).ok).toBe(false);
  });
});
