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
      "Scrapbook",
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
    expect(labels("/admin/brand-kit/competitors")).toEqual(["Brand", "Competitors"]);
    expect(labels("/admin/brand-kit/competitors/cmp_abc12345")).toEqual(["Brand", "Competitors", "Competitor"]);
    expect(labels("/admin/brand-kit/competitors/coverage")).toEqual(["Brand", "Competitors", "What they write about"]);
    expect(breadcrumbsFor("/admin/brand-kit/competitors/cmp_abc12345", names)[1]?.href).toBe("/admin/brand-kit/competitors");
    expect(labels("/admin/lifecycle/lcj_1")).toEqual(["Journeys", "Journey"]);
  });

  it("files the Raise kit and a deck under Content, never naming the deck", () => {
    for (const phase3 of [false, true]) {
      const items = buildNav({ ...ALL_ON, phase3 }).flatMap((s) => s.items);
      expect(activeNavKey("/admin/raise", items)).toBe("content");
      expect(activeNavKey("/admin/raise/rd_x", items)).toBe("content");
      expect(breadcrumbsFor("/admin/raise", names, { phase3 }).map((c) => c.label)).toEqual(["Content", "Raise kit"]);
      const deck = breadcrumbsFor("/admin/raise/rd_acme00000001", { ...names, workspaces: { rd_acme00000001: "Acme seed deck" } }, { phase3 });
      expect(deck.map((c) => c.label)).toEqual(["Content", "Raise kit", "Deck"]);
      expect(deck.map((c) => c.href)).toEqual(["/admin/workspace", "/admin/raise", undefined]);
    }
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
    expect(labels("/admin/workspace/w1/curate/idea-board")).toEqual(["Content", "The Weekly Plate", "Scrapbook"]);
    expect(labels("/admin/workspace/w1/curate")).toEqual(["Content", "The Weekly Plate", "Scrapbook"]);
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
    expect(labels("/admin/account/connections")).toEqual(["Settings", "Connections"]);
    expect(labels("/admin/brand-kit/guidelines")).toEqual(["Brand", "Guidelines"]);
  });

  it("names Settings › Connections and its connector pages, whatever the sub-tab", () => {
    const crumbs = (path: string, phase3 = true) => breadcrumbsFor(path, names, { phase3 });
    for (const path of ["/admin/account/connections", "/admin/account/connections/browse", "/admin/account/connections/connected"]) {
      expect(labels(path), path).toEqual(["Settings", "Connections"]);
      expect(crumbs(path, false).map((c) => c.label), path).toEqual(["Settings", "Connections"]);
    }
    expect(crumbs("/admin/account/connections/search-console")).toEqual([
      { label: "Settings", href: "/admin/account/settings" },
      { label: "Connections", href: "/admin/account/connections/browse" },
      { label: "Google Search Console" },
    ]);
    expect(crumbs("/admin/account/connections/google-analytics/pick").map((c) => c.label)).toEqual(["Settings", "Connections", "Google Analytics 4", "Choose a property"]);
    expect(crumbs("/admin/account/connections/google-analytics/pick")[2]).toEqual({ label: "Google Analytics 4", href: "/admin/account/connections/google-analytics" });
    expect(crumbs("/admin/account/connections/cloudflare", false).map((c) => c.label)).toEqual(["Settings", "Connections", "Cloudflare"]);
    // An id no manifest has reads as itself.
    expect(labels("/admin/account/connections/new-thing")).toEqual(["Settings", "Connections", "New thing"]);
  });

  it("names Settings › History (SETTINGS_HISTORY_ENABLED) in both navigations", () => {
    expect(breadcrumbsFor("/admin/account/history", names, { phase3: true }).map((c) => c.label)).toEqual(["Settings", "History"]);
    expect(breadcrumbsFor("/admin/account/history", names, { phase3: false }).map((c) => c.label)).toEqual(["Settings", "History"]);
  });

  it("names the billing tab Plan and usage only with plans on", () => {
    expect(labels("/admin/account/billing")).toEqual(["Settings", "Billing"]);
    const withPlans = (path: string, phase3: boolean) => breadcrumbsFor(path, names, { phase3, plans: true }).map((c) => c.label);
    expect(withPlans("/admin/account/billing", true)).toEqual(["Settings", "Plan and usage"]);
    expect(withPlans("/admin/account/billing", false)).toEqual(["Settings", "Plan and usage"]);
    expect(breadcrumbsFor("/admin/account/billing", names, { phase3: false }).map((c) => c.label)).toEqual(["Settings", "Billing"]);
    // Only the billing tab changes.
    expect(withPlans("/admin/account/settings", true)).toEqual(["Settings", "General"]);
    expect(withPlans("/admin/account", false)).toEqual(["Settings", "Domains"]);
  });
});

describe("phase 4 breadcrumbs", () => {
  const names = { launches: { c1: "Fernlight Beta" }, workspaces: {}, journeys: {}, products: {} };
  const labels = (path: string, insights = true) =>
    breadcrumbsFor(path, names as never, { phase3: true, insights }).map((c) => c.label);

  it("files a launch's invites under Emails", () => {
    expect(labels("/admin/launches/c1/invites")).toEqual(["Launches", "Fernlight Beta", "Emails", "Invites"]);
  });

  it("names the Insights tab, and keeps a single crumb without the hub", () => {
    expect(labels("/admin/analytics")).toEqual(["Insights"]);
    expect(labels("/admin/analytics/email")).toEqual(["Insights", "Email"]);
    expect(breadcrumbsFor("/admin/analytics/email", names as never, { phase3: true, insights: true })[0]).toMatchObject({
      href: "/admin/analytics",
    });
    expect(labels("/admin/analytics/email", false)).toEqual(["Insights"]);
  });
});


describe("a person's page", () => {
  const names = { launches: {}, workspaces: {} };
  const crumbs = (path: string) => breadcrumbsFor(path, names, { phase3: true });

  it("sits under Audience › Product users and never names the person", () => {
    expect(crumbs("/admin/crm/people/pu_3f9a")).toEqual([
      { label: "Audience", href: "/admin/crm" },
      { label: "Product users", href: "/admin/crm?tab=product" },
      { label: "Person" },
    ]);
    expect(crumbs("/admin/crm")).toEqual([{ label: "Audience" }]);
    expect(crumbs("/admin/crm/people")).toEqual([{ label: "Audience" }]);
  });

  it("sits under Audience › People for a whole person (the one view)", () => {
    expect(crumbs("/admin/crm/people/ct_9b2e")).toEqual([
      { label: "Audience", href: "/admin/crm" },
      { label: "People", href: "/admin/crm" },
      { label: "Person" },
    ]);
  });
});

describe("People in place of Audience", () => {
  const names = { launches: {}, workspaces: {} };
  const crumbs = (path: string, people: boolean) => breadcrumbsFor(path, names, { phase3: true, people });
  const CRM_PATHS = ["/admin/crm", "/admin/crm/people", "/admin/crm/people/ct_9b2e", "/admin/crm/people/pu_3f9a"];

  it("names the sidebar item People only with the switch, keeping its key and route", () => {
    const on = allItems({ ...ALL_ON, phase3: true, people: true }).find((i) => i.key === "audience")!;
    expect(on).toMatchObject({ label: "People", href: "/admin/crm", match: ["/admin/crm"] });
    const off = allItems({ ...ALL_ON, phase3: true }).find((i) => i.key === "audience")!;
    expect(off.label).toBe("Audience");
    expect(activeNavKey("/admin/crm/people/ct_9b2e", allItems({ ...ALL_ON, people: true }))).toBe("audience");
  });

  it("reads People › Person for a whole person and People › Product users › Person for a product user", () => {
    expect(crumbs("/admin/crm", true)).toEqual([{ label: "People" }]);
    expect(crumbs("/admin/crm/people", true)).toEqual([{ label: "People" }]);
    expect(crumbs("/admin/crm/people/ct_9b2e", true)).toEqual([{ label: "People", href: "/admin/crm" }, { label: "Person" }]);
    expect(crumbs("/admin/crm/people/pu_3f9a", true)).toEqual([
      { label: "People", href: "/admin/crm" },
      { label: "Product users", href: "/admin/crm?tab=product" },
      { label: "Person" },
    ]);
  });

  it("keeps every Audience crumb as it was with the switch off", () => {
    expect(crumbs("/admin/crm", false)).toEqual([{ label: "Audience" }]);
    expect(crumbs("/admin/crm/people/ct_9b2e", false)).toEqual([
      { label: "Audience", href: "/admin/crm" },
      { label: "People", href: "/admin/crm" },
      { label: "Person" },
    ]);
    expect(crumbs("/admin/crm/people/pu_3f9a", false)[0]).toEqual({ label: "Audience", href: "/admin/crm" });
  });

  it("has no Audience in any label or crumb for the People area while on", () => {
    const labels = allItems({ ...ALL_ON, phase3: true, people: true }).map((i) => i.label);
    expect(labels.join(" ")).not.toMatch(/Audience/);
    for (const path of CRM_PATHS) {
      expect(crumbs(path, true).map((c) => c.label).join(" › "), path).not.toMatch(/Audience/);
    }
  });

  it("changes nothing outside the People area", () => {
    for (const path of ["/admin", "/admin/launches/c1/signups", "/admin/account/billing", "/admin/analytics"]) {
      expect(crumbs(path, true), path).toEqual(crumbs(path, false));
    }
  });
});

describe("Ideas in place of Launches", () => {
  const names = { launches: { c1: "Offline mode" }, workspaces: { w1: "The Weekly Plate" } };
  const crumbs = (path: string, ideas: boolean) => breadcrumbsFor(path, names, { phase3: true, insights: true, ideas });
  const labels = (path: string, ideas: boolean) => crumbs(path, ideas).map((c) => c.label);
  const LAUNCH_PATHS = [
    "/admin/launches",
    "/admin/launches/new",
    "/admin/launches/c1",
    "/admin/launches/unknown",
    "/admin/launches/c1/signups",
    "/admin/launches/c1/journey",
    "/admin/launches/c1/invites",
    "/admin/analytics/launches",
  ];

  it("names the sidebar item Ideas only when told, keeping its key and route", () => {
    const on = allItems({ ...ALL_ON, phase3: true, ideas: true }).find((i) => i.key === "launches")!;
    expect(on).toMatchObject({ label: "Ideas", href: "/admin/launches", match: ["/admin/launches"] });
    expect(allItems({ ...ALL_ON, phase3: true }).find((i) => i.key === "launches")!.label).toBe("Launches");
    expect(activeNavKey("/admin/launches/c1", allItems({ ...ALL_ON, ideas: true }))).toBe("launches");
  });

  it("reads Ideas in the crumbs, New idea, and Idea for a launch it has no name for", () => {
    expect(labels("/admin/launches", true)).toEqual(["Ideas"]);
    expect(labels("/admin/launches/new", true)).toEqual(["Ideas", "New idea"]);
    expect(labels("/admin/launches/c1", true)).toEqual(["Ideas", "Offline mode", "Overview"]);
    expect(labels("/admin/launches/unknown", true)).toEqual(["Ideas", "Idea", "Overview"]);
    expect(labels("/admin/launches/c1/journey", true)).toEqual(["Ideas", "Offline mode", "Emails", "Welcome & nurture"]);
    expect(labels("/admin/analytics/launches", true)).toEqual(["Insights", "Ideas"]);
    expect(crumbs("/admin/launches/c1/signups", true)[0]).toEqual({ label: "Ideas", href: "/admin/launches" });
  });

  it("keeps every crumb as it was with the words off", () => {
    expect(labels("/admin/launches/new", false)).toEqual(["Launches", "New launch"]);
    expect(labels("/admin/launches/unknown", false)).toEqual(["Launches", "Launch", "Overview"]);
    expect(labels("/admin/analytics/launches", false)).toEqual(["Insights", "Launches"]);
    for (const path of LAUNCH_PATHS) expect(crumbs(path, false), path).toEqual(breadcrumbsFor(path, names, { phase3: true, insights: true }));
  });

  it("has no Launch in any label or crumb for launches while on", () => {
    const items = allItems({ ...ALL_ON, phase3: true, ideas: true }).map((i) => i.label);
    expect(items.join(" ")).not.toMatch(/launch/i);
    for (const path of LAUNCH_PATHS) expect(labels(path, true).join(" › "), path).not.toMatch(/launch/i);
  });

  it("changes nothing outside launches", () => {
    for (const path of ["/admin", "/admin/crm", "/admin/workspace/w1/curate/idea-board", "/admin/analytics/email", "/admin/products/p1"]) {
      expect(crumbs(path, true), path).toEqual(crumbs(path, false));
    }
  });
});

describe("Work (WORK_ENABLED)", () => {
  const start = (flags: NavFlags) => buildNav(flags).find((s) => s.key === "start")!.items.map((i) => i.key);

  it("is last in the top group, only while the switch is on", () => {
    expect(start({ ...ALL_ON, work: true })).toEqual(["home", "review", "work"]);
    expect(start(ALL_ON)).toEqual(["home", "review"]);
    expect(allItems({ ...ALL_ON, work: true }).find((i) => i.key === "work")).toMatchObject({ href: "/admin/work", label: "Work" });
  });

  it("lights Work on its pages, and never on Content's /admin/workspace", () => {
    const items = allItems({ ...ALL_ON, work: true });
    for (const path of ["/admin/work", "/admin/work/log", "/admin/work/new", "/admin/work/73"]) expect(activeNavKey(path, items), path).toBe("work");
    expect(activeNavKey("/admin/workspace", items)).toBe("content");
    expect(activeNavKey("/admin/workspace/w1/curate", items)).toBe("content");
  });

  it("has crumbs for the list, the Log, the add page and a task by its ref, never its title", () => {
    const names: CrumbNames = { launches: {}, workspaces: {} };
    const labels = (path: string) => breadcrumbsFor(path, names).map((c) => c.label);
    expect(labels("/admin/work")).toEqual(["Work"]);
    expect(labels("/admin/work/log")).toEqual(["Work", "Log"]);
    expect(labels("/admin/work/new")).toEqual(["Work", "New task"]);
    expect(labels("/admin/work/73")).toEqual(["Work", "Task #73"]);
    expect(labels("/admin/work/not-a-ref")).toEqual(["Work", "Task"]);
    expect(breadcrumbsFor("/admin/work/73", names)[0]).toEqual({ label: "Work", href: "/admin/work" });
    // Content keeps its own crumbs.
    expect(labels("/admin/workspace")).toEqual(["Content"]);
  });
});
