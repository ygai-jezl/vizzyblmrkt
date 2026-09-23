/**
 * The nav v2 ("Growth Path") model: which sidebar items exist, which one is
 * active for a path, which launches are pinned, and the header breadcrumbs.
 * Pure (no React, no server imports) so it is unit-tested on its own.
 *
 * Phase 1 is navigation only: every item points at a page that exists today.
 * Grow lists the areas in the order a customer reaches them.
 */

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
        { key: "launches", href: "/admin/launches", label: "Launches", match: ["/admin/launches"] },
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
        { key: "audience", href: "/admin/crm", label: "Audience", match: ["/admin/crm"] },
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

const CURATE_TABS: Record<string, string> = { "idea-board": "Idea Board", grounding: "Grounding" };

const BRAND_KIT_PAGES: Record<string, string> = {
  colours: "Colours",
  fonts: "Fonts",
  graphics: "Graphics",
  icons: "Icons",
  images: "Images",
  logos: "Logos",
  steering: "Content Steering",
  voice: "Brand voice",
};

const ACCOUNT_TABS: Record<string, string> = {
  brand: "Brand guidelines",
  settings: "Content defaults",
  connections: "Connections",
  billing: "Billing",
};

/** Single-page areas: the crumb is just the page's name. */
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
  connections: "Integrations",
  billing: "Billing",
};

export function breadcrumbsFor(pathname: string, names: CrumbNames, opts: { phase3?: boolean } = {}): Crumb[] {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "admin") return [];
  const [, area, id, ...rest] = segments;
  if (!area) return [{ label: "Home" }];
  const p3 = !!opts.phase3;

  switch (area) {
    case "launches": {
      if (!id) return [{ label: "Launches" }];
      const root: Crumb = { label: "Launches", href: "/admin/launches" };
      if (id === "new") return [root, { label: "New launch" }];
      const tab = rest[0];
      const launch: Crumb = { label: names.launches[id] ?? "Launch", href: `/admin/launches/${id}` };
      if (p3 && (tab === "journey" || tab === "broadcasts")) {
        // Both live under the launch's Emails tab.
        return [
          root,
          launch,
          { label: "Emails", href: `/admin/launches/${id}/emails` },
          { label: tab === "journey" ? "Welcome & nurture" : "Broadcasts" },
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
        // The pipeline tabs: Ideas · Templates · Drafts · Calendar, with Knowledge apart.
        if (tab === "curate") return [root, ws, { label: sub === "grounding" ? "Knowledge" : "Ideas" }];
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
      return id
        ? [{ label: "Brand", href: "/admin/brand-kit" }, { label: BRAND_KIT_PAGES[id] ?? titleCase(id) }]
        : [{ label: "Brand" }];
    case "account":
      if (p3) {
        if (id === "brand") return [{ label: "Brand", href: "/admin/brand-kit" }, { label: "Guidelines" }];
        return [
          { label: "Settings", href: "/admin/account/settings" },
          { label: id ? (ACCOUNT_TABS_V3[id] ?? titleCase(id)) : "Sending" },
        ];
      }
      return [
        { label: "Settings", href: "/admin/account" },
        { label: id ? (ACCOUNT_TABS[id] ?? titleCase(id)) : "Domains" },
      ];
    case "lifecycle":
      return id ? [{ label: "Journeys", href: "/admin/lifecycle" }, { label: "Journey" }] : [{ label: "Journeys" }];
    case "products":
      return id ? [{ label: "Products", href: "/admin/products" }, { label: "Product" }] : [{ label: "Products" }];
    case "brands":
      return [{ label: id === "new" ? "Add brand" : "Brands" }];
    default:
      return [{ label: PAGES[area] ?? titleCase(area) }];
  }
}
