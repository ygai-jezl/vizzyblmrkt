import { afterEach, describe, expect, it, vi } from "vitest";
import { isPeopleNameEnabled } from "@/lib/audience/flags";
import { isIdeaWordsEnabled, isIdeasEnabled } from "@/lib/ideas/flags";
import { isNavIdeasEnabled, isNavPeopleEnabled } from "./flags";
import { ideaWord, peopleArea, peopleSubtitle } from "./terms";

describe("peopleArea", () => {
  it("names the area People only when told the switch is on", () => {
    expect(peopleArea(true)).toBe("People");
    expect(peopleArea(false)).toBe("Audience");
  });
});

describe("peopleSubtitle", () => {
  it("says who is on the one People list, naming people the team added only with New person on", () => {
    expect(peopleSubtitle({ phase3: true, oneView: true, addedByTeam: true })).toBe("Everyone who signed up, uses your product or was added by your team.");
    expect(peopleSubtitle({ phase3: true, oneView: true, addedByTeam: false })).toBe("Everyone who signed up or uses your product.");
  });

  it("keeps the earlier lines without the one People list", () => {
    expect(peopleSubtitle({ phase3: true, oneView: false, addedByTeam: true })).toMatch(/^Everyone you reach: /);
    expect(peopleSubtitle({ phase3: false, oneView: false, addedByTeam: false })).toBe("Every contact across all launches, with company intelligence and email history.");
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

describe("ideaWord", () => {
  it("names a launch an idea only when told the words are on, with its article and possessive", () => {
    expect(ideaWord(true)).toEqual({ one: "idea", One: "Idea", many: "ideas", Many: "Ideas", a: "an idea", A: "An idea", own: "idea's", manyOwn: "ideas'" });
    expect(ideaWord(false)).toEqual({
      one: "launch",
      One: "Launch",
      many: "launches",
      Many: "Launches",
      a: "a launch",
      A: "A launch",
      own: "launch's",
      manyOwn: "launches'",
    });
  });
});

describe("the Ideas words switch", () => {
  afterEach(() => vi.unstubAllEnvs());

  const on = (extra: Record<string, string> = {}) => {
    vi.stubEnv("NEXT_PUBLIC_NAV_V2_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_NAV_V2_PHASE2_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_NAV_V2_PHASE3_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_NAV_IDEAS_ENABLED", "true");
    vi.stubEnv("LAUNCH_IDEAS_ENABLED", "true");
    for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v);
  };

  it("needs phase 3, the switch and ideas", () => {
    on();
    expect(isNavIdeasEnabled()).toBe(true);
    expect(isIdeaWordsEnabled()).toBe(true);
  });

  it("is off without phase 3", () => {
    on({ NEXT_PUBLIC_NAV_V2_PHASE3_ENABLED: "false" });
    expect(isNavIdeasEnabled()).toBe(false);
    expect(isIdeaWordsEnabled()).toBe(false);
  });

  it("keeps saying Launch while ideas are off, and ideas work with the words off", () => {
    on({ LAUNCH_IDEAS_ENABLED: "false" });
    expect(isNavIdeasEnabled()).toBe(true);
    expect(isIdeaWordsEnabled()).toBe(false);
    on({ NEXT_PUBLIC_NAV_IDEAS_ENABLED: "false" });
    expect(isIdeasEnabled()).toBe(true);
    expect(isIdeaWordsEnabled()).toBe(false);
  });

  it("is off unless the switch is exactly true", () => {
    on({ NEXT_PUBLIC_NAV_IDEAS_ENABLED: "TRUE" });
    expect(isIdeaWordsEnabled()).toBe(false);
  });
});
