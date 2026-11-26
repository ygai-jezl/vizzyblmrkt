import type { HistoryKind } from "@/lib/settings/sources";

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
  live: "Live",
  older: "Show older changes",
  draftNote: (version: number, by: string, when: string) => `The draft holds version ${version}, put back by ${by} ${when}. Nothing goes live until someone presses Publish.`,
} as const;

/** What a restore answers when someone saved in between, by kind. The preview opens again on Look again. */
export const RESTORE_MESSAGES = {
  fields_changed: "Someone changed the fields since you opened this. Look again.",
  draft_changed: "The draft changed since you opened this. Look again.",
  catalog_changed: "Someone changed the catalog since you opened this. Look again.",
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
