import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isFieldsEnabled } from "./peopleFlags";

beforeEach(() => {
  vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
  vi.stubEnv("AUDIENCE_ONE_VIEW_ENABLED", "true");
  vi.stubEnv("ONTOLOGY_PERSON_IDS_ENABLED", "true");
  vi.stubEnv("AUDIENCE_FIELDS_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("isFieldsEnabled", () => {
  it("is on only with the one view, the person ids and its own switch", () => {
    expect(isFieldsEnabled()).toBe(true);
    for (const off of ["AUDIENCE_ONE_VIEW_ENABLED", "ONTOLOGY_PERSON_IDS_ENABLED", "AUDIENCE_FIELDS_ENABLED", "AUDIENCE_PERSON_LINKS_ENABLED"]) {
      vi.stubEnv(off, "false");
      expect(isFieldsEnabled(), off).toBe(false);
      vi.stubEnv(off, "true");
    }
  });

  it("reads only the exact string true", () => {
    vi.stubEnv("AUDIENCE_FIELDS_ENABLED", "TRUE");
    expect(isFieldsEnabled()).toBe(false);
  });
});
