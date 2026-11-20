import { afterEach, describe, expect, it, vi } from "vitest";
import { isPeopleNameEnabled } from "@/lib/audience/flags";
import { isNavPeopleEnabled } from "./flags";
import { peopleArea } from "./terms";

describe("peopleArea", () => {
  it("names the area People only when told the switch is on", () => {
    expect(peopleArea(true)).toBe("People");
    expect(peopleArea(false)).toBe("Audience");
  });
});

describe("the People switch", () => {
  afterEach(() => vi.unstubAllEnvs());

  const on = (extra: Record<string, string> = {}) => {
    vi.stubEnv("NEXT_PUBLIC_NAV_V2_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_NAV_V2_PHASE2_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_NAV_V2_PHASE3_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_NAV_PEOPLE_ENABLED", "true");
    vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
    vi.stubEnv("AUDIENCE_ONE_VIEW_ENABLED", "true");
    for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v);
  };

  it("needs phase 3 and the one People list", () => {
    on();
    expect(isNavPeopleEnabled()).toBe(true);
    expect(isPeopleNameEnabled()).toBe(true);
  });

  it("is off without phase 3", () => {
    on({ NEXT_PUBLIC_NAV_V2_PHASE3_ENABLED: "false" });
    expect(isNavPeopleEnabled()).toBe(false);
    expect(isPeopleNameEnabled()).toBe(false);
  });

  it("never names People over the old tabs (the one view off)", () => {
    on({ AUDIENCE_ONE_VIEW_ENABLED: "false" });
    expect(isNavPeopleEnabled()).toBe(true);
    expect(isPeopleNameEnabled()).toBe(false);
  });

  it("is off unless the switch is exactly true", () => {
    on({ NEXT_PUBLIC_NAV_PEOPLE_ENABLED: "TRUE" });
    expect(isPeopleNameEnabled()).toBe(false);
  });
});
