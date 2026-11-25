import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { buildNav } from "@/lib/nav/model";
import { REVEALABLE, pathSections } from "@/lib/nav/reveal";
import { PROFILE_CHOICES, type ProfileAnswers } from "@/lib/types/businessProfile";
import { comingUpWhy, fitSections, hasAnyAnswer, sidebarRevealFor } from "./sidebarFit";
import { COMING_UP_WORDS } from "./words";

// The mockup's three made-up founders (common.js), with lifecycle on.
const LUMEN: ProfileAnswers = { who: "solo", run: "app", stage: "idea", want: "waitlist" };
const FERNHILL: ProfileAnswers = { who: "team", run: "shop", stage: "established", want: "audience" };
const BRIGHTSIDE: ProfileAnswers = { who: "agency", run: "service", stage: "launched", want: "customers" };
const AT = "2026-11-25T10:00:00.000Z";

const nav = buildNav({ lifecycle: true, brandKit: true, review: true, people: true, ideas: true });
const labelsShown = (answers: ProfileAnswers) =>
  pathSections(nav, new Set(fitSections(answers)), "home").sections.flatMap((s) => s.items.map((i) => i.label));
const comingUp = (answers: ProfileAnswers) => pathSections(nav, new Set(fitSections(answers)), "home").comingUp.map((i) => i.label);

describe("the fit table", () => {
  it("gives Lumen Notes (an app, still an idea, a waitlist) only the always rows, and 5 coming up", () => {
    expect(fitSections(LUMEN)).toEqual([]);
    expect(labelsShown(LUMEN)).toEqual(["Home", "Review", "Ideas", "Brand", "Settings"]);
    expect(comingUp(LUMEN)).toEqual(["Content", "Products", "Journeys", "People", "Insights"]);
  });

  it("gives Fernhill Plants (a shop that wants an audience) Content, and 4 coming up", () => {
    expect(fitSections(FERNHILL)).toEqual(["content"]);
    expect(labelsShown(FERNHILL)).toEqual(["Home", "Review", "Ideas", "Content", "Brand", "Settings"]);
    expect(comingUp(FERNHILL)).toEqual(["Products", "Journeys", "People", "Insights"]);
  });

  it("gives Brightside Physio (a service that wants customers) Journeys and People, and 3 coming up", () => {
    expect(fitSections(BRIGHTSIDE)).toEqual(["journeys", "audience"]);
    expect(labelsShown(BRIGHTSIDE)).toEqual(["Home", "Review", "Ideas", "Journeys", "People", "Brand", "Settings"]);
    expect(comingUp(BRIGHTSIDE)).toEqual(["Content", "Products", "Insights"]);
  });

  it("fits Products only for an app that's launched or established", () => {
    expect(fitSections({ run: "app", stage: "launched" })).toEqual(["products"]);
    expect(fitSections({ run: "app", stage: "established" })).toEqual(["products"]);
    expect(fitSections({ run: "app", stage: "idea" })).toEqual([]);
    expect(fitSections({ run: "app" })).toEqual([]);
    expect(fitSections({ run: "shop", stage: "established" })).toEqual([]);
  });

  it("never changes for who you are, never fits Insights, and blank answers fit nothing", () => {
    for (const who of PROFILE_CHOICES.who) expect(fitSections({ ...FERNHILL, who })).toEqual(["content"]);
    for (const run of PROFILE_CHOICES.run) {
      for (const stage of PROFILE_CHOICES.stage) {
        for (const want of PROFILE_CHOICES.want) expect(fitSections({ run, stage, want })).not.toContain("insights");
      }
    }
    expect(fitSections({})).toEqual([]);
    expect(hasAnyAnswer({})).toBe(false);
    expect(hasAnyAnswer({ who: "solo" })).toBe(true);
  });
});

describe("Coming up's lines", () => {
  it("are the mockup founders' lines, with a service's Products line from its answer", () => {
    expect(comingUpWhy(LUMEN)).toEqual({
      content: "Comes once your waitlist is live.",
      products: "Comes when your app is ready to connect.",
      journeys: "Comes after your app is connected.",
      audience: "Comes with your first sign-up.",
      insights: "Comes with your first sign-up or post.",
    });
    expect(comingUpWhy(FERNHILL)).toMatchObject({
      content: "Comes when you want to grow the list.",
      products: "For apps. A shop may never need it.",
      journeys: "Comes when your list starts growing.",
    });
    expect(comingUpWhy(BRIGHTSIDE)).toMatchObject({
      content: "Comes when you want to grow the list.",
      products: "For apps. A service may never need it.",
      insights: "Comes with your first sign-up or post.",
    });
    expect(comingUpWhy({}).products).toBe("Comes when you connect an app.");
    expect(comingUpWhy({}).content).toBe("Comes when you want to grow the list.");
  });

  it("use no dashes as punctuation and none of the AI tells, for every answer", () => {
    const words: unknown[] = Object.values(COMING_UP_WORDS);
    const lines = new Set<string>(words.filter((w): w is string => typeof w === "string"));
    lines.add(COMING_UP_WORDS.rowAria(1));
    lines.add(COMING_UP_WORDS.rowAria(5));
    for (const run of [...PROFILE_CHOICES.run, undefined]) {
      for (const want of [...PROFILE_CHOICES.want, undefined]) {
        for (const line of Object.values(comingUpWhy({ run, want }))) {
          lines.add(line);
          lines.add(COMING_UP_WORDS.itemAria("People", line));
        }
      }
    }
    for (const line of lines) {
      expect(dashesIn(line), line).toEqual([]);
      expect(aiTellsIn(line), line).toEqual([]);
    }
    expect(COMING_UP_WORDS.rowAria(1)).toBe("Coming up: 1 more section");
    expect(COMING_UP_WORDS.rowAria(3)).toBe("Coming up: 3 more sections");
  });
});

describe("the sidebar a brand gets", () => {
  it("is today's sidebar without sidebarReveal: none for a brand that skipped or never started", () => {
    expect(sidebarRevealFor(null, { hasProgramme: true })).toBeUndefined();
    expect(sidebarRevealFor({ businessProfile: { status: "skipped", answers: {}, rev: 0, startedAt: AT } }, { hasProgramme: false })).toBeUndefined();
  });

  it("shows what's stored, what was opened, what fits now and a programme, in the sidebar's order", () => {
    const reveal = sidebarRevealFor(
      {
        businessProfile: { status: "done", answers: LUMEN, rev: 1, startedAt: AT },
        sidebarReveal: { shown: ["insights", "nope"], opened: [{ key: "journeys", at: AT }], startedAt: AT },
      },
      { hasProgramme: true },
    );
    expect(reveal?.shown).toEqual(["content", "journeys", "insights"]);
    expect(reveal?.why).toEqual(comingUpWhy(LUMEN));
    const changed = sidebarRevealFor(
      { businessProfile: { status: "done", answers: BRIGHTSIDE, rev: 2, startedAt: AT }, sidebarReveal: { shown: [], opened: [], startedAt: AT } },
      { hasProgramme: false },
    );
    expect(changed?.shown).toEqual(["journeys", "audience"]);
    expect(REVEALABLE).toHaveLength(5);
  });
});
