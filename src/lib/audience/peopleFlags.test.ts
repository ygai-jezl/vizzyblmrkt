import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canAddPeople,
  isAddPersonEnabled,
  isFieldFiltersEnabled,
  isFieldsEnabled,
  isTimelineEnabled,
  isVizzyFieldsEnabled,
  isPersonInContextEnabled,
  isVizzyAddPersonEnabled,
  isVizzyTextFieldsEnabled,
} from "./peopleFlags";

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

describe("canAddPeople", () => {
  it("needs New person, the People screen (nav phase 3) and an admin", () => {
    for (const k of ["NEXT_PUBLIC_NAV_V2_ENABLED", "NEXT_PUBLIC_NAV_V2_PHASE2_ENABLED", "NEXT_PUBLIC_NAV_V2_PHASE3_ENABLED", "AUDIENCE_ADD_PERSON_ENABLED"]) vi.stubEnv(k, "true");
    expect(canAddPeople("admin")).toBe(true);
    expect(canAddPeople("member")).toBe(false);
    expect(canAddPeople(undefined)).toBe(false);
    // Phase 2 alone shows ⌘K, but the form lives on the phase 3 People list.
    vi.stubEnv("NEXT_PUBLIC_NAV_V2_PHASE3_ENABLED", "false");
    expect(canAddPeople("admin")).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_NAV_V2_PHASE3_ENABLED", "true");
    vi.stubEnv("AUDIENCE_ADD_PERSON_ENABLED", "false");
    expect(canAddPeople("admin")).toBe(false);
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

describe("isVizzyFieldsEnabled", () => {
  it("needs fields and its own switch, read as the exact string true, and not the lifecycle person brief", () => {
    vi.stubEnv("AUDIENCE_VIZZY_FIELDS_ENABLED", "true");
    vi.stubEnv("LIFECYCLE_ENABLED", "false");
    vi.stubEnv("LIFECYCLE_PERSON_BRIEF", "false");
    expect(isVizzyFieldsEnabled()).toBe(true);
    for (const off of ["AUDIENCE_FIELDS_ENABLED", "AUDIENCE_ONE_VIEW_ENABLED", "ONTOLOGY_PERSON_IDS_ENABLED", "AUDIENCE_PERSON_LINKS_ENABLED"]) {
      vi.stubEnv(off, "false");
      expect(isVizzyFieldsEnabled(), off).toBe(false);
      vi.stubEnv(off, "true");
    }
    vi.stubEnv("AUDIENCE_VIZZY_FIELDS_ENABLED", "TRUE");
    expect(isVizzyFieldsEnabled()).toBe(false);
  });
});

describe("isVizzyTextFieldsEnabled", () => {
  it("needs Vizzy's fields and its own switch, read as the exact string true", () => {
    vi.stubEnv("AUDIENCE_VIZZY_FIELDS_ENABLED", "true");
    expect(isVizzyTextFieldsEnabled()).toBe(false);
    vi.stubEnv("AUDIENCE_VIZZY_TEXT_FIELDS_ENABLED", "true");
    expect(isVizzyTextFieldsEnabled()).toBe(true);
    for (const off of ["AUDIENCE_VIZZY_FIELDS_ENABLED", "AUDIENCE_FIELDS_ENABLED", "AUDIENCE_ONE_VIEW_ENABLED", "ONTOLOGY_PERSON_IDS_ENABLED"]) {
      vi.stubEnv(off, "false");
      expect(isVizzyTextFieldsEnabled(), off).toBe(false);
      vi.stubEnv(off, "true");
    }
    vi.stubEnv("AUDIENCE_VIZZY_TEXT_FIELDS_ENABLED", "1");
    expect(isVizzyTextFieldsEnabled()).toBe(false);
  });

  it("doesn't change whether Vizzy reads the seven types", () => {
    vi.stubEnv("AUDIENCE_VIZZY_FIELDS_ENABLED", "true");
    vi.stubEnv("AUDIENCE_VIZZY_TEXT_FIELDS_ENABLED", "false");
    expect(isVizzyFieldsEnabled()).toBe(true);
  });
});

describe("isPersonInContextEnabled", () => {
  it("names the person in view with Vizzy's fields alone, with the brief alone, and with neither not at all", () => {
    expect(isPersonInContextEnabled()).toBe(false);
    vi.stubEnv("AUDIENCE_VIZZY_FIELDS_ENABLED", "true");
    expect(isPersonInContextEnabled()).toBe(true);
    vi.stubEnv("AUDIENCE_VIZZY_FIELDS_ENABLED", "false");
    for (const on of ["LIFECYCLE_ENABLED", "AUDIENCE_PERSON_VIEW", "LIFECYCLE_PERSON_BRIEF", "LIFECYCLE_CHAT_AUTHORING_ENABLED"]) vi.stubEnv(on, "true");
    expect(isPersonInContextEnabled()).toBe(true);
  });
});

describe("isVizzyAddPersonEnabled", () => {
  it("needs New person and its own switch, read as the exact string true, and not Vizzy's fields", () => {
    vi.stubEnv("AUDIENCE_VIZZY_ADD_PERSON_ENABLED", "true");
    expect(isVizzyAddPersonEnabled()).toBe(false);
    vi.stubEnv("AUDIENCE_ADD_PERSON_ENABLED", "true");
    vi.stubEnv("AUDIENCE_FIELDS_ENABLED", "false");
    expect(isVizzyAddPersonEnabled()).toBe(true);
    vi.stubEnv("AUDIENCE_VIZZY_ADD_PERSON_ENABLED", "1");
    expect(isVizzyAddPersonEnabled()).toBe(false);
  });
});
