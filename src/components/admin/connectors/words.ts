import { LIVE_LIMITS, type ConnectMethodName, type ConnectorCategory, type ShareAccessMethod, type TokenFieldsMethod } from "@/lib/connectors/manifest";
import { SIGNIN_REASONS } from "@/lib/connectors/messages";
import { dayWords, zoneWords } from "@/lib/connectors/period";
import type { ConnectionView, ConnectorListing } from "@/lib/connectors/service";

/**
 * The words and small decisions the Settings › Connections screens share: pure, so the tests read
 * them without a browser. House style (src/lib/content/writingRules.ts): no dashes as
 * punctuation, none of the AI tells. Every fixed line is in one of the *_COPY objects, so the copy
 * test sees it.
 */

export const CONNECTIONS_PATH = "/admin/account/connections";
export const listingPath = (connectorId: string) => `${CONNECTIONS_PATH}/${connectorId}`;
export const pickPath = (connectorId: string, connectionId: string) => `${CONNECTIONS_PATH}/${connectorId}/pick?connection=${encodeURIComponent(connectionId)}`;
export const CONNECTED_PATH = `${CONNECTIONS_PATH}/connected`;
export const HELP_PATH = "/help/connected-data";

export const SCREEN_COPY = {
  browseLead: "Bring numbers from the tools you already use. Each connection shows exactly what it reads.",
  browseLeadVizzy: "Bring numbers from the tools you already use. Vizzy can read them when you ask, and each connection shows exactly what it reads.",
  browseFoot: "More connectors come later. Your accounts for code and posts stay under Accounts, and email sending is under Sending. Only admins connect or change anything here.",
  noConnectors: "No connectors are turned on in this copy of YouGrow yet. Whoever runs it turns each one on.",
  noMatch: "Nothing matches that search.",
  coreOff: "Connected data is off in this copy of YouGrow (CONNECTORS_ENABLED). Whoever runs it can turn it on.",
  failed: "Connections didn't load. Try again in a moment.",
  membersOnly: "Only admins connect or change anything here. Ask an admin on your team.",
} as const;

/**
 * How Browse groups the manifests' categories, for display only: a manifest keeps its own fine
 * category (analytics, search, traffic), and the chips, cards and a Listing show its group's name,
 * as the approved screens do. Every category is in exactly one group (a test checks).
 */
export const CATEGORY_GROUPS: ReadonlyArray<{ id: string; label: string; categories: readonly ConnectorCategory[] }> = [
  { id: "search-analytics", label: "Search and analytics", categories: ["analytics", "search"] },
  { id: "website-traffic", label: "Website and traffic", categories: ["traffic"] },
  { id: "social", label: "Social", categories: ["social"] },
  { id: "email", label: "Email", categories: ["email"] },
  { id: "code", label: "Code", categories: ["code"] },
  { id: "crm", label: "Customers", categories: ["crm"] },
  { id: "shop", label: "Shop", categories: ["shop"] },
];

/** The display group a manifest's category falls in; one this build doesn't know shows as itself. */
export function groupOf(category: string): { id: string; label: string } {
  const group = CATEGORY_GROUPS.find((g) => (g.categories as readonly string[]).includes(category));
  return group ? { id: group.id, label: group.label } : { id: category, label: category };
}

export const categoryLabel = (category: string) => groupOf(category).label;

export const METHOD_LABELS: Readonly<Record<ConnectMethodName, string>> = {
  token_fields: "API token",
  oauth_pkce: "Sign in with Google",
  share_access: "Share access",
};

/** The display groups the offered connectors fall in, in the order they first appear: Browse's chips. */
export function categoriesOf(connectors: readonly Pick<ConnectorListing, "category">[]): Array<{ id: string; label: string }> {
  const seen = new Map<string, { id: string; label: string }>();
  for (const c of connectors) {
    const g = groupOf(c.category);
    if (!seen.has(g.id)) seen.set(g.id, g);
  }
  return [...seen.values()];
}

/** Browse's search and group chips: a connector matches on its name, summary or group's name. */
export function filterConnectors<T extends Pick<ConnectorListing, "name" | "summary" | "category">>(connectors: readonly T[], query: string, group: string | null): T[] {
  const q = query.trim().toLowerCase();
  return connectors.filter((c) => {
    if (group && groupOf(c.category).id !== group) return false;
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

/**
 * Two letters for a connector's tile, as the approved screens: the manifest's own when it gives
 * them (Cloudflare is CF), else its words' first letters, leaving out a version number (Google
 * Analytics 4 is GA) and Google in a longer name (Google Search Console is SC). A one word name
 * splits where a capital starts a word inside it (HubSpot is HS), or else gives its first two letters.
 */
export function initialsOf(name: string, own?: string): string {
  if (own) return own;
  const words = name.split(/\s+|(?<=[a-z])(?=[A-Z])/).filter((w) => w && !/^\d+$/.test(w));
  const kept = words.length > 2 ? words.filter((w) => w !== "Google") : words;
  if (kept.length === 1) return kept[0]!.slice(0, 2).toUpperCase();
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

// --- Listing -------------------------------------------------------------------------------------

export const LISTING_COPY = {
  chooseHow: "Choose how to connect",
  signInTitle: "Sign in with Google",
  quickest: "Quickest",
  shareTitle: "Share access",
  shareTitleOr: "Or share access",
  shareLead: "Give a Google address made for this connection access to your property. No password or token is stored, and it keeps working when people leave.",
  shareStart: "Make the address",
  copyStep: "Copy this address.",
  checkHint: "It can take a minute or two before Google lets a new address in.",
  checkAccess: "Check access",
  copied: "Copied",
  tokenTitle: "Connect with an API token",
  tokenCheck: "YouGrow checks the token before anything is saved.",
  check: "Check",
  checking: "Checking the token…",
  checkFirst: "Press Check: YouGrow checks the token and lists what it can read. Nothing is saved until you press Connect.",
  listedHint: "Listed after the token is checked.",
  chooseOne: "Choose one",
  checkedChoose: "Token checked. Choose one from the list. Nothing is saved until you press Connect.",
  pickFromList: "Pick from the list",
  tokenReconnect:
    "Connecting again replaces the connection whose token was turned down: YouGrow disconnects it first, then checks the new token. Once the new token works, who can read it carries over.",
  tokenRetry: "The old connection is disconnected now. Try again without leaving this page, and who can read it still carries over.",
  grantsLost: "Connected, but who can read it didn't carry over. On Connected, tick these again:",
  openConnected: "Open Connected",
  readsTitle: "What it reads",
  numbersTitle: "Numbers it gives",
  dataFrom: "Data from",
  openingGoogle: "Opening Google…",
  aboutLabel: "About this connector",
  youNeed: "You need",
  limits: "Limits",
  whoCanSee: "Who can see it",
  disconnect: "Disconnect",
  adminsOnly: "Only admins connect. Ask an admin on your team.",
  signInWaiting: "You signed in, but haven't chosen which property it reads yet. Nothing is read until you do.",
  choose: "Choose a property",
  connectedBanner: "Connected. Choose who can read it on Connected.",
  reconnectedBanner: "Signed in again. The property it reads, who can read it and its history all stay.",
  signInFallback: "The sign in didn't finish. Start again.",
  googleLimit: "Google lets one Google account keep up to 100 sign ins with YouGrow. Past that, the oldest stops working.",
} as const;

/**
 * After a Reconnect whose grants didn't carry over: what to tick again on Connected, named as the
 * boxes there name them. Null when there is nothing a person could tick (Vizzy's box shows only
 * while Vizzy reads connected data).
 */
export function grantsLostWords(grants: ReadonlyArray<{ to: string }>, chat: boolean): string | null {
  const boxes: string[] = [];
  if (grants.some((g) => g.to === "members")) boxes.push(CONNECTED_COPY.members);
  if (chat && grants.some((g) => g.to === "agent:vizzy")) boxes.push(CONNECTED_COPY.vizzy);
  if (!boxes.length) return null;
  return `${LISTING_COPY.grantsLost} ${boxes.map((b) => `“${b}”`).join(" and ")}.`;
}

/** Why a sign in with Google didn't finish, from the reason the callback sends back. */
export function signInReasonWords(reason: string | null | undefined): string {
  return reason && Object.prototype.hasOwnProperty.call(SIGNIN_REASONS, reason) ? SIGNIN_REASONS[reason as keyof typeof SIGNIN_REASONS] : LISTING_COPY.signInFallback;
}

/** The note once a pasted token is checked and lists what it can see: the one chosen, by name. */
export function tokenCheckedWords(accounts: ReadonlyArray<{ id: string; label: string }>, chosen: string): string {
  const one = accounts.find((a) => a.id === chosen);
  return one ? `Token checked: it can see ${one.label}. Nothing is saved until you press Connect.` : LISTING_COPY.checkedChoose;
}

/** Which one starts chosen after Check: the one a Reconnect replaces, else the only one, else none. */
export function chosenAtFirst(accounts: ReadonlyArray<{ id: string }>, current: string | null | undefined): string {
  if (current && accounts.some((a) => a.id === current)) return current;
  return accounts.length === 1 ? accounts[0]!.id : "";
}

/** When the provider listed more than the picker shows: the account can still be typed. */
export const moreListedWords = (name: string, field: string) => `${name} listed more than fit here. If yours isn't in the list, type its ${field} instead.`;

/**
 * Why the account is typed after Check, in words that fit how it got there: the token can't list
 * them (the manifest's own note), or the admin pressed Type after the provider listed more than fit.
 */
export function typedWhyWords(name: string, field: string, pick: { cantList: string }, listed: boolean): string {
  return listed ? `${name} listed more than fit here, so type the ${field} of the one you want.` : pick.cantList;
}

/** "What it reads": the manifest's read lines, then what it never does. */
export function readsOf(listing: Pick<ConnectorListing, "shares">): { rows: Array<{ what: string; detail: string; where: string }>; never: string[] } {
  return {
    rows: listing.shares.filter((s) => s.direction === "read").map((s) => ({ what: s.what, detail: s.detail ?? "", where: s.where })),
    never: listing.shares.filter((s) => s.direction === "never").map((s) => s.where),
  };
}

/** Every number a connector gives, each once, with its meaning, and the slowest lag. */
export function numbersOf(listing: Pick<ConnectorListing, "produces">): { numbers: Array<{ name: string; definition: string }>; lag: string[] } {
  const seen = new Set<string>();
  const numbers: Array<{ name: string; definition: string }> = [];
  for (const p of listing.produces) {
    for (const m of p.measures) {
      if (seen.has(m.key)) continue;
      seen.add(m.key);
      numbers.push({ name: m.name, definition: m.definition });
    }
  }
  // Each stream's lag, and what is kept of it while collected numbers are on.
  return { numbers, lag: [...new Set(listing.produces.flatMap((p) => [p.lag, ...(p.collect ? [p.collect] : [])]))] };
}

export const tokenMethodOf = (listing: Pick<ConnectorListing, "connect">) => listing.connect.find((c): c is TokenFieldsMethod => c.method === "token_fields") ?? null;
export const shareMethodOf = (listing: Pick<ConnectorListing, "connect">) => listing.connect.find((c): c is ShareAccessMethod => c.method === "share_access") ?? null;

/** "A and B", or "A, B and C". */
const andList = (items: readonly string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

/** The "You need" line: the token's permissions, or access to the property for Google. */
export function youNeedOf(listing: Pick<ConnectorListing, "name" | "connect" | "ready">): string {
  const token = listing.ready.includes("token_fields") ? tokenMethodOf(listing) : null;
  if (token) {
    const which = token.permissions.length === 1 ? "this permission" : "these permissions";
    return `A ${listing.name} account that can make API tokens, and a token with ${which}: ${andList(token.permissions)}.`;
  }
  const share = listing.ready.includes("share_access");
  return share
    ? `Access to the site or property in ${listing.name}. To share access, someone who can add users to it.`
    : `A Google account that can see the site or property in ${listing.name}.`;
}

/** The "Limits" lines: the live read caps, and Google's sign in limit when Sign in is offered. */
export function limitsOf(listing: Pick<ConnectorListing, "ready">, chat: boolean): string[] {
  const reads = chat
    ? `Vizzy reads up to ${LIVE_LIMITS.maxDays} days and ${LIVE_LIMITS.maxRows} rows at a time.`
    : `Each read covers up to ${LIVE_LIMITS.maxDays} days and ${LIVE_LIMITS.maxRows} rows.`;
  return listing.ready.includes("oauth_pkce") ? [reads, LISTING_COPY.googleLimit] : [reads];
}

export const whoCanSeeOf = (chat: boolean) =>
  chat ? "Admins connect and disconnect. You choose whether members and Vizzy can read it." : "Admins connect and disconnect. You choose whether members can read it.";

/** The brand's shared connection to this connector still waiting for its property, if any (admins only see its address). */
export function waitingShareOf(connections: readonly ConnectionView[], connectorId: string): ConnectionView | null {
  return (
    connections.find(
      (c) =>
        c.connectorId === connectorId &&
        c.status === "connected" &&
        c.needsAccount &&
        c.details?.method === "share_access" &&
        !!c.details.serviceAccount &&
        !c.details.serviceAccount.deletedAt,
    ) ?? null
  );
}

/** A sign in to this connector that hasn't picked its property yet, if any. */
export function waitingSignInOf(connections: readonly ConnectionView[], connectorId: string): ConnectionView | null {
  return connections.find((c) => c.connectorId === connectorId && c.status === "connected" && c.needsAccount && c.details?.method === "oauth_pkce") ?? null;
}

/** The token connection a Reconnect replaces: this connector's, connected, by token, turned down. */
export function replaceableOf(connections: readonly ConnectionView[], connectorId: string, id: string | null | undefined): ConnectionView | null {
  if (!id) return null;
  return connections.find((c) => c.id === id && c.connectorId === connectorId && c.status === "connected" && c.details?.method === "token_fields" && c.health.state === "broken") ?? null;
}

// --- The property picker ---------------------------------------------------------------------

export const PICKER_COPY = {
  title: "Which property is this brand's?",
  signedIn: "Signed in with Google",
  connect: "Connect this property",
  change: "Read this property",
  loading: "Looking up what it can see…",
  newHint: "Nothing is read until you choose. Cancel disconnects it and deletes what YouGrow stored for it.",
  changeHint: "Pick another to change what it reads. Who can read it and its history stay.",
  noneSignedIn: "This Google account can't see any properties here. Sign in again with the account that can.",
  adminsOnly: "Only admins choose what a connection reads. Ask an admin on your team.",
  gone: "This connection isn't waiting for a property. Start again from Browse.",
} as const;

const bareHost = (h: string) => h.trim().toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
const HOST_IN_TEXT = /(?:^|[\s(])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})(?=$|[\s),/])/i;

/**
 * The website a site or property is on, when it says: a Search Console domain property
 * (sc-domain:acme.example), a URL prefix property, or a host in a property's name. Null when it
 * doesn't say, as a Google Analytics property named "Acme website" doesn't.
 */
export function accountHost(a: { id: string; label: string }): string | null {
  if (a.id.startsWith("sc-domain:")) return bareHost(a.id.slice("sc-domain:".length)) || null;
  if (/^https?:\/\//i.test(a.id)) {
    try {
      return bareHost(new URL(a.id).hostname) || null;
    } catch {
      return null;
    }
  }
  const m = HOST_IN_TEXT.exec(a.label);
  return m ? bareHost(m[1]!) : null;
}

/** True when two hosts are the same site: equal, or one inside the other (shop.acme.example and acme.example). */
export function sameSite(host: string, root: string): boolean {
  const a = bareHost(host);
  const b = bareHost(root);
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/**
 * The note beside a site or property that isn't on the brand's own website (its root domain).
 * It never blocks the pick. None when the brand has no root domain, or the property doesn't say
 * which website it is on.
 */
export function domainNote(a: { id: string; label: string }, rootDomain: string | null | undefined): string | null {
  const root = rootDomain ? bareHost(rootDomain) : "";
  if (!root) return null;
  const host = accountHost(a);
  if (!host || sameSite(host, root)) return null;
  return `Not on ${root}, this brand's site. You can still choose it.`;
}

/** Which one starts chosen: what it reads now, else the first on the brand's own site, else the only one. */
export function preselected(accounts: ReadonlyArray<{ id: string; label: string }>, current: string, rootDomain: string | null | undefined): string | null {
  if (current && accounts.some((a) => a.id === current)) return current;
  const root = rootDomain ? bareHost(rootDomain) : "";
  if (root) {
    const mine = accounts.find((a) => {
      const host = accountHost(a);
      return host !== null && sameSite(host, root);
    });
    if (mine) return mine.id;
  }
  return accounts.length === 1 ? accounts[0]!.id : null;
}

/** The manifest's own line about the list a sign in or address can see (which ones are left out). */
export function listedNoteOf(listing: Pick<ConnectorListing, "shares">): string | null {
  return listing.shares.find((s) => s.direction === "read" && /can see/.test(s.what))?.where ?? null;
}

// --- Connected -----------------------------------------------------------------------------------

export const CONNECTED_COPY = {
  none: "Nothing is connected yet. Browse to connect your first one.",
  grantsLead: "Choose who can read it. Admins always can.",
  members: "Members can read it",
  vizzy: "Vizzy can read it when someone asks",
  checkNow: "Check now",
  pause: "Pause",
  resume: "Resume",
  disconnect: "Disconnect",
  reconnect: "Reconnect",
  manageHint: "Disconnect deletes what YouGrow stored for it. Pause stops every read until you resume.",
  checkedOk: "Working: the check went through.",
  activity: "Activity",
  activityKept: "The activity log is kept for 90 days.",
  noActivity: "Nothing has happened yet.",
  turnedOff: "This connector is turned off in this copy of YouGrow, so it reads nothing. It works again when it is turned back on.",
  askAdmin: "Ask an admin to reconnect it.",
  address: "Google address",
  confirmDisconnect: "YouGrow deletes what it stored for it, and it reads nothing more.",
  readsYou: "You can read it",
  readsAdmins: "Admins only",
  pausedByAdmin: "Paused by an admin. Press Resume to read it again.",
  chooseRow: "Choose a connection in the table to manage it.",
} as const;

/** The note after a Disconnect: which connection went, then what to do at the tool. */
export const disconnectedWords = (what: string, message: string) => `${what} is disconnected. ${message}`;

/** What a connection reads, as its panel and Disconnect name it: its label when it has its own, else its account. */
export function readsWords(c: Pick<ConnectionView, "connectorName" | "label" | "details">): string {
  if (c.label && c.label !== c.connectorName) return c.label;
  return c.details?.account ? accountWords(c.details.account) : "";
}

/** A connection by its connector and what it reads: "Cloudflare for acme.example". */
export function connectionWords(c: Pick<ConnectionView, "connectorName" | "label" | "details">): string {
  const reads = readsWords(c);
  return reads ? `${c.connectorName} for ${reads}` : c.connectorName;
}

/**
 * A connection's name in a banner or an activity line: its tool's name, or, when the list holds
 * another connection to the same tool, which one ("Cloudflare for acme.example").
 */
export function nameAmong(
  c: Pick<ConnectionView, "id" | "connectorId" | "connectorName" | "label" | "details">,
  among: ReadonlyArray<Pick<ConnectionView, "id" | "connectorId">>,
): string {
  return among.some((o) => o.id !== c.id && o.connectorId === c.connectorId) ? connectionWords(c) : c.connectorName;
}

/** Disconnect's confirm, naming the connection it disconnects. */
export const confirmDisconnectWords = (c: Pick<ConnectionView, "connectorName" | "label" | "details">) => `Disconnect ${connectionWords(c)}? ${CONNECTED_COPY.confirmDisconnect}`;

export const HOW_LABELS: Readonly<Record<ConnectMethodName, string>> = {
  token_fields: "API token",
  oauth_pkce: "Signed in with Google",
  share_access: "Shared access",
};

/** What a connection reads, as people read it: a domain property, a URL, a GA4 property, a zone. */
export function accountWords(account: string): string {
  if (!account) return "No property chosen yet";
  if (account.startsWith("sc-domain:")) return `${account.slice("sc-domain:".length)} (whole domain)`;
  const property = /^properties\/(\d+)$/.exec(account);
  if (property) return `Property ${property[1]}`;
  if (/^[0-9a-f]{32}$/.test(account)) return `Zone ${account.slice(0, 6)}…${account.slice(-4)}`;
  return account;
}

/** A connection's state in the table and on Browse's Connected tab. */
export function stateOf(c: Pick<ConnectionView, "status" | "connectorOn" | "needsAccount" | "health">): { label: string; tone: Tone } {
  if (c.status === "disconnected") return { label: "Disconnected", tone: "muted" };
  if (!c.connectorOn) return { label: "Turned off here", tone: "muted" };
  if (c.needsAccount) return { label: "Choose a property", tone: "warn" };
  if (c.health.state === "ok") return { label: "Working", tone: "ok" };
  if (c.health.state === "paused") return { label: "Paused", tone: "muted" };
  if (c.health.state === "check") return { label: "Check failed", tone: "warn" };
  return { label: "Needs attention", tone: "warn" };
}

/**
 * Every state the Connected table shows, in its order, for the help page: the words come from
 * stateOf and what each health state means from the help words. A disconnected connection leaves
 * the table, so Disconnected isn't one of them.
 */
export const STATE_LABELS = ["Working", "Check failed", "Needs attention", "Paused", "Choose a property", "Turned off here"] as const;

/**
 * A banner's words: waiting for a property, or the problem in its own words. A message that already
 * names the tool, as a turned down token's does ("Cloudflare turned the token down."), stands alone;
 * any other is put after the tool's name. With two connections to one tool in `among`, the name says
 * which ("Cloudflare for acme.example turned the token down.").
 */
export function bannerWords(
  c: Pick<ConnectionView, "id" | "connectorId" | "connectorName" | "label" | "details" | "needsAccount" | "health">,
  among: ReadonlyArray<Pick<ConnectionView, "id" | "connectorId">> = [],
): string {
  const name = nameAmong(c, among);
  if (c.needsAccount) return `${name} is connected, but reads nothing until a property is chosen.`;
  const message = c.health.message ?? "it needs connecting again.";
  return message.startsWith(`${c.connectorName} `) ? `${name}${message.slice(c.connectorName.length)}` : `${name}: ${message}`;
}

/** The connections whose banner asks for something: turned down, or waiting for a property. */
export function needsAttention(connections: readonly ConnectionView[]): ConnectionView[] {
  return connections.filter((c) => c.status === "connected" && c.connectorOn && (c.health.state === "broken" || c.needsAccount));
}

/**
 * The connection Connected's panel opens on, chosen once when the page is drawn and then kept in
 * the page's state: the one the address names (`?c=<id>`, from a Review row) when it is shown,
 * else the first row shown, as the approved Connected screen opens on its first row while another
 * needs attention (that one has its banner and Reconnect above the table), else none.
 */
export function firstSelected(connections: readonly ConnectionView[], wanted: string | null = null): string | null {
  if (wanted && connections.some((c) => c.id === wanted && c.status === "connected")) return wanted;
  return connections.find((c) => c.status === "connected")?.id ?? null;
}

// --- Collected numbers (CONNECTORS_COLLECT_ENABLED) ------------------------------------------------

export const COLLECTED_COPY = {
  column: "Collected",
  block: "Collected numbers",
  progress: "Days collected",
  startsSoon: "Starts within the hour",
  nothingYet: "Nothing collected yet. The first days arrive within the hour, newest first.",
  pausedHint: "Nothing is collected until you resume.",
  stoppedHint: "Nothing new is collected until YouGrow can read the property again.",
  failedHintEnd: "YouGrow tries again on its own.",
  restArrive: "The rest arrive over the next few hours, newest first.",
  planningLead: "Used for planning:",
  planningYes: " yes. Members and Vizzy can read it, so its numbers feed Next up, Review and the brand map.",
  planningNoChat: " no. Suggestions need Vizzy to read connected data, which is off in this copy.",
  losingNeeds: "A page losing clicks needs 56 collected days, so that check starts once they are in.",
  manageHint: "Disconnect deletes what YouGrow stored for it, including its collected numbers. Pause stops every read until you resume.",
  manageHintPlanning:
    "Disconnect deletes what YouGrow stored for it, including its collected numbers and the suggestions they made. Pause stops every read until you resume.",
} as const;

/** "Waiting for Search Console to finish 21 Nov." */
export const waitingWords = (name: string, day: string) => `Waiting for ${name} to finish ${dayWords(day)}.`;
/** The provider in a line about its own listing: Google for Google's tools. */
const providerOf = (c: Pick<ConnectionView, "connectorName">) => (c.connectorName.startsWith("Google ") ? "Google" : c.connectorName);
/** "Search Console" for "Google Search Console": the product people name. */
const productOf = (c: Pick<ConnectionView, "connectorName">) => c.connectorName.replace(/^Google (Search Console)$/, "$1");

/**
 * When collecting stopped: the provider turning it down, or failing every day for 3 days or more
 * since (the server sets failedSince only then, Review's own rule). A younger failure is a hint.
 */
function stoppedOn(c: Pick<ConnectionView, "health" | "details">): string | null {
  if (c.health.state === "broken") return c.health.since ?? c.health.lastCheckedAt;
  return c.details?.collect?.failedSince ?? null;
}

/** "Collecting failed on 23 Nov. YouGrow tries again on its own.", for a failure under 3 days old. */
export const failedWords = (iso: string) => `Collecting failed on ${dayWords(iso.slice(0, 10))}. ${COLLECTED_COPY.failedHintEnd}`;

/**
 * The Collected cell on Connected (admins): paused, stopped, filling its 90 days (with a bar), or
 * collected to a day, with a hint when a day is late or the provider listed nothing.
 */
export function collectedCell(
  c: Pick<ConnectionView, "connectorName" | "health" | "details" | "needsAccount">,
): { main: string; hint: string | null; progress: { value: number; max: number } | null } | null {
  const k = c.details?.collect;
  if (!k) return null;
  const to = k.lastDay ? `Collected to ${dayWords(k.lastDay)}` : null;
  if (c.details?.pausedAt) return { main: `Paused on ${dayWords(c.details.pausedAt.slice(0, 10))}`, hint: to, progress: null };
  const stopped = stoppedOn(c);
  if (stopped) return { main: `Stopped on ${dayWords(stopped.slice(0, 10))}`, hint: to, progress: null };
  if (c.needsAccount || !k.lastDay) return { main: c.needsAccount ? "Waits for a property" : COLLECTED_COPY.startsSoon, hint: null, progress: null };
  if (!k.filled) return { main: `Filling ${k.keepDays} days: ${k.days} of ${k.keepDays}`, hint: null, progress: { value: k.days, max: k.keepDays } };
  const final = k.finalThrough && k.finalThrough < k.lastDay ? ` (final to ${dayWords(k.finalThrough)})` : "";
  const hint = k.failedOn ? failedWords(k.failedOn) : k.waitingFor ? waitingWords(productOf(c), k.waitingFor) : k.holdReason === "no_data" ? `${productOf(c)} listed no data in the last 10 days.` : null;
  return { main: `To ${dayWords(k.lastDay)}${final}, ${k.days} days`, hint, progress: null };
}

/** A line of the Manage card's Collected numbers block: plain or a hint, with an optional lead and bar. */
export interface CollectedLine {
  text: string;
  hint: boolean;
  lead?: string;
  progress?: { value: number; max: number };
}

/**
 * The Manage card's Collected numbers block, as the approved Connected screen: how far it is
 * collected and in which zone, how long a day takes, the days kept and what each holds, and, while
 * collected numbers suggest articles (`planning`), whether this connection is used for planning.
 */
export function collectedLines(
  c: Pick<ConnectionView, "connectorName" | "health" | "details" | "needsAccount">,
  opts: { planning?: boolean; chat?: boolean } = {},
): CollectedLine[] {
  const k = c.details?.collect;
  if (!k) return [];
  const out: CollectedLine[] = [];
  const L = (text: string, extra: Partial<CollectedLine> = {}) => out.push({ text, hint: false, ...extra });
  const H = (text: string) => out.push({ text, hint: true });
  const zone = zoneWords(k.timeZone);
  const pausedAt = c.details?.pausedAt ?? null;
  const stopped = pausedAt ? null : stoppedOn(c);
  if (pausedAt) {
    L(`Paused on ${dayWords(pausedAt.slice(0, 10))}. ${COLLECTED_COPY.pausedHint}`);
    if (k.lastDay) L(`Collected to ${dayWords(k.lastDay, true)}, ${zone}.`);
  } else if (stopped) {
    L(`Stopped on ${dayWords(stopped.slice(0, 10))}.${k.lastDay ? ` Collected to ${dayWords(k.lastDay, true)}, ${zone}.` : ""}`);
    H(COLLECTED_COPY.stoppedHint);
  } else if (k.lastDay) {
    const lag = k.finalThrough && k.finalThrough < k.lastDay ? `Days after ${dayWords(k.finalThrough)} may still change a little, so each is read again a week later.` : k.lag;
    L(`Collected to ${dayWords(k.lastDay, true)}, ${zone}. ${lag}`);
    if (k.failedOn) H(failedWords(k.failedOn));
    if (k.waitingFor) H(waitingWords(productOf(c), k.waitingFor));
    if (k.holdReason === "no_data") H(`${productOf(c)} listed no data in the last 10 days.`);
  } else {
    L(c.needsAccount ? "Nothing is collected until a property is chosen." : COLLECTED_COPY.nothingYet);
  }
  if (k.lastDay && k.keptFrom) {
    L(k.filled ? `Kept: ${dayWords(k.keptFrom)} to ${dayWords(k.lastDay)} (${k.days} days).` : `Kept: ${dayWords(k.keptFrom)} to ${dayWords(k.lastDay)} so far (${k.days} of ${k.keepDays} days).`, k.filled ? {} : { progress: { value: k.days, max: k.keepDays } });
    const cut = k.kept && k.kept.rows < k.kept.seen && !pausedAt && !stopped ? ` On ${dayWords(k.kept.day)} ${providerOf(c)} listed ${k.kept.more ? "at least " : ""}${k.kept.seen.toLocaleString("en-GB")} ${ROW_WORDS[k.kept.by] ?? "rows"} and ${k.kept.rows.toLocaleString("en-GB")} were kept.` : "";
    H(`${k.keeps}${cut}`);
    if (!k.filled && !pausedAt && !stopped) H(COLLECTED_COPY.restArrive);
    if (pausedAt || stopped) H(`Each day still leaves after ${k.keepDays} days.`);
  }
  if (opts.planning && k.feedsPlanning) {
    const { members, vizzy } = readersOf(c);
    if (members && vizzy) {
      L(COLLECTED_COPY.planningYes, { lead: COLLECTED_COPY.planningLead });
      if (!k.filled && c.connectorName === "Google Search Console") H(COLLECTED_COPY.losingNeeds);
    } else if (opts.chat === false) {
      // No Vizzy grant can be given in this copy, so don't ask for one.
      L(COLLECTED_COPY.planningNoChat, { lead: COLLECTED_COPY.planningLead });
    } else {
      const ask = members ? "Let Vizzy read it too" : vizzy ? "Let members read it too" : "Let members and Vizzy read it";
      L(` no. ${ask}, and its numbers will feed Next up, Review and the brand map.`, { lead: COLLECTED_COPY.planningLead });
    }
  }
  return out;
}

/** The rows a grouping keeps, in words. */
const ROW_WORDS: Readonly<Record<string, string>> = { page: "pages", topic: "searches", landing: "landing pages" };

/** Whether members and Vizzy may read a connection: both, and its numbers are used for planning. */
function readersOf(c: Pick<ConnectionView, "details">): { members: boolean; vizzy: boolean } {
  const grants = c.details?.grants ?? [];
  return { members: grants.some((g) => g.to === "members"), vizzy: grants.some((g) => g.to === "agent:vizzy") };
}

/**
 * The Manage card's last line: what Disconnect deletes, with collected numbers when they are on, and
 * the suggestions they made only when the connection is used for planning (members and Vizzy read it).
 */
export function manageHintOf(c: Pick<ConnectionView, "details">, opts: { collect: boolean; planning?: boolean }): string {
  if (!opts.collect || !c.details?.collect) return CONNECTED_COPY.manageHint;
  const { members, vizzy } = readersOf(c);
  return opts.planning && c.details.collect.feedsPlanning && members && vizzy ? COLLECTED_COPY.manageHintPlanning : COLLECTED_COPY.manageHint;
}

/** A member's Reading cell: whether they can read it, and how far it is collected while collected numbers are on. */
export function readingWords(c: Pick<ConnectionView, "canReadLive" | "collectedTo">, collect: boolean): string {
  if (!c.canReadLive) return CONNECTED_COPY.readsAdmins;
  return collect && c.collectedTo ? `${CONNECTED_COPY.readsYou}, collected to ${dayWords(c.collectedTo)}` : CONNECTED_COPY.readsYou;
}

/**
 * The connection the panel shows: the one selected while it is still connected, and never another
 * in its place. Choosing it from the state alone is what keeps the panel on the connection acted on.
 */
export function selectedOf(connections: readonly ConnectionView[], id: string | null): ConnectionView | null {
  return id ? (connections.find((c) => c.id === id && c.status === "connected") ?? null) : null;
}

/** Who may read it beyond admins, from its grants (Vizzy only while Vizzy reads connected data). */
export function whoCanReadOf(c: Pick<ConnectionView, "details">, chat: boolean): string {
  const grants = c.details?.grants ?? [];
  const who = ["Admins"];
  if (grants.some((g) => g.to === "members")) who.push("members");
  if (chat && grants.some((g) => g.to === "agent:vizzy")) who.push("Vizzy");
  return who.join(", ");
}

/** The grants after ticking or unticking one, keeping any it already has. */
export function withGrant(grants: ReadonlyArray<{ to: "members" | "agent:vizzy"; can: "read" }>, to: "members" | "agent:vizzy", on: boolean) {
  const rest = grants.filter((g) => g.to !== to);
  return on ? [...rest, { to, can: "read" as const }] : rest;
}

/** Who did something, in the words of the person reading. */
export function whoWords(by: string, uid: string): string {
  if (uid && by === uid) return "You";
  if (by === "system") return "YouGrow";
  if (by.startsWith("agent:")) return "Vizzy";
  return "An admin";
}

/** A moment, near ones as "2 hours ago", older ones as a date (UTC, so server and browser agree). */
export function whenWords(at: string, now: Date): string {
  const ms = now.getTime() - Date.parse(at);
  if (!Number.isFinite(ms)) return "";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return min === 1 ? "1 minute ago" : `${min} minutes ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  if (hours < 48) return "yesterday";
  return new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** Short words for why a call failed, for an activity line. The full words are on the connection. */
const SHORT: Readonly<Record<string, string>> = {
  token_refused: "the token was turned down",
  account_refused: "it can't read that account",
  signin_refused: "Google ended the sign in",
  share_not_visible: "the address can't see the property",
  share_access_lost: "YouGrow lost access to the property",
  share_pending: "Google is still setting up the address",
  rate_limited: "the provider asked YouGrow to slow down",
  provider_error: "the provider had a problem",
  timeout: "the provider took too long",
  network: "the provider couldn't be reached",
  secret_unopenable: "its saved token can't be opened",
  query_refused: "the provider refused the question",
};
const shortWhy = (code: string | null) => (code && SHORT[code]) || "it didn't go through";

const GRANT_WORDS: Readonly<Record<string, string>> = {
  "members,agent:vizzy": "Members and Vizzy may read",
  members: "Members may read",
  "agent:vizzy": "Vizzy may read",
  none: "Only admins may read",
};

/** One activity line: what happened to which connection. */
export function activityWords(e: { kind: string; code: string | null }, name: string, method: ConnectMethodName | undefined): string {
  switch (e.kind) {
    case "connected":
      if (e.code === "signed_in_again") return `${name} signed in again`;
      return method === "oauth_pkce" ? `${name} connected by signing in with Google` : method === "share_access" ? `${name} connected by sharing access` : `${name} connected`;
    case "verified":
      return `${name} checked: working`;
    case "failed":
      return `${name} check failed: ${shortWhy(e.code)}`;
    case "paused":
      return e.code ? `Calls to ${name} paused for a while: ${shortWhy(e.code)}` : `${name} paused`;
    case "resumed":
      return `${name} resumed`;
    case "grants_changed":
      return `${GRANT_WORDS[e.code ?? "none"] ?? GRANT_WORDS.none} ${name}`;
    case "account_picked":
      return `Property chosen for ${name}`;
    case "shared":
      return `Google address made for ${name}`;
    case "access_checked":
      return e.code === "ok" ? `Access checked: ${name} can see the property` : `Access checked for ${name}: ${shortWhy(e.code)}`;
    case "read":
      return `Vizzy read ${name}`;
    case "collected":
      return `Numbers collected for ${name}`;
    case "erased":
      return e.code === "old_site" ? `Collected numbers for the old property of ${name} deleted` : `Collected numbers for ${name} deleted`;
    case "disconnected":
      return `${name} disconnected`;
    case "cleanup_failed":
      return `The Google address for ${name} couldn't be deleted yet. YouGrow tries again.`;
    case "purged":
      return `${name} removed by whoever runs YouGrow`;
    default:
      return `${name} changed`;
  }
}

/**
 * Every connection's recent changes, newest first, each with the connection it belongs to: its
 * tool's name, or which one when two connections to that tool are in the list.
 */
export function activityOf(connections: readonly ConnectionView[], limit = 12): Array<{ at: string; text: string; by: string; key: string }> {
  return connections
    .flatMap((c) =>
      (c.details?.recent ?? []).map((e, i) => ({
        at: e.at,
        text: activityWords(e, nameAmong(c, connections), c.details?.method),
        by: e.kind === "purged" ? "operator" : e.by,
        key: `${c.id}:${i}`,
      })),
    )
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}

/** The line under a connection's state: paused and why, the problem in its own words, or when it last worked. */
export function healthLine(c: Pick<ConnectionView, "health" | "connectorOn" | "status" | "details">, now: Date): string | null {
  if (c.status !== "connected") return null;
  if (!c.connectorOn) return CONNECTED_COPY.turnedOff;
  if (c.details?.pausedAt) return CONNECTED_COPY.pausedByAdmin;
  if (c.health.state === "paused" && c.health.pausedUntil && Date.parse(c.health.pausedUntil) > now.getTime()) {
    const min = Math.max(1, Math.ceil((Date.parse(c.health.pausedUntil) - now.getTime()) / 60_000));
    const left = `Calls start again by themselves in about ${min === 1 ? "1 minute" : `${min} minutes`}.`;
    return c.health.message ? `${c.health.message} ${left}` : left;
  }
  if (c.health.message) return c.health.message;
  return c.health.lastOkAt ? `Last worked ${whenWords(c.health.lastOkAt, now)}.` : null;
}

// --- Organisations share connections (Connectors 3, CONNECTORS_SHARING_ENABLED) -----------------

export const ORGANISATION_PATH = "/admin/account/organisation";
export const SHARED_HELP_PATH = "/help/shared-connections";

/** What one part of a connector is called: a site, a property or a zone. */
export function partUnit(connectorId: string): { one: string; many: string } {
  if (connectorId === "search-console") return { one: "site", many: "sites" };
  if (connectorId === "google-analytics") return { one: "property", many: "properties" };
  if (connectorId === "cloudflare") return { one: "zone", many: "zones" };
  return { one: "part", many: "parts" };
}

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
/** "Vizzybl's", "Fernhill US's", but "Harbour Blooms'". */
export const whoseWords = (name: string) => (/s$/.test(name) ? `${name}'` : `${name}'s`);
/** "the United States" in a sentence, other regions as they are. */
export const regionInSentence = (region: string) => (region === "United States" ? "the United States" : region);
const joinAnd = (xs: readonly string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/**
 * A part as its owners read it: a Search Console site as Google names it, a GA4 property with its
 * name, a Cloudflare zone by its name. `label` is the brand record's (the name it was given with).
 */
export function partWords(account: string, label?: string | null): string {
  const property = /^properties\/(\d+)$/.exec(account);
  if (property) return label && label !== account && !/^Google /.test(label) ? `Property ${property[1]} (${label})` : `Property ${property[1]}`;
  if (/^[0-9a-f]{32}$/.test(account)) return label && label !== "Cloudflare" ? label : accountWords(account);
  return account;
}

export const CONNECT_FOR_COPY = {
  legend: "Connect for",
  /** The consent line before Google's screen, for an organisation (pick 6). */
  consent: (org: string, unit: string) =>
    `You can give each brand in ${org} one ${unit} this Google account can see. Only you see the list. Each brand's team sees only its own ${unit}, and the other owners see which brand has which.`,
  thisBrand: (brand: string) => `This brand (${brand})`,
  organisation: (org: string) => `${org} (all its brands)`,
  keptIn: (region: string, brand: string) => `Kept in ${region}, where ${brand} keeps its data. Each brand's numbers stay in its own region.`,
  tokenHint: (org: string) => `For ${org}, include every zone its brands use under Zone Resources. YouGrow lists them, and you give each brand its own.`,
  tokenConnect: "Connect for the organisation",
  connecting: "Checking the token…",
  checkedGoOn: "The address can see what it needs. Give each brand its part on Settings › Organisation.",
  openOrganisation: "Open Settings › Organisation",
} as const;

export const SHARED_COPY = {
  title: "Shared connections",
  lead: "Connect once for the organisation, then give each brand its own site, property or zone. Each brand's team sees only its own.",
  none: "Nothing is shared yet. Connect Search Console, Google Analytics 4 or Cloudflare for the organisation from Settings › Connections › Browse, then give each brand its part.",
  browse: "Open Browse",
  part: "Part",
  givenTo: "Given to",
  since: "Since",
  collected: "Collected",
  readers: "Readers",
  actions: "Actions",
  change: "Change",
  takeBack: "Take back",
  pause: "Pause",
  resume: "Resume",
  signInAgain: "Sign in again",
  disconnect: "Disconnect",
  address: "Google address",
  copy: "Copy",
  copied: "Copied",
  working: "Working",
  attention: "Needs attention",
  paused: "Paused",
  lastGone: "No brand uses this any more. Disconnect it?",
  starting: "Starts within the hour",
  ending: "Being taken back",
  giving: "Being given",
  notCollected: "Not collected in this copy",
  unreadable: "Can't read it now",
  failed: "This screen didn't load. Reload the page in a minute.",
} as const;

/** "Cloudflare, API token.", "Search Console, a Google address made for YouGrow.AI.", "Google Analytics 4, signed in with Google by you." */
export function sharedHowWords(c: { method: ConnectMethodName; signer: "you" | "other" | "gone" | null }, org: string): string {
  if (c.method === "token_fields") return ", API token.";
  if (c.method === "share_access") return `, a Google address made for ${org}.`;
  return c.signer === "you" ? ", signed in with Google by you." : c.signer === "other" ? ", signed in with Google by another owner." : ", signed in with Google.";
}

/** The product people name for a connector, as the approved screens write it. */
export const productWords = (name: string) => name.replace(/^Google (Search Console)$/, "$1");

/** Who reads a part for a brand, in the give dialog's line. */
export function readerWords(method: ConnectMethodName): string {
  return method === "oauth_pkce" ? "Your Google account" : method === "share_access" ? "The Google address" : "The API token";
}

export const notSignerWords = (many: string) => `Only the owner who signed in can give its ${many}. You can take one back, pause, disconnect, or sign in again yourself.`;
export const notSignerDialogWords = (many: string) => `Only the owner who signed in can give its ${many} to more brands. You can take one back, pause, disconnect, or sign in again yourself.`;
export const signerLeftWords = (many: string) => `Signed in by someone who is no longer an owner. Sign in again to keep giving ${many}.`;
export const noPartsWords = (one: string) => `Nothing is collected until you give a brand a ${one}.`;
export const pausedOrgWords = (day: string, byYou: boolean) => `Paused on ${day} by ${byYou ? "you" : "another owner"}. No brand reads it live or collects it. Numbers already collected stay readable.`;
export const stoppedUsingWords = (brand: string, day: string) => `${brand} stopped using it on ${day}.`;
export const everyBrandHasWords = (one: string, method: ConnectMethodName) => `Each brand has a ${one} from this ${method === "token_fields" ? "token" : method === "share_access" ? "address" : "sign-in"}.`;
export const cantReadCountWords = (n: number) => (n === 1 ? "1 brand can't read its part" : `${n} brands can't read their parts`);
export const holdWords = (until: string, name: string) =>
  `Collecting paused until ${new Date(until).toISOString().slice(11, 16)} UTC because ${productWords(name)}'s limit was reached. Live reads go on.`;

/** Why a whole organisation connection needs attention, and how many brands it stopped. */
export function sharedBrokenWords(c: { method: ConnectMethodName; connectorName: string; health: { lastErrorCode: string | null; since: string | null; lastCheckedAt: string | null } }, brands: number): string {
  const when = (c.health.since ?? c.health.lastCheckedAt ?? "").slice(0, 10);
  const on = when ? ` on ${dayWords(when)}` : "";
  const who = brands === 0 ? "" : brands === 1 ? " Its brand stopped collecting." : brands === 2 ? " Both brands stopped collecting." : ` All ${brands} brands stopped collecting.`;
  const fix = brands === 2 ? "both" : brands > 2 ? "all of them" : "it";
  if (c.health.lastErrorCode === "secret_unopenable") return `YouGrow can't open this connection's saved token any more.${who} Disconnect it and connect again.`;
  if (c.method === "oauth_pkce") return `Google ended this sign-in${on}.${who} Sign in again to fix it for ${fix}.`;
  if (c.method === "share_access") return `This Google address stopped working${on}.${who} Disconnect it and make a new one.`;
  return `${productWords(c.connectorName)} turned this token down${on}.${who} Disconnect it and connect a new token.`;
}

/** A part its brand can't read, with what fixes it: the row's main line and its hint. */
export function cantReadWords(method: ConnectMethodName, account: string, connectorName: string, since: string | null): { main: string; hint: string } {
  const main = since ? `Can't read since ${dayWords(since.slice(0, 10))}.` : "Can't read it now.";
  if (method === "share_access") return { main, hint: `Add the address to ${account} again.` };
  if (method === "oauth_pkce") return { main, hint: "Sign in again with a Google account that can read it, or take it back." };
  return { main, hint: `Add it to the token in ${productWords(connectorName)}, or take it back.` };
}

/** The codes on a brand's record that say its own part can't be read (pick 12), not its sign in. */
export const PART_UNREADABLE_CODES: ReadonlySet<string> = new Set(["account_refused", "share_access_lost", "share_not_visible"]);

export const GIVE_COPY = {
  brand: "Brand",
  readersHint: "Choose who can read it. Admins always can.",
  members: "Members can read it",
  vizzy: "Vizzy can read it when someone asks",
  listMine: "Only you see this list.",
  listAny: "Any owner can give from this list.",
  loading: "Listing what it can see…",
  none: "It can't see anything yet.",
  cancel: "Cancel",
  close: "Close",
  give: "Give",
  done: "Done",
  signInWithGoogle: "Sign in with Google",
  signedInAgain: "Signed in again",
  working: "Working…",
} as const;

export const giveTitleWords = (one: string) => `Give a brand a ${one}`;
export const giveButtonWords = (brand: string | null) => (brand ? `Give to ${brand}` : GIVE_COPY.give);
export const notAdminWords = (brand: string) => `You're not an admin of ${brand}.`;
export const hasPartWords = (part: string) => `Has ${part}`;
export const givenToWords = (brand: string) => `Given to ${brand}`;
export const otherRegionWords = (brand: string, brandRegion: string, signInRegion: string) =>
  `${brand} keeps its numbers in ${regionInSentence(brandRegion)}. The sign in stays in ${signInRegion}.`;
export const insideWords = (domain: string, brand: string) => `Inside ${domain}, which ${brand} has. Both brands would see these pages.`;
export const coversWords = (site: string, brand: string) => `Covers ${site}, which ${brand} has. Both brands would see these pages.`;
export const notOnWords = (domain: string) => `Not on ${domain}.`;
export const otherOwnWords = (org: string, one: string) => `Another brand in ${org} already reads this ${one} with its own connection.`;
export const readsForWords = (method: ConnectMethodName, one: string, brand: string) => `${readerWords(method)} reads this ${one} for ${brand}. ${whoseWords(brand)} team sees only this ${one}.`;
export const readersForWords = (brand: string) => `Readers for ${brand}`;

export const changeTitleWords = (brand: string, one: string) => `Change ${whoseWords(brand)} ${one}`;
export const changeButtonWords = (one: string) => `Change ${one}`;
export const changeTextWords = (brand: string, part: string, one: string) => `${whoseWords(brand)} numbers from ${part} are deleted, and 90 days fill again from the new ${one} within a day.`;

export const takeBackTitleWords = (brand: string) => `Take back from ${brand}`;
export function takeBackTextWords(brand: string, one: string, method: ConnectMethodName, connectorName: string): string {
  const base = `${brand} stops reading this ${one} now. What YouGrow collected for it is deleted, with its suggestions.`;
  return method === "share_access" ? `${base} YouGrow's address can still read the ${one}: remove it in ${productWords(connectorName)} if no brand uses it.` : base;
}
export const addressStillReadsWords = (part: string, connectorName: string, one: string) =>
  `YouGrow's address can still read ${part}. Remove it in ${productWords(connectorName)} if no brand uses that ${one}.`;

export const disconnectTitleWords = (connectorName: string, org: string) => `Disconnect ${connectorName} for ${org}`;
export function disconnectTextWords(brands: number): string {
  if (brands === 0) return "YouGrow deletes what it stored for it, and it reads nothing more.";
  return brands === 1 ? "1 brand stops reading it now, and what YouGrow collected for it is deleted." : `${brands} brands stop reading it now, and what YouGrow collected for them is deleted.`;
}
export const REVOKE_WARNING = "Google also ends your other YouGrow connections that use the same Google account. They need signing in again.";

export const signInAgainTitleWords = (connectorName: string) => `Sign in again to ${connectorName}`;
export function signInAgainTextWords(serves: ReadonlyArray<{ brand: string; part: string }>): string {
  const n = serves.length;
  if (n === 0) return "No brand uses this sign-in yet. Signing in again uses your Google account, and makes you the one who signed in.";
  const all = n === 1 ? "it" : n === 2 ? "both" : "all of them";
  return `This sign-in serves ${n} ${n === 1 ? "brand" : "brands"}: ${joinAnd(serves.map((s) => `${s.brand} reads ${s.part}`))}. Signing in again uses your Google account for ${all}, and makes you the one who signed in.`;
}
export const afterSignInWords = (part: string, brand: string) =>
  `Your Google account can't read ${part}, so ${brand} stops reading it until someone who can signs in again, or an owner takes it back.`;
export const connectedForWords = (org: string) => `Connected for ${org}. Give each brand its part below.`;
export const signedInAgainWords = (n: number) =>
  n ? `Signed in again. ${n === 1 ? "1 brand's part" : `${n} brands' parts`} can't be read with this Google account: see below.` : "Signed in again. Every brand's part reads with your Google account.";
export const ownConnectionWords = (brand: string, connectorName: string, one: string) => `${brand} already has its own ${productWords(connectorName)} connection to this ${one}. Disconnect that one first.`;
export const unitOf = (connectorId: string) => cap(partUnit(connectorId).one);
