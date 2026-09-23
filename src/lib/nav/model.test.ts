import { describe, it, expect } from "vitest";
import {
  activeNavKey,
  breadcrumbsFor,
  buildNav,
  defaultPinIds,
  resolvePins,
  togglePin,
  type CrumbNames,
  type NavFlags,
} from "./model";

const ALL_ON: NavFlags = { lifecycle: true, brandKit: true };
const allItems = (flags: NavFlags = ALL_ON) => buildNav(flags).flatMap((s) => s.items);

describe("buildNav", () => {
  it("lists Grow in the order a customer reaches it", () => {
    const grow = buildNav(ALL_ON).find((s) => s.key === "grow")!;
    expect(grow.items.map((i) => i.label)).toEqual(["Launches", "Content", "Products", "Journeys"]);
  });

  it("drops Review, Products and Journeys when lifecycle is off", () => {
    const labels = allItems({ lifecycle: false, brandKit: true }).map((i) => i.label);
    expect(labels).not.toContain("Review");
    expect(labels).not.toContain("Products");
    expect(labels).not.toContain("Journeys");
    expect(labels).toContain("Launches");
  });

  it("phase 2 shows Review even where lifecycle is off", () => {
    const labels = allItems({ lifecycle: false, brandKit: true, review: true }).map((i) => i.label);
    expect(labels).toContain("Review");
    expect(labels).not.toContain("Journeys");
  });

  it("sends Brand to the guidelines page when the Brand Kit UI is off", () => {
    const brand = allItems({ lifecycle: true, brandKit: false }).find((i) => i.key === "brand")!;
    expect(brand.href).toBe("/admin/account/brand");
  });

  it("has no links to Coming soon pages", () => {
    const hrefs = allItems().map((i) => i.href);
    for (const stub of ["/admin/database", "/admin/identity", "/admin/intelligence", "/admin/scenarios"]) {
      expect(hrefs).not.toContain(stub);
    }
  });
});

describe("activeNavKey", () => {
  const items = allItems();
  it.each([
    ["/admin", "home"],
    ["/admin/approvals", "review"],
    ["/admin/launches", "launches"],
    ["/admin/launches/new", "launches"],
    ["/admin/launches/c1/signups", "launches"],
    ["/admin/workspace/w1/curate/idea-board", "content"],
    ["/admin/crm", "audience"],
    ["/admin/analytics", "insights"],
    ["/admin/brand-kit/voice", "brand"],
    ["/admin/account/brand", "brand"],
    ["/admin/account/connections", "settings"],
    ["/admin/account", "settings"],
  ])("%s → %s", (path, key) => {
    expect(activeNavKey(path, items)).toBe(key);
  });

  it("matches whole segments only, and Home only exactly", () => {
    expect(activeNavKey("/admin/launchesx", items)).toBeNull();
    expect(activeNavKey("/admin/brands/new", items)).toBeNull();
  });
});

describe("pins", () => {
  const active = [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
    { id: "c", name: "C" },
    { id: "d", name: "D" },
  ];
  const archived = [{ id: "z", name: "Z" }];

  it("shows the newest three active launches until the user customises", () => {
    expect(resolvePins(null, active, archived).map((l) => l.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps the user's order, allows archived launches, and drops deleted ones", () => {
    expect(resolvePins(["z", "gone", "b"], active, archived).map((l) => l.id)).toEqual(["z", "b"]);
  });

  it("an explicit empty list means nothing pinned", () => {
    expect(resolvePins([], active, archived)).toEqual([]);
  });

  it("defaultPinIds matches what resolvePins shows by default", () => {
    expect(defaultPinIds(active)).toEqual(resolvePins(null, active, archived).map((l) => l.id));
  });

  it("toggles from what is shown", () => {
    expect(togglePin(["a", "b", "c"], "b")).toEqual(["a", "c"]);
    expect(togglePin(["a"], "d")).toEqual(["a", "d"]);
  });
});

describe("breadcrumbsFor", () => {
  const names: CrumbNames = { launches: { c1: "Fernlight Beta" }, workspaces: { w1: "The Weekly Plate" } };
  const labels = (path: string) => breadcrumbsFor(path, names).map((c) => c.label);

  it("names launches and their tabs", () => {
    expect(labels("/admin/launches/c1")).toEqual(["Launches", "Fernlight Beta", "Overview"]);
    expect(labels("/admin/launches/c1/widget")).toEqual(["Launches", "Fernlight Beta", "Embed & Design"]);
    expect(labels("/admin/launches/unknown/signups")).toEqual(["Launches", "Launch", "Signups"]);
    expect(labels("/admin/launches/new")).toEqual(["Launches", "New launch"]);
  });

  it("links every crumb except the current page", () => {
    const crumbs = breadcrumbsFor("/admin/launches/c1/signups", names);
    expect(crumbs.map((c) => c.href)).toEqual(["/admin/launches", "/admin/launches/c1", undefined]);
  });

  it("follows Content down to the eBook studio", () => {
    expect(labels("/admin/workspace")).toEqual(["Content"]);
    expect(labels("/admin/workspace/w1/curate/idea-board")).toEqual([
      "Content",
      "The Weekly Plate",
      "Curate",
      "Idea Board",
    ]);
    expect(labels("/admin/workspace/w1/create/p1/ebook")).toEqual([
      "Content",
      "The Weekly Plate",
      "Create",
      "Workflow",
      "eBook",
    ]);
  });

  it("uses the new names for renamed areas", () => {
    expect(labels("/admin")).toEqual(["Home"]);
    expect(labels("/admin/approvals")).toEqual(["Review"]);
    expect(labels("/admin/crm")).toEqual(["Audience"]);
    expect(labels("/admin/analytics")).toEqual(["Insights"]);
    expect(labels("/admin/account")).toEqual(["Settings", "Domains"]);
    expect(labels("/admin/brand-kit/steering")).toEqual(["Brand", "Content Steering"]);
    expect(labels("/admin/lifecycle/lcj_1")).toEqual(["Journeys", "Journey"]);
  });

  it("ignores paths outside the admin", () => {
    expect(breadcrumbsFor("/waitlist/x", names)).toEqual([]);
  });
});

describe("phase 3", () => {
  const names: CrumbNames = { launches: { c1: "Fernlight Beta" }, workspaces: { w1: "The Weekly Plate" } };
  const labels = (path: string) => breadcrumbsFor(path, names, { phase3: true }).map((c) => c.label);
  const p3Items = (flags: Partial<NavFlags> = {}) => buildNav({ ...ALL_ON, phase3: true, ...flags }).flatMap((s) => s.items);

  it("shows Journeys without lifecycle, and opens Settings on General", () => {
    const items = p3Items({ lifecycle: false });
    expect(items.map((i) => i.label)).toContain("Journeys");
    expect(items.find((i) => i.key === "settings")?.href).toBe("/admin/account/settings");
  });

  it("files the image library under Content and steering under Insights", () => {
    const items = p3Items();
    expect(activeNavKey("/admin/brand-kit/images", items)).toBe("content");
    expect(activeNavKey("/admin/brand-kit/steering", items)).toBe("insights");
    expect(activeNavKey("/admin/brand-kit/voice", items)).toBe("brand");
  });

  it("names programmes by the pipeline", () => {
    expect(labels("/admin/workspace/w1")).toEqual(["Content", "The Weekly Plate"]);
    expect(labels("/admin/workspace/w1/curate/idea-board")).toEqual(["Content", "The Weekly Plate", "Ideas"]);
    expect(labels("/admin/workspace/w1/curate/grounding")).toEqual(["Content", "The Weekly Plate", "Knowledge"]);
    expect(labels("/admin/workspace/w1/create/p1/ebook")).toEqual(["Content", "The Weekly Plate", "Drafts", "Draft", "eBook"]);
    expect(labels("/admin/workspace/w1/distribute")).toEqual(["Content", "The Weekly Plate", "Calendar"]);
    expect(labels("/admin/workspace/w1/weekly")).toEqual(["Content", "The Weekly Plate", "Calendar", "Weekly newsletter"]);
    expect(labels("/admin/workspace/unknown/settings")).toEqual(["Content", "Programme", "Settings"]);
  });

  it("puts a launch's journey and broadcasts under Emails", () => {
    expect(labels("/admin/launches/c1/journey")).toEqual(["Launches", "Fernlight Beta", "Emails", "Welcome & nurture"]);
    expect(labels("/admin/launches/c1/emails")).toEqual(["Launches", "Fernlight Beta", "Emails"]);
    expect(labels("/admin/launches/c1/widget")).toEqual(["Launches", "Fernlight Beta", "Page & widget"]);
  });

  it("uses the new Settings tabs and moves the guidelines to Brand", () => {
    expect(labels("/admin/account")).toEqual(["Settings", "Sending"]);
    expect(labels("/admin/account/settings")).toEqual(["Settings", "General"]);
    expect(labels("/admin/account/connections")).toEqual(["Settings", "Integrations"]);
    expect(labels("/admin/brand-kit/guidelines")).toEqual(["Brand", "Guidelines"]);
  });
});
