import { afterEach, describe, expect, it, vi } from "vitest";

// The palette's area keywords are read at import, so each case imports a fresh copy.
async function keywords() {
  vi.resetModules();
  return (await import("./CommandPalette")).KEYWORDS;
}

describe("⌘K keywords", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("find Settings by Connections, its tab's name, and by Integrations, its old one", async () => {
    for (const plans of ["false", "true"]) {
      vi.stubEnv("NEXT_PUBLIC_PLANS_ENABLED", plans);
      const settings = (await keywords()).settings ?? [];
      expect(settings, plans).toEqual(expect.arrayContaining(["connections", "connected data", "integrations"]));
    }
  });

  it("still find Ideas by launch, waitlist and campaign while launches are called ideas", async () => {
    vi.resetModules();
    const { areaKeywords, launchWords } = await import("./CommandPalette");
    expect(areaKeywords("launches", true)).toEqual(expect.arrayContaining(["launches", "ideas", "waitlists", "campaigns"]));
    // Each idea's row and New idea.
    expect(launchWords(true)).toEqual(expect.arrayContaining(["launch", "idea", "waitlist", "campaign"]));
  });

  it("never find Launches, a launch or New launch by idea while the words are off, as before ideas", async () => {
    vi.resetModules();
    const { areaKeywords, launchWords, KEYWORDS } = await import("./CommandPalette");
    expect(areaKeywords("launches", false)).toEqual(["waitlists", "campaigns"]);
    expect(launchWords(false)).toEqual(["launch", "waitlist"]);
    for (const words of Object.values(KEYWORDS)) expect(words.join(" ")).not.toMatch(/idea/);
    // Work is found by the words a backlog goes by.
    expect(KEYWORDS.work).toEqual(expect.arrayContaining(["tasks", "backlog", "log"]));
    // Other areas are the same either way.
    expect(areaKeywords("audience", true)).toEqual(areaKeywords("audience", false));
  });
});
