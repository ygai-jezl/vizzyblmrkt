/**
 * The nav v2 ("Growth Path") model: which sidebar items exist, which one is
 * active for a path, which launches are pinned, and the header breadcrumbs.
 * Pure (no React, no server imports) so it is unit-tested on its own.
 *
 * Phase 1 is navigation only: every item points at a page that exists today.
 * Grow lists the areas in the order a customer reaches them.
 */

import { connectorName } from "@/lib/connectors/manifests";
import { ideaWord } from "./terms";

export type NavKey =
  | "home"
  | "review"
  | "launches"
  | "content"
  | "products"
  | "journeys"
  | "audience"
  | "insights"
  | "brand"
  | "settings";

export interface NavItem {
  key: NavKey;
  href: string;
  label: string;
  /** Path prefixes that light this item. Omit for an exact match on `href` (Home). */
  match?: string[];
}

export interface NavSection {
  key: "start" | "grow" | "understand" | "end";
  /** Small uppercase heading; omitted for the unlabelled top and bottom groups. */
  title?: string;
  items: NavItem[];
}

export interface NavFlags {
  /** Lifecycle UI: Products and Journeys (and Review, unless `review` says otherwise). */
  lifecycle: boolean;
  /** Show Review. Defaults to `lifecycle`; nav v2 phase 2 turns it on everywhere. */
  review?: boolean;
  /** Brand Kit UI; when off, Brand opens the brand guidelines. */
  brandKit: boolean;
  /**
   * Nav v2 phase 3, one home per noun: Journeys lists waitlist journeys too (so it
   * shows without lifecycle), Settings opens on General, brand guidelines live
   * under Brand, and the AI image library and content steering belong to Content
   * and Insights.
   */
  phase3?: boolean;
  /**
   * The Audience item reads People (NEXT_PUBLIC_NAV_PEOPLE_ENABLED with the one People list:
   * isPeopleNameEnabled(), worked out on the server). Its key and route stay "audience" and
   * /admin/crm.
   */
  people?: boolean;
  /**
   * The Launches item reads Ideas (NEXT_PUBLIC_NAV_IDEAS_ENABLED with LAUNCH_IDEAS_ENABLED:
   * isIdeaWordsEnabled(), worked out on the server). Its key and route stay "launches" and
   * /admin/launches.
   */
  ideas?: boolean;
}

export function buildNav(flags: NavFlags): NavSection[] {
  const lifecycleOnly = <T>(items: T[]): T[] => (flags.lifecycle ? items : []);
  const showReview = flags.review ?? flags.lifecycle;
  const p3 = !!flags.phase3;
  const journeys: NavItem = { key: "journeys", href: "/admin/lifecycle", label: "Journeys", match: ["/admin/lifecycle"] };
  return [
    {
      key: "start",
      items: [
        { key: "home", href: "/admin", label: "Home" },
        ...(showReview
          ? [{ key: "review", href: "/admin/approvals", label: "Review", match: ["/admin/approvals"] } as NavItem]
          : []),
      ],
    },
    {
      key: "grow",
      title: "Grow",
      items: [
        { key: "launches", href: "/admin/launches", label: ideaWord(!!flags.ideas).Many, match: ["/admin/launches"] },
        {
          key: "content",
          href: "/admin/workspace",
          label: "Content",
          match: p3 ? ["/admin/workspace", "/admin/brand-kit/images"] : ["/admin/workspace"],
        },
        ...lifecycleOnly<NavItem>([
          { key: "products", href: "/admin/products", label: "Products", match: ["/admin/products"] },
        ]),
        ...(flags.lifecycle || p3 ? [journeys] : []),
      ],
    },
    {
      key: "understand",
      title: "Understand",
      items: [
        { key: "audience", href: "/admin/crm", label: flags.people ? "People" : "Audience", match: ["/admin/crm"] },
        {
          key: "insights",
          href: "/admin/analytics",
          label: "Insights",
          match: p3 ? ["/admin/analytics", "/admin/brand-kit/steering"] : ["/admin/analytics"],
        },
      ],
    },
    {
      key: "end",
      items: [
        {
          key: "brand",
          href: flags.brandKit ? "/admin/brand-kit" : p3 ? "/admin/brand-kit/guidelines" : "/admin/account/brand",
          label: "Brand",
          match: ["/admin/brand-kit", "/admin/account/brand"],
        },
        { key: "settings", href: p3 ? "/admin/account/settings" : "/admin/account", label: "Settings", match: ["/admin/account"] },
      ],
    },
  ];
}

function isUnder(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * The item to highlight. The longest matching prefix wins, so a child route lights
 * the most specific item (/admin/account/brand → Brand, not Settings). Home is exact.
 */
export function activeNavKey(pathname: string, items: NavItem[]): NavKey | null {
  let best: { key: NavKey; length: number } | null = null;
  for (const item of items) {
    let length = -1;
    if (!item.match) {
      if (pathname === item.href) length = item.href.length;
    } else {
      for (const prefix of item.match) {
        if (isUnder(pathname, prefix)) length = Math.max(length, prefix.length);
      }
    }
    if (length >= 0 && (!best || length > best.length)) best = { key: item.key, length };
  }
  return best?.key ?? null;
}

// ---------------------------------------------------------------------------
// Pinned launches

export interface LaunchRef {
  id: string;
  name: string;
}

/** Launches shown under Pinned until the user pins or unpins anything. */
export const DEFAULT_PIN_COUNT = 3;

/**
 * The launches to show under Pinned. `stored` is null until the user first pins
 * or unpins; until then the newest active launches show, so nothing disappears
 * from the sidebar on day one. Ids of deleted launches drop out.
 */
export function resolvePins(
  stored: string[] | null,
  active: LaunchRef[],
  archived: LaunchRef[],
): LaunchRef[] {
  if (stored === null) return active.slice(0, DEFAULT_PIN_COUNT);
  const byId = new Map([...active, ...archived].map((l) => [l.id, l]));
  return stored.map((id) => byId.get(id)).filter((l): l is LaunchRef => !!l);
}

/** The ids {@link resolvePins} shows before the user customises (for pin toggles elsewhere). */
export function defaultPinIds(active: LaunchRef[]): string[] {
  return active.slice(0, DEFAULT_PIN_COUNT).map((l) => l.id);
}

/** Pin or unpin `id`, starting from what is shown now (so the first edit keeps the defaults). */
export function togglePin(shownIds: string[], id: string): string[] {
  return shownIds.includes(id) ? shownIds.filter((x) => x !== id) : [...shownIds, id];
}

// ---------------------------------------------------------------------------
// Breadcrumbs

export interface Crumb {
  label: string;
  /** Omitted on the last crumb (the current page). */
  href?: string;
}

/** Names for ids in the path; unknown ids fall back to a generic label. */
export interface CrumbNames {
  launches: Record<string, string>;
  workspaces: Record<string, string>;
}

const LAUNCH_TABS: Record<string, string> = {
  signups: "Signups",
  analytics: "Analytics",
  broadcasts: "Broadcasts",
  journey: "Journey",
  widget: "Embed & Design",
  settings: "Settings",
};

const WORKSPACE_TABS: Record<string, string> = {
  curate: "Curate",
  templatize: "Templatize",
  create: "Create",
  distribute: "Distribute",
  weekly: "Weekly",
  settings: "Settings",
};

/** The Scrapbook was the Idea Board; its route stays idea-board. */
const CURATE_TABS: Record<string, string> = { "idea-board": "Scrapbook", grounding: "Grounding" };

const BRAND_KIT_PAGES: Record<string, string> = {
  colours: "Colours",
  fonts: "Fonts",
  graphics: "Graphics",
  icons: "Icons",
  images: "Images",
  "image-style": "Image style",
  screenshots: "Screenshots",
  logos: "Logos",
  map: "Brand map",
  notes: "What we've seen",
  competitors: "Competitors",
  steering: "Content Steering",
  voice: "Brand voice",
};

const ACCOUNT_TABS: Record<string, string> = {
  brand: "Brand guidelines",
  settings: "Content defaults",
  connections: "Connections",
  billing: "Billing",
  history: "History",
};

/** Single-page areas: the crumb is just the page's name. People renames crm (opts.people). */
const PAGES: Record<string, string> = {
  approvals: "Review",
  crm: "Audience",
  analytics: "Insights",
  database: "Master Database",
  identity: "Identity Radar",
  intelligence: "Market Intelligence",
  scenarios: "Scenario Planner",
};

function titleCase(slug: string): string {
  const words = slug.replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : slug;
}

/** Phase-3 names: the launch Emails tab, Programme pipeline tabs, Settings tabs. */
const LAUNCH_TABS_V3: Record<string, string> = { ...LAUNCH_TABS, widget: "Page & widget", emails: "Emails" };
const PROGRAMME_TABS: Record<string, string> = {
  templatize: "Templates",
  create: "Drafts",
  distribute: "Calendar",
  settings: "Settings",
};
const ACCOUNT_TABS_V3: Record<string, string> = {
  settings: "General",
  connections: "Connections",
  billing: "Billing",
  history: "History",
};

/** Nav v2 phase 4: the Insights hub's tabs. */
const INSIGHTS_TABS: Record<string, string> = {
  launches: "Launches",
  email: "Email",
  content: "Content",
  journeys: "Journeys",
  market: "Market",
};

/** With plans on (NEXT_PUBLIC_PLANS_ENABLED) the billing tab is Plan and usage. */
const PLANS_TAB = "Plan and usage";

const CONNECTIONS = "/admin/account/connections";

/**
 * Settings › Connections and its pages (NEXT_PUBLIC_CONNECTORS_ENABLED): the Accounts, Browse and
 * Connected sub-tabs are all "Connections"; a connector's Listing, reached from Browse, adds its
 * name, and the picker after signing in adds "Choose a property". Null for the tab itself.
 */
function connectionsCrumbs(settings: Crumb, tab: string, rest: string[]): Crumb[] | null {
  const [sub, leaf] = rest;
  if (!sub || sub === "browse" || sub === "connected") return null;
  const connections: Crumb = { label: tab, href: `${CONNECTIONS}/browse` };
  const name = connectorName(sub) ?? titleCase(sub);
  if (leaf === "pick") return [settings, connections, { label: name, href: `${CONNECTIONS}/${sub}` }, { label: "Choose a property" }];
  return [settings, connections, { label: name }];
}

/**
 * The header's crumbs, which are also what Vizzy is told about the page. `people` names the
 * Audience area People and `ideas` calls launches ideas (both worked out on the server).
 */
export function breadcrumbsFor(
  pathname: string,
  names: CrumbNames,
  opts: { phase3?: boolean; insights?: boolean; plans?: boolean; people?: boolean; ideas?: boolean } = {},
): Crumb[] {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "admin") return [];
  const [, area, id, ...rest] = segments;
  if (!area) return [{ label: "Home" }];
  const p3 = !!opts.phase3;
  const word = ideaWord(!!opts.ideas);

  switch (area) {
    case "launches": {
      if (!id) return [{ label: word.Many }];
      const root: Crumb = { label: word.Many, href: "/admin/launches" };
      if (id === "new") return [root, { label: `New ${word.one}` }];
      const tab = rest[0];
      const launch: Crumb = { label: names.launches[id] ?? word.One, href: `/admin/launches/${id}` };
      if (p3 && (tab === "journey" || tab === "broadcasts" || tab === "invites")) {
        // All live under the launch's Emails tab.
        return [
          root,
          launch,
          { label: "Emails", href: `/admin/launches/${id}/emails` },
          { label: tab === "journey" ? "Welcome & nurture" : tab === "broadcasts" ? "Broadcasts" : "Invites" },
        ];
      }
      const tabs = p3 ? LAUNCH_TABS_V3 : LAUNCH_TABS;
      return [root, launch, { label: tab ? (tabs[tab] ?? titleCase(tab)) : "Overview" }];
    }
    case "workspace": {
      if (!id) return [{ label: "Content" }];
      const root: Crumb = { label: "Content", href: "/admin/workspace" };
      const workspace = names.workspaces[id] ?? (p3 ? "Programme" : "Workspace");
      const [tab, sub, leaf] = rest;
      if (!tab) return [root, { label: workspace }];
      const ws: Crumb = { label: workspace, href: `/admin/workspace/${id}` };
      if (p3) {
        // The pipeline tabs: Scrapbook · Templates · Drafts · Calendar, with Knowledge apart.
        if (tab === "curate") return [root, ws, { label: sub === "grounding" ? "Knowledge" : "Scrapbook" }];
        if (tab === "weekly") {
          return [root, ws, { label: "Calendar", href: `/admin/workspace/${id}/distribute` }, { label: "Weekly newsletter" }];
        }
        const label = PROGRAMME_TABS[tab] ?? titleCase(tab);
        if (!sub) return [root, ws, { label }];
        const tabCrumb: Crumb = { label, href: `/admin/workspace/${id}/${tab}` };
        if (tab === "create" && leaf === "ebook") {
          return [root, ws, tabCrumb, { label: "Draft", href: `/admin/workspace/${id}/create/${sub}` }, { label: "eBook" }];
        }
        return [root, ws, tabCrumb, { label: tab === "create" ? "Draft" : titleCase(sub) }];
      }
      const tabLabel = WORKSPACE_TABS[tab] ?? titleCase(tab);
      if (!sub) return [root, ws, { label: tabLabel }];
      const tabCrumb: Crumb = { label: tabLabel, href: `/admin/workspace/${id}/${tab}` };
      if (tab === "curate") return [root, ws, tabCrumb, { label: CURATE_TABS[sub] ?? titleCase(sub) }];
      if (tab === "create" && leaf === "ebook") {
        return [root, ws, tabCrumb, { label: "Workflow", href: `/admin/workspace/${id}/create/${sub}` }, { label: "eBook" }];
      }
      return [root, ws, tabCrumb, { label: tab === "create" ? "Workflow" : titleCase(sub) }];
    }
    case "brand-kit":
      if (p3 && id === "images") return [{ label: "Content", href: "/admin/workspace" }, { label: "Library" }];
      if (p3 && id === "steering") return [{ label: "Insights", href: "/admin/analytics" }, { label: "What's working" }];
      if (p3 && id === "guidelines") return [{ label: "Brand", href: "/admin/brand-kit" }, { label: "Guidelines" }];
      // One competitor: never its name (these labels are also what Vizzy is told about the page).
      if (id === "competitors" && rest[0]) {
        const leaf = rest[0] === "coverage" ? "What they write about" : "Competitor";
        return [{ label: "Brand", href: "/admin/brand-kit" }, { label: "Competitors", href: "/admin/brand-kit/competitors" }, { label: leaf }];
      }
      return id
        ? [{ label: "Brand", href: "/admin/brand-kit" }, { label: BRAND_KIT_PAGES[id] ?? titleCase(id) }]
        : [{ label: "Brand" }];
    case "account": {
      const plansTab = opts.plans && id === "billing" ? PLANS_TAB : null;
      if (p3) {
        if (id === "brand") return [{ label: "Brand", href: "/admin/brand-kit" }, { label: "Guidelines" }];
        const settings: Crumb = { label: "Settings", href: "/admin/account/settings" };
        if (id === "connections") return connectionsCrumbs(settings, ACCOUNT_TABS_V3.connections!, rest) ?? [settings, { label: ACCOUNT_TABS_V3.connections! }];
        return [settings, { label: plansTab ?? (id ? (ACCOUNT_TABS_V3[id] ?? titleCase(id)) : "Sending") }];
      }
      const settings: Crumb = { label: "Settings", href: "/admin/account" };
      if (id === "connections") return connectionsCrumbs(settings, ACCOUNT_TABS.connections!, rest) ?? [settings, { label: ACCOUNT_TABS.connections! }];
      return [settings, { label: plansTab ?? (id ? (ACCOUNT_TABS[id] ?? titleCase(id)) : "Domains") }];
    }
    case "lifecycle":
      return id ? [{ label: "Journeys", href: "/admin/lifecycle" }, { label: "Journey" }] : [{ label: "Journeys" }];
    case "crm": {
      // A person's page: a whole person (ct_, AUDIENCE_ONE_VIEW_ENABLED) or a product user
      // (AUDIENCE_PERSON_VIEW). Never their name: these labels are also what Vizzy is told
      // about the page in view. With People on, the area is People, so a whole person is
      // People › Person and a product user People › Product users › Person.
      const area = opts.people ? "People" : PAGES.crm!;
      if (id === "people" && rest[0]) {
        const root: Crumb = { label: area, href: "/admin/crm" };
        if (rest[0].startsWith("ct_")) {
          return opts.people ? [root, { label: "Person" }] : [root, { label: "People", href: "/admin/crm" }, { label: "Person" }];
        }
        return [root, { label: "Product users", href: "/admin/crm?tab=product" }, { label: "Person" }];
      }
      return [{ label: area }];
    }
    case "products":
      return id ? [{ label: "Products", href: "/admin/products" }, { label: "Product" }] : [{ label: "Products" }];
    case "brands":
      return [{ label: id === "new" ? "Add brand" : "Brands" }];
    case "analytics": {
      // Nav v2 phase 4: Insights › {tab}.
      if (opts.insights && id) {
        const tab = id === "launches" ? word.Many : (INSIGHTS_TABS[id] ?? titleCase(id));
        return [{ label: "Insights", href: "/admin/analytics" }, { label: tab }];
      }
      return [{ label: PAGES.analytics! }];
    }
    default:
      return [{ label: PAGES[area] ?? titleCase(area) }];
  }
}
