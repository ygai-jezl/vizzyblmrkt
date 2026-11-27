import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isRaiseFollowupsEnabled, isRaisePipelineEnabled } from "./flags";

const FIELDS = ["AUDIENCE_PERSON_LINKS_ENABLED", "AUDIENCE_ONE_VIEW_ENABLED", "ONTOLOGY_PERSON_IDS_ENABLED", "AUDIENCE_FIELDS_ENABLED"];

beforeEach(() => {
  for (const k of FIELDS) vi.stubEnv(k, "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("the board's switches", () => {
  it("are off unless exactly true", () => {
    expect(isRaisePipelineEnabled()).toBe(false);
    vi.stubEnv("RAISE_PIPELINE_ENABLED", "TRUE");
    expect(isRaisePipelineEnabled()).toBe(false);
    vi.stubEnv("RAISE_PIPELINE_ENABLED", "true");
    expect(isRaisePipelineEnabled()).toBe(true);
    expect(isRaiseFollowupsEnabled()).toBe(false);
    vi.stubEnv("RAISE_FOLLOWUPS_ENABLED", "true");
    expect(isRaiseFollowupsEnabled()).toBe(true);
  });

  it("need the fields, and follow-ups need the board", () => {
    vi.stubEnv("RAISE_PIPELINE_ENABLED", "true");
    vi.stubEnv("RAISE_FOLLOWUPS_ENABLED", "true");
    vi.stubEnv("AUDIENCE_FIELDS_ENABLED", "false");
    expect(isRaisePipelineEnabled()).toBe(false);
    expect(isRaiseFollowupsEnabled()).toBe(false);
    vi.stubEnv("AUDIENCE_FIELDS_ENABLED", "true");
    vi.stubEnv("RAISE_PIPELINE_ENABLED", "false");
    expect(isRaiseFollowupsEnabled()).toBe(false);
  });
});
