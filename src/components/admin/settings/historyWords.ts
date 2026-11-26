import type { HistoryKind } from "@/lib/settings/sources";
import { TEAM_VIEWS_FULL_TEXT } from "@/lib/settings/words";

/**
 * Every message Settings › History shows, in plain words. The help page
 * (/help/history-and-restore) quotes them, and src/lib/help/help.test.ts checks it does.
 */

/** Where a version downloads from: `rev=draft` is a journey's draft. */
export const exportHref = (subject: string, rev: number | "draft") => `/api/admin/settings-history/export?subject=${encodeURIComponent(subject)}&rev=${rev}`;

/** What each kind is called in the page's opening line. */
export const KIND_WORDS: Record<HistoryKind, string> = {
  fields: "fields",
  journeys: "journeys",
  catalogs: "product catalogs",
  connections: "shared connections",
  views: "team views",
};

/** "fields, journeys and product catalogs". */
export function kindsInWords(kinds: readonly HistoryKind[]): string {
  const w = kinds.map((k) => KIND_WORDS[k]);
  return w.length <= 1 ? (w[0] ?? "settings") : `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}`;
}

/** Data model's Changes line while Settings › History is on. */
export const HISTORY_LINE = { before: "Every change is kept.", link: "See them all, and restore one, in Settings › History." } as const;

export const HISTORY_COPY = {
  lead: (kinds: string, brand: string) => `Changes to ${kinds} for ${brand}. A restore adds a new version; nothing is deleted.`,
  empty: "No changes yet. Each change is listed here once it is saved.",
  partial: "Some changes couldn't be read just now. Reload the page to see them all.",
  loadFailed: "Couldn't load the history. Reload the page to try again.",
  readOnly: "Read only here",
  archivedJourney: "Archived, read only",
  revokedProduct: "Revoked, read only",
  live: "Live",
  older: "Show older changes",
  draftNote: (version: number, by: string, when: string) => `The draft holds version ${version}, put back by ${by} ${when}. Nothing goes live until someone presses Publish.`,
} as const;

/** What a restore answers when someone saved in between, by kind. The preview opens again on Look again. */
export const RESTORE_MESSAGES = {
  fields_changed: "Someone changed the fields since you opened this. Look again.",
  draft_changed: "The draft changed since you opened this. Look again.",
  catalog_changed: "Someone changed the catalog since you opened this. Look again.",
  views_changed: "Someone changed the team views since you opened this. Look again.",
  team_views_full: TEAM_VIEWS_FULL_TEXT,
  read_only: "This can't be restored here.",
  version_not_found: "That version is no longer there. Reload the page.",
  forbidden: "Only admins can restore.",
  failed: "That didn't restore. Try again.",
} as const;

export const PREVIEW_COPY = {
  unpublished: (when: string) => `The draft has edits that aren't published, saved ${when}. They will be replaced.`,
  exportDraft: "Export the draft",
  fixAfter: "Fix after restoring.",
  saved: (rev: number, by: string, day: string) => `Version ${rev} was saved by ${by} on ${day}.`,
  published: (rev: number, by: string, day: string) => `Version ${rev} was published by ${by} on ${day}.`,
  becomes: (becomes: number, current: number) => `It becomes version ${becomes}, on top of version ${current}, so you can go back to ${current} later.`,
  restoreAs: (n: number) => `Restore as version ${n}`,
  intoDraft: (n: number) => `Put version ${n} in the draft`,
  exportFirst: (n: number) => `Export version ${n} first`,
  exportVersion: (n: number) => `Export version ${n}`,
  done: (name: string, rev: number) => `Restored. ${name} are now version ${rev}.`,
  doneDraft: (n: number) => `Version ${n} is in the draft. Nothing goes live until someone presses Publish.`,
  doneCatalog: (rev: number) => `Restored. The catalog is now version ${rev}.`,
} as const;

/** The message for an error a history route answered. */
export function restoreErrorText(data: unknown): string {
  const d = (data ?? {}) as { error?: string };
  return (d.error && (RESTORE_MESSAGES as Record<string, string>)[d.error]) || RESTORE_MESSAGES.failed;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** "just now", "5 minutes ago", "2 hours ago", "yesterday", "3 days ago", "1 week ago", else "on 3 Nov". */
export function whenText(iso: string, nowMs = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "at a time we can't read";
  const ms = Math.max(0, nowMs - t);
  if (ms < 60_000) return "just now";
  if (ms < HOUR) {
    const m = Math.floor(ms / 60_000);
    return `${m} ${m === 1 ? "minute" : "minutes"} ago`;
  }
  if (ms < DAY) {
    const h = Math.floor(ms / HOUR);
    return `${h} ${h === 1 ? "hour" : "hours"} ago`;
  }
  const days = Math.floor(ms / DAY);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 35) {
    const weeks = Math.floor(days / 7);
    return `${weeks} ${weeks === 1 ? "week" : "weeks"} ago`;
  }
  return `on ${dayText(iso)}`;
}

/** "2 Oct", in the viewer's calendar. */
export function dayText(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : iso;
}

/** Every message Erase values shows (SETTINGS_ERASE_ENABLED); the help page quotes them. */
export const ERASE_COPY = {
  action: "Erase values",
  erasableFrom: (day: string) => `values can be erased from ${day}`,
  erasing: "values being erased",
  erased: (day: string) => `values erased on ${day}`,
  title: (label: string) => `Erase the values of ‘${label}’?`,
  countedLine: (counted: string, archived: string, by: string | null) => `Counted ${counted}. Archived ${archived}${by ? ` by ${by}` : ""}.`,
  counting:
    "Counting the people, companies, history entries and Vizzy suggestions that hold it. This runs in the background, a page at a time, and takes hours for a big list. You can close this and come back: the confirm opens once the count is done.",
  lookedAt: (n: string) => `Looked at ${n} records so far.`,
  goesForGood: (each: string) => `Every value, on each ${each} and in their history. This can't be undone.`,
  stays: "The field itself, archived, with its name and options, so history still reads. Bringing it back later brings it back empty.",
  untilThen: "Each person's own export still includes their value.",
  typeToConfirm: "to confirm",
  background: "The erase runs in the background, a page at a time. You can leave this page; History shows when it is done.",
  progress: (done: string, of: string) => `Erased ${done} of ${of}.`,
  blanking: "Blanking it in their history and in Vizzy's suggestions.",
  done: (label: string) => `Erased the values of ‘${label}’.`,
  failed: "The erase stopped part way. Its values are still marked for erasing: type its name and press Try again to carry on from where it stopped.",
  countFailed: "The count stopped part way. Press Count again to start it over.",
  stopped: "The erase stopped because the field is in use again. Nothing more was erased.",
  countAgain: "Count again",
  tryAgain: "Try again",
  /** Data model's line under the archived list once a field there says its values were erased or are being erased. */
  keptUnless: (each: string) => `Hidden and read only. Unless it says otherwise, a field's values are kept on each ${each}, and it can be brought back.`,
  /** History's button when an entry archived more than one field that can be erased. */
  actionOf: (label: string) => `Erase values of ‘${label}’`,
} as const;

/** What an erase route answers, in words. */
export const ERASE_MESSAGES = {
  not_owner: "Only an owner of your organisation can erase values.",
  home_only: "Erasing needs you on this brand's team as an admin. Whoever runs your copy of YouGrow can add you.",
  not_admin: "Erasing needs you on this brand's team as an admin.",
  too_soon: "Its values can be erased 30 days after it was archived.",
  already_erased: "Its values were erased already.",
  legal_hold: "A legal hold covers this field, so its values can't be erased.",
  name_mismatch: "Type the field's name exactly as it is shown.",
  count_first: "Count what holds it first: the count is out of date.",
  audit_unavailable: "Nothing was erased: the audit trail couldn't be written. Try again in a few minutes.",
  fields_changed: "Someone changed the fields meanwhile. Close this and try again.",
  failed: "That didn't start. Try again.",
} as const;

export function eraseErrorText(data: unknown): string {
  const d = (data ?? {}) as { error?: string };
  return (d.error && (ERASE_MESSAGES as Record<string, string>)[d.error]) || ERASE_MESSAGES.failed;
}
