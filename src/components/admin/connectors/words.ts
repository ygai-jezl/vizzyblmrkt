import type { ConnectMethodName } from "@/lib/connectors/manifest";
import type { ConnectionView, ConnectorListing } from "@/lib/connectors/service";

/**
 * The words and small decisions the Settings › Connections screens share: pure, so the tests read
 * them without a browser. House style (src/lib/content/writingRules.ts): no dashes as
 * punctuation, none of the AI tells. Every fixed line is in SCREEN_COPY so the copy test sees it.
 */

export const CONNECTIONS_PATH = "/admin/account/connections";
export const listingPath = (connectorId: string) => `${CONNECTIONS_PATH}/${connectorId}`;
export const pickPath = (connectorId: string, connectionId: string) => `${CONNECTIONS_PATH}/${connectorId}/pick?connection=${encodeURIComponent(connectionId)}`;
export const HELP_PATH = "/help/connected-data";

export const SCREEN_COPY = {
  browseLead: "Bring numbers from the tools you already use. Each connection shows exactly what it reads.",
  browseLeadVizzy: "Bring numbers from the tools you already use. Vizzy can read them when you ask, and each connection shows exactly what it reads.",
  browseFoot: "More connectors come later. Your accounts for code, posts and email stay under Accounts. Only admins connect or change anything here.",
  noConnectors: "No connectors are turned on in this copy of YouGrow yet. Whoever runs it turns each one on.",
  noMatch: "Nothing matches that search.",
  coreOff: "Connected data is off in this copy of YouGrow (CONNECTORS_ENABLED). Whoever runs it can turn it on.",
  failed: "Connections didn't load. Try again in a moment.",
  membersOnly: "Only admins connect or change anything here. Ask an admin on your team.",
} as const;

export const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  analytics: "Analytics",
  search: "Search",
  social: "Social",
  email: "Email",
  code: "Code",
  crm: "Customers",
  shop: "Shop",
};

export const categoryLabel = (category: string) => CATEGORY_LABELS[category] ?? category;

export const METHOD_LABELS: Readonly<Record<ConnectMethodName, string>> = {
  token_fields: "API token",
  oauth_pkce: "Sign in with Google",
  share_access: "Share access",
};

/** The categories the offered connectors fall in, in the order they first appear. */
export function categoriesOf(connectors: readonly Pick<ConnectorListing, "category">[]): string[] {
  return [...new Set(connectors.map((c) => c.category))];
}

/** Browse's search and category chips: a connector matches on its name, summary or category. */
export function filterConnectors<T extends Pick<ConnectorListing, "name" | "summary" | "category">>(connectors: readonly T[], query: string, category: string | null): T[] {
  const q = query.trim().toLowerCase();
  return connectors.filter((c) => {
    if (category && c.category !== category) return false;
    if (!q) return true;
    return [c.name, c.summary, categoryLabel(c.category)].some((s) => s.toLowerCase().includes(q));
  });
}

export type Tone = "ok" | "warn" | "muted" | "plain";

/**
 * A connector's state on its Browse card, from the brand's connections to it that are still
 * connected: one needing attention wins, then one waiting for its property, then paused.
 */
export function connectorStatus(connectorId: string, connections: readonly ConnectionView[]): { label: string; tone: Tone } {
  const mine = connections.filter((c) => c.connectorId === connectorId && c.status === "connected");
  if (!mine.length) return { label: "Ready", tone: "plain" };
  if (mine.some((c) => c.health.state === "broken" || c.health.state === "check")) return { label: "Needs attention", tone: "warn" };
  if (mine.some((c) => c.needsAccount)) return { label: "Choose a property", tone: "warn" };
  if (mine.every((c) => c.health.state === "paused")) return { label: "Paused", tone: "muted" };
  return { label: "Connected", tone: "ok" };
}

/** Two letters for a connector's tile: its words' first letters, leaving out Google in a longer name. */
export function initialsOf(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  const kept = words.length > 2 ? words.filter((w) => w !== "Google") : words;
  return kept
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

const TILES = [
  "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
  "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-200",
  "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200",
];

/** The same colour for a connector every time, from its id. */
export function tileClass(connectorId: string): string {
  let h = 0;
  for (const ch of connectorId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TILES[h % TILES.length]!;
}

export const TONE_CLASS: Readonly<Record<Tone, string>> = {
  ok: "border-green-300 text-green-800 dark:border-green-800 dark:text-green-300",
  warn: "border-amber-300 text-amber-800 dark:border-amber-800 dark:text-amber-300",
  muted: "border-neutral-300 text-neutral-500 dark:border-neutral-700 dark:text-neutral-400",
  plain: "border-neutral-300 text-neutral-700 dark:border-neutral-700 dark:text-neutral-300",
};

export const CARD = "rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950";
export const HINT = "text-xs leading-relaxed text-neutral-500 dark:text-neutral-400";
export const TAG = "inline-flex items-center rounded-full border px-2 py-0.5 text-xs";
export const BUTTON =
  "inline-flex items-center justify-center rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900";
export const BUTTON_PRIMARY =
  "inline-flex items-center justify-center rounded-md border border-neutral-900 bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-800 disabled:opacity-50 dark:border-white dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200";
export const NOTE_WARN = "rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300";
export const NOTE_OK = "rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-900 dark:bg-green-950/40 dark:text-green-300";
export const NOTE_ERR = "rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400";
export const NOTE_PLAIN = "rounded-md border border-dashed border-neutral-300 px-4 py-6 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400";
