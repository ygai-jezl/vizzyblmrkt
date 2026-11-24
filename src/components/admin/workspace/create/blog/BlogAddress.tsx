"use client";

import { useState } from "react";
import type { BlogArticleLive } from "@/lib/types/contentPlan";
import { ADDRESS_PROBLEM, articleAddressProblem, type AddressSaved } from "@/lib/content/blog/address";
import { normalizeUrl } from "@/lib/content/blog/brief";
import type { LiveAction, LiveCheck } from "@/lib/content/blog/live";
import type { LiveResult } from "./types";
import { isBlogDatesUiEnabled } from "@/lib/brandMap/flags";

const LABEL = "text-xs font-medium text-neutral-600 dark:text-neutral-300";
const HINT = "text-[11px] text-neutral-500 dark:text-neutral-400";
const ERROR = "text-xs text-red-600 dark:text-red-400";
const INPUT =
  "min-w-[12rem] flex-1 rounded-md border border-neutral-300 px-2 py-1.5 text-xs disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900";
const SMALL_BUTTON =
  "rounded border border-neutral-300 px-2 py-1 text-[11px] hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";

/** "15 Oct 2026" */
function day(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** "96%" */
const percent = (share: number) => `${Math.round(share * 100)}%`;

/** What a check found, in a line. With Found live it reads the page's text, and says how much of the article it found. */
function checkSaid(c: LiveCheck): string {
  if (c.textShare !== undefined) {
    if (c.matched) return `Live: ${percent(c.textShare)} of the article's text is on the page.`;
    if (c.reachable && !c.refused) return `The page answers, but it isn't this article yet: ${percent(c.textShare)} of its text is there. If it's the right page, say so.`;
  }
  if (c.matched) return "Live: the page's title is the article's.";
  if (c.refused) return "Your site turned the check away. If the article is up, say so.";
  if (c.reachable) return `The page answers, but its title isn't the article's${c.title ? ` (“${c.title}”)` : ""}. If it's the right page, say so.`;
  return "Couldn't open the page. Check the address, or try again once it's published.";
}

/** "Live · found on your site 21 Nov 2026 · 96% of the text matches · approved" */
function liveLine(live: BlogArticleLive): string {
  const when =
    live.by !== "check"
      ? `you said so ${day(live.at)}`
      : live.found === "sitemap"
        ? `found on your site ${day(live.at)}`
        : live.auto
          ? `found at this address ${day(live.at)}`
          : `checked ${day(live.checkedAt ?? live.at)}`;
  const share = live.textShare !== undefined ? ` · ${percent(live.textShare)} of the text matches` : "";
  return `Live · ${when}${share}${live.approvedOnLive ? " · approved" : ""}`;
}

const LIVE_ERROR: Record<string, string> = {
  rate_limited: "Too many checks just now. Try again in a few minutes.",
  no_address: "Give the article its own address first: a full https:// link that isn't the home page.",
  invalid_day: "Give the day it went up: today or earlier.",
};

/** Today in the browser's own zone, as YYYY-MM-DD (the date field's default and its latest day). */
function todayHere(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Is it live at this address? A check, or a person's word for it. */
function LiveRow({
  live,
  onLive,
  disabled,
}: {
  live: BlogArticleLive | null;
  onLive: (action: LiveAction, day?: string) => Promise<LiveResult>;
  disabled: boolean;
}) {
  const [busy, setBusy] = useState<LiveAction | null>(null);
  const [said, setSaid] = useState<{ text: string; error: boolean } | null>(null);
  // True dates (BLOG_DATES_ENABLED): "It's live" says the day it went up.
  const dated = isBlogDatesUiEnabled();
  const [day, setDay] = useState(todayHere);

  async function run(action: LiveAction) {
    setBusy(action);
    setSaid(null);
    const r = await onLive(action, dated && action === "mark" ? day : undefined).catch((): LiveResult => ({ ok: false, error: "failed" }));
    setBusy(null);
    if (!r.ok) setSaid({ text: LIVE_ERROR[r.error] ?? "That didn't work. Try again.", error: true });
    else if (r.check) setSaid({ text: checkSaid(r.check), error: false });
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-xs">
          {live ? (
            <>
              <span aria-hidden className="text-green-600 dark:text-green-400">● </span>
              {liveLine(live)}
            </>
          ) : (
            <>
              <span aria-hidden className="text-neutral-400">○ </span>
              Not seen live yet
            </>
          )}
        </span>
        <button type="button" onClick={() => void run("check")} disabled={disabled || busy !== null} className={SMALL_BUTTON}>
          {busy === "check" ? "Checking…" : live ? "Check again" : "Check it's live"}
        </button>
        {live ? (
          <button type="button" onClick={() => void run("clear")} disabled={disabled || busy !== null} className={SMALL_BUTTON}>
            Not live
          </button>
        ) : (
          <>
            {dated ? (
              <label className="text-xs text-neutral-500 dark:text-neutral-400">
                <span className="sr-only">Day it went up</span>
                <input
                  id="live-day"
                  type="date"
                  value={day}
                  max={todayHere()}
                  onChange={(e) => setDay(e.target.value)}
                  disabled={disabled || busy !== null}
                  className="rounded-md border border-neutral-300 px-1.5 py-0.5 text-xs dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
            ) : null}
            <button type="button" onClick={() => void run("mark")} disabled={disabled || busy !== null} title="For a site that turns the check away" className={SMALL_BUTTON}>
              It&apos;s live
            </button>
          </>
        )}
      </div>
      {said ? (
        <p role={said.error ? "alert" : "status"} className={said.error ? ERROR : HINT}>
          {said.text}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The article's address: where it lives, or will. Set once it is known, after the plan was
 * made; the markup, the checklist and the brand map read it. Saved on its own. With an
 * address, whether the article is live there.
 */
export function BlogAddress({
  pageUrl,
  onSave,
  live = null,
  onLive,
  disabled = false,
  liveWatch = false,
}: {
  pageUrl: string | null;
  onSave: (url: string | null) => Promise<AddressSaved>;
  /** The hub's live mark, if any. It counts only at the address it was made for. */
  live?: BlogArticleLive | null;
  onLive?: (action: LiveAction, day?: string) => Promise<LiveResult>;
  /** Something else is running on the article. */
  disabled?: boolean;
  /** Found live (BLOG_LIVE_WATCH_ENABLED): YouGrow checks the address on its own, or finds the article on the sitemap. */
  liveWatch?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(pageUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = editing || !pageUrl;
  const liveHere = live && pageUrl && normalizeUrl(live.url) === normalizeUrl(pageUrl) ? live : null;

  async function save() {
    const url = draft.trim();
    const problem = url ? articleAddressProblem(url) : null;
    if (problem) {
      setError(ADDRESS_PROBLEM[problem]);
      return;
    }
    if ((url || null) === pageUrl) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError(null);
    const saved = await onSave(url || null).catch((): AddressSaved => "failed");
    setBusy(false);
    if (saved === "saved") setEditing(false);
    else setError(saved === "failed" ? "Couldn't save the address. Try again." : ADDRESS_PROBLEM[saved]);
  }

  return (
    <div className="space-y-1">
      <div className={LABEL}>Article address</div>
      {open ? (
        <div className="flex flex-wrap gap-2">
          <input
            aria-label="Article address"
            type="url"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
              e.preventDefault();
              void save();
            }}
            maxLength={2000}
            placeholder="https://example.com/blog/your-article"
            disabled={busy || disabled}
            className={INPUT}
          />
          <button type="button" onClick={() => void save()} disabled={busy || disabled || (!draft.trim() && !pageUrl)} className={SMALL_BUTTON}>
            {busy ? "Saving…" : "Save"}
          </button>
          {pageUrl ? (
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setDraft(pageUrl);
                setError(null);
              }}
              disabled={busy}
              className={SMALL_BUTTON}
            >
              Cancel
            </button>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {/^https:\/\//i.test(pageUrl) ? (
            <a
              href={pageUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={pageUrl}
              className="min-w-0 flex-1 truncate text-xs text-blue-600 hover:underline dark:text-blue-400"
            >
              {pageUrl}
            </a>
          ) : (
            <span title={pageUrl} className="min-w-0 flex-1 truncate text-xs text-neutral-600 dark:text-neutral-300">
              {pageUrl}
            </span>
          )}
          <button
            type="button"
            onClick={() => {
              setDraft(pageUrl);
              setEditing(true);
            }}
            disabled={disabled}
            className={SMALL_BUTTON}
          >
            Change
          </button>
        </div>
      )}
      {error ? (
        <p role="alert" className={ERROR}>
          {error}
        </p>
      ) : open ? (
        <p className={HINT}>
          Where the article lives, or will. Its markup and your brand map use it.
          {liveWatch ? " YouGrow checks it for you every few hours for two weeks. Leave it empty and YouGrow finds the article on your site's sitemap." : null}
        </p>
      ) : null}
      {!open && onLive ? <LiveRow live={liveHere} onLive={onLive} disabled={disabled} /> : null}
    </div>
  );
}
