import { afterEach, describe, expect, it, vi } from "vitest";
import { isOntologyPersonIdsEnabled } from "./flags";

describe("isOntologyPersonIdsEnabled", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is on only when the person links are on too", () => {
    vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", "true");
    vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
    expect(isOntologyPersonIdsEnabled()).toBe(true);
    vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "false");
    expect(isOntologyPersonIdsEnabled()).toBe(false);
  });

  it("is off unless it reads exactly true", () => {
    vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
    for (const value of ["", "false", "1", "TRUE", "yes"]) {
      vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", value);
      expect(isOntologyPersonIdsEnabled(), value).toBe(false);
    }
  });
});
