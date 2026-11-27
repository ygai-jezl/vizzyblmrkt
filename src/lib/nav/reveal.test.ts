import { describe, expect, it } from "vitest";
import { buildNav, type NavFlags, type NavKey } from "./model";
import { REVEALABLE, REVEAL_RULE, isRevealKey, pathSections, revealKeysOf, shownSections, waitingInView } from "./reveal";

const FLAGS: NavFlags = { lifecycle: true, brandKit: true, review: true, people: true, ideas: true, work: true };
const sections = buildNav(FLAGS);
const keysOf = (list: { items: { key: NavKey }[] }[]) => list.flatMap((s) => s.items.map((i) => i.key));
const ALL_KEYS: NavKey[] = ["home", "review", "work", "launches", "content", "products", "journeys", "audience", "insights", "brand", "settings"];

describe("pathSections", () => {
  it("leaves out only what waits, keeping every group's order", () => {
    const view = pathSections(sections, new Set(["journeys"]), "home");
    expect(view.sections.map((s) => s.key)).toEqual(["start", "grow", "end"]);
    expect(keysOf(view.sections)).toEqual(["home", "review", "work", "launches", "journeys", "brand", "settings"]);
  });

  it("drops Understand's heading when nothing in it shows, and keeps it when one does", () => {
    expect(pathSections(sections, new Set(), null).sections.find((s) => s.key === "understand")).toBeUndefined();
    const one = pathSections(sections, new Set(["insights"]), null).sections.find((s) => s.key === "understand");
    expect(one?.title).toBe("Understand");
    expect(one?.items.map((i) => i.key)).toEqual(["insights"]);
  });

  it("always shows the page in view", () => {
    const view = pathSections(sections, new Set(), "audience");
    expect(keysOf(view.sections)).toContain("audience");
    expect(view.comingUp.map((i) => i.key)).toEqual(["content", "products", "journeys", "insights"]);
  });

  it("lists Coming up in the sidebar's order: Grow's, then Understand's, with buildNav's labels", () => {
    const view = pathSections(sections, new Set(), "home");
    expect(view.comingUp.map((i) => i.key)).toEqual(["content", "products", "journeys", "audience", "insights"]);
    expect(view.comingUp.map((i) => i.label)).toEqual(["Content", "Products", "Journeys", "People", "Insights"]);
  });

  it("shows everything once every stage is running", () => {
    const view = pathSections(sections, "all", "home");
    expect(keysOf(view.sections)).toEqual(keysOf(sections));
    expect(view.comingUp).toEqual([]);
  });

  it("never hides a section that isn't revealable, whatever is shown", () => {
    const view = pathSections(sections, new Set(["home", "settings"]), null);
    for (const key of ["home", "review", "work", "launches", "brand", "settings"] as NavKey[]) expect(keysOf(view.sections)).toContain(key);
    for (const item of view.comingUp) expect(REVEAL_RULE[item.key]).toBe("reveal");
  });

  it("only waits on sections buildNav returned: with lifecycle off there's no Products or Journeys", () => {
    const view = pathSections(buildNav({ lifecycle: false, brandKit: true, review: true }), new Set(), "home");
    expect(view.comingUp.map((i) => i.key)).toEqual(["content", "audience", "insights"]);
  });

  it("leaves buildNav whole, so ⌘K and the Vizzy panel still list every section", () => {
    pathSections(sections, new Set(), "home");
    expect(keysOf(buildNav(FLAGS))).toEqual(ALL_KEYS);
    expect(keysOf(sections)).toEqual(ALL_KEYS);
  });
});

describe("the rules", () => {
  it("cover every section, and REVEALABLE is exactly the ones that can wait", () => {
    expect(Object.keys(REVEAL_RULE).sort()).toEqual([...ALL_KEYS].sort());
    expect(ALL_KEYS.filter((k) => REVEAL_RULE[k] === "reveal")).toEqual([...REVEALABLE]);
  });

  it("reads stored keys as strings: revealable ones once each, in order, anything else dropped", () => {
    expect(revealKeysOf(["insights", "content", "home", "nope", 3, "content", null])).toEqual(["content", "insights"]);
    expect(isRevealKey("audience")).toBe(true);
    expect(isRevealKey("people")).toBe(false);
  });
});

describe("the sidebar's shown set", () => {
  it("is today's sidebar without Coming up, and everything once every stage is running", () => {
    expect(shownSections(undefined, { fetched: ["content"], allRunning: true }, ["products"])).toBeNull();
    expect(shownSections({ shown: [] }, { fetched: null, allRunning: true }, [])).toBe("all");
  });

  it("joins what the page was drawn with, what the growth route found and what was opened here", () => {
    const shown = shownSections({ shown: ["content"] }, { fetched: ["insights", "nope"], allRunning: false }, ["journeys"]);
    expect([...(shown as Set<string>)]).toEqual(["content", "journeys", "insights"]);
    expect([...(shownSections({ shown: ["audience"] }, { fetched: null, allRunning: false }, []) as Set<string>)]).toEqual(["audience"]);
  });

  it("records a waiting section whose page is in view, and nothing else", () => {
    const shown = new Set(["content"]);
    expect(waitingInView(shown, "audience")).toBe("audience");
    expect(waitingInView(shown, "content")).toBeNull();
    expect(waitingInView(shown, "settings")).toBeNull();
    expect(waitingInView(shown, null)).toBeNull();
    expect(waitingInView("all", "audience")).toBeNull();
    expect(waitingInView(null, "audience")).toBeNull();
  });
});
