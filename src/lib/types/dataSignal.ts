/**
 * What a brand's collected numbers suggest (Connectors 2 group 4, CONNECTOR_SIGNALS_ENABLED,
 * ADR-0012): one row per connection, generation, rule and key in the brand's regional
 * `data_signals`, written only through src/lib/connectors/signals/store.ts and read by id or by
 * equality on the connection. The decision lives on the agent action the row names
 * (`agentActionId`): this row only indexes it, so it carries no state of its own.
 *
 * Rules, each from Search Console's final days, from planning connections only (members and Vizzy
 * may both read them):
 * - rising_search: a search with clearly more impressions in the last 14 days than the 14 before;
 * - losing_page: a page with clearly fewer clicks in the last 28 days than the 28 before;
 * - within_reach: a brand map question whose search sits just off Google's first page.
 *
 * Every detection overwrites its own row. A dismissed or planned row is blanked (only its id,
 * rule and `dismissedUntil` stay), which is enough to stop the same suggestion coming back before
 * then; erase deletes rows by connection. `ttlAt` is a Date, 30 days after detection (and at least
 * `dismissedUntil`), for the time to live `infra/lifecycle/setup.sh ttl` turns on.
 *
 * Pure: plain data and patterns only, so client components can import it.
 */

export const DATA_SIGNAL_RULES = ["rising_search", "losing_page", "within_reach"] as const;
export type DataSignalRule = (typeof DATA_SIGNAL_RULES)[number];

/** `dsg_` and 24 hex: a hash of the brand, connection, generation, rule and key (signalIdFor). */
export const DATA_SIGNAL_ID = /^dsg_[0-9a-f]{24}$/;

export function isDataSignalId(v: unknown): v is string {
  return typeof v === "string" && DATA_SIGNAL_ID.test(v);
}

/** Where a suggestion shows: a proposed question on the brand map, or a row in Review. */
export type DataSignalShownIn = "brand_map" | "review";

/** What the rule fired on: a search's words (its topic key), or a page's path on its host. */
export interface DataSignalKey {
  topic?: string;
  page?: string;
  host?: string;
}

/** The days compared: the recent window and, for a rule that compares, the one before it. */
export interface DataSignalWindow {
  from: string;
  to: string;
  beforeFrom?: string;
  beforeTo?: string;
}

export interface DataSignal {
  id: string;
  tenantId: string;
  connectionId: string;
  gen: number;
  /** The site the numbers are for. */
  account: string;
  connectorId: string;
  rule: DataSignalRule;
  /** Blanked (null) on dismiss, plan or stale. */
  key: DataSignalKey | null;
  /** The search's words or the page's path; null once blanked. */
  label: string | null;
  /** The brand map question it is about (within_reach), or the one it proposed (rising_search). */
  questionId: string | null;
  /** The question's words, for the title of a within reach suggestion; null once blanked. */
  question: string | null;
  /** The decided subject it sits nearest. */
  subjectId: string | null;
  /** The recent window's numbers by meaning key; null once blanked. */
  numbers: Record<string, number> | null;
  /** The window before, by meaning key; null for within_reach and once blanked. */
  before: Record<string, number> | null;
  /** A number in `before` (rising) or `numbers` (losing) counts a day whose rows were cut at their floor. */
  atMost: boolean;
  /** A Google Analytics number in it may still change a little (days not final yet). */
  mayChange: boolean;
  window: DataSignalWindow | null;
  shownIn: DataSignalShownIn;
  /** The open (or last) agent action for it; null when none was proposed (the caps were full). */
  agentActionId: string | null;
  /** How many times an action was proposed for it: each new one has a dedupe key of its own. */
  round: number;
  detectedAt: string;
  /** Until when its numbers stand: 30 days after detection. */
  freshUntil: string;
  /** Not suggested again before this (30 days after a dismissal or a plan). */
  dismissedUntil: string | null;
  /** The time to live: a Date, 30 days after detection and never before dismissedUntil. */
  ttlAt: Date;
}
