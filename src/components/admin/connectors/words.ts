import { LIVE_LIMITS, type ConnectMethodName, type ConnectorCategory, type ShareAccessMethod, type TokenFieldsMethod } from "@/lib/connectors/manifest";
import { SIGNIN_REASONS } from "@/lib/connectors/messages";
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
 * Two letters for a connector's tile: its words' first letters, leaving out a version number
 * (Google Analytics 4 is GA) and Google in a longer name.
 */
export function initialsOf(name: string): string {
  const words = name.split(/\s+/).filter((w) => w && !/^\d+$/.test(w));
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
  return { numbers, lag: [...new Set(listing.produces.map((p) => p.lag))] };
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
 * the page's state: the first row shown, as the approved Connected screen opens on its first row
 * while another needs attention (that one has its banner and Reconnect above the table), else none.
 */
export function firstSelected(connections: readonly ConnectionView[]): string | null {
  return connections.find((c) => c.status === "connected")?.id ?? null;
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
