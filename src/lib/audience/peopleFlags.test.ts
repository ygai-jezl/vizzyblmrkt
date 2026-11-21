import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isFieldFiltersEnabled, isFieldsEnabled } from "./peopleFlags";

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

describe("isFieldFiltersEnabled", () => {
  it("needs fields and its own switch", () => {
    vi.stubEnv("AUDIENCE_FIELD_FILTERS_ENABLED", "true");
    expect(isFieldFiltersEnabled()).toBe(true);
    vi.stubEnv("AUDIENCE_FIELDS_ENABLED", "false");
    expect(isFieldFiltersEnabled()).toBe(false);
    vi.stubEnv("AUDIENCE_FIELDS_ENABLED", "true");
    vi.stubEnv("AUDIENCE_FIELD_FILTERS_ENABLED", "false");
    expect(isFieldFiltersEnabled()).toBe(false);
  });
});
