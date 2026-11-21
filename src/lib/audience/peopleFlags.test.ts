import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isAddPersonEnabled, isFieldFiltersEnabled, isFieldsEnabled, isTimelineEnabled } from "./peopleFlags";

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

describe("isAddPersonEnabled", () => {
  it("needs the one view, the person ids and its own switch, read as the exact string true", () => {
    vi.stubEnv("AUDIENCE_ADD_PERSON_ENABLED", "true");
    expect(isAddPersonEnabled()).toBe(true);
    for (const off of ["AUDIENCE_ONE_VIEW_ENABLED", "ONTOLOGY_PERSON_IDS_ENABLED", "AUDIENCE_PERSON_LINKS_ENABLED"]) {
      vi.stubEnv(off, "false");
      expect(isAddPersonEnabled(), off).toBe(false);
      vi.stubEnv(off, "true");
    }
    vi.stubEnv("AUDIENCE_ADD_PERSON_ENABLED", "yes");
    expect(isAddPersonEnabled()).toBe(false);
  });

  it("doesn't need fields", () => {
    vi.stubEnv("AUDIENCE_FIELDS_ENABLED", "false");
    vi.stubEnv("AUDIENCE_ADD_PERSON_ENABLED", "true");
    expect(isAddPersonEnabled()).toBe(true);
  });
});

describe("isTimelineEnabled", () => {
  it("needs the one view, the person ids and its own switch, and nothing else", () => {
    vi.stubEnv("AUDIENCE_TIMELINE_ENABLED", "true");
    vi.stubEnv("AUDIENCE_FIELDS_ENABLED", "false");
    expect(isTimelineEnabled()).toBe(true);
    for (const off of ["AUDIENCE_ONE_VIEW_ENABLED", "ONTOLOGY_PERSON_IDS_ENABLED", "AUDIENCE_PERSON_LINKS_ENABLED", "AUDIENCE_TIMELINE_ENABLED"]) {
      vi.stubEnv(off, "false");
      expect(isTimelineEnabled(), off).toBe(false);
      vi.stubEnv(off, "true");
    }
  });
});
