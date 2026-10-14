"use client";

import { useState } from "react";
import { ADDRESS_PROBLEM, articleAddressProblem, type AddressSaved } from "@/lib/content/blog/address";

const LABEL = "text-xs font-medium text-neutral-600 dark:text-neutral-300";
const HINT = "text-[11px] text-neutral-500 dark:text-neutral-400";
const INPUT =
  "min-w-[12rem] flex-1 rounded-md border border-neutral-300 px-2 py-1.5 text-xs disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900";
const SMALL_BUTTON =
  "rounded border border-neutral-300 px-2 py-1 text-[11px] hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";

/**
 * The article's address: where it lives, or will. Set once it is known, after the plan was
 * made; the markup, the checklist and the brand map read it. Saved on its own.
 */
export function BlogAddress({ pageUrl, onSave }: { pageUrl: string | null; onSave: (url: string | null) => Promise<AddressSaved> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(pageUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = editing || !pageUrl;

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
            disabled={busy}
            className={INPUT}
          />
          <button type="button" onClick={() => void save()} disabled={busy || (!draft.trim() && !pageUrl)} className={SMALL_BUTTON}>
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
            <a href={pageUrl} target="_blank" rel="noopener noreferrer" title={pageUrl} className="min-w-0 flex-1 truncate text-xs text-blue-600 hover:underline dark:text-blue-400">
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
            className={SMALL_BUTTON}
          >
            Change
          </button>
        </div>
      )}
      {error ? (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : open ? (
        <p className={HINT}>Where the article lives, or will. Its markup and your brand map use it.</p>
      ) : null}
    </div>
  );
}
