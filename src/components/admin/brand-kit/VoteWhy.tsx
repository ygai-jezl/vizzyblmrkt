"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { VOTE_NOTE_CHARS, VOTE_REASONS } from "@/lib/loops/reasons";
import { WHY_WORDS, noteCount, reasonDoneLine, reasonLabelOf } from "@/lib/loops/learnedWords";
import { NOTE_REFUSED_MESSAGE } from "@/lib/loops/textCheck";
import { giveReason } from "./learnedClient";

/**
 * The why behind a vote (learning loops step 4, 3.11), under an image's thumbs in Create's post
 * image panel and in the image details. The vote has saved already; this row only adds its reason
 * and an optional note.
 * - After a thumbs down, "What's off?" opens by itself, once for an image, unless most recent thumbs
 *   down came with no reason (`startClosed`): then it waits as "Say what's off".
 * - After a thumbs up it never opens by itself: "Say what works" opens it, so liking stays one tap.
 * - A chip saves its reason at once; Done saves the note, refused with "Leave out links, email
 *   addresses, handles and phone numbers." and the box kept open when it has one.
 * - A click elsewhere closes the row; the reason stays. Changing the vote clears both on the server,
 *   so the parent remounts this row with the new vote (key).
 */

export type WhyDirection = "up" | "down";

/** What the row shows, from its state alone (tested in VoteWhy.test.ts). */
export function whyShows(s: { vote: WhyDirection | null; open: boolean; reason: string | null; done: boolean }): { link: boolean; row: boolean; saved: boolean; done: boolean } {
  const voted = s.vote !== null;
  return {
    link: voted && !s.open && !s.done && !s.reason,
    row: voted && s.open && !s.done,
    saved: voted && Boolean(s.reason) && !s.open && !s.done,
    done: voted && s.done,
  };
}

/**
 * Whether the row opens by itself: a thumbs down just given on an image not asked about before (it
 * never nags twice for one image), with no reason yet, and the brand usually gives one.
 */
export const opensByItself = (input: { vote: WhyDirection | null; justVoted: boolean; startClosed: boolean; hadReason: boolean; asked?: boolean }): boolean =>
  input.vote === "down" && input.justVoted && !input.startClosed && !input.hadReason && !input.asked;

/** The images the row has opened by itself for, on this page. */
const ASKED = new Set<string>();

export function VoteWhy({
  assetId,
  vote,
  reason: savedReason,
  note: savedNote,
  scope,
  startClosed,
  justVoted,
}: {
  assetId: string;
  vote: WhyDirection | null;
  reason: string | null;
  note: string | null;
  /** The look the vote teaches, for the done line. */
  scope: string | null;
  startClosed: boolean;
  /** The vote was given just now, in this panel. */
  justVoted: boolean;
}) {
  const [open, setOpen] = useState(() => {
    const opens = opensByItself({ vote, justVoted, startClosed, hadReason: Boolean(savedReason), asked: ASKED.has(assetId) });
    if (opens) ASKED.add(assetId);
    return opens;
  });
  const [reason, setReason] = useState<string | null>(savedReason);
  const [note, setNote] = useState(savedNote ?? "");
  // The note as the server keeps it: a chip saves its reason alone, Done saves the note.
  const [kept, setKept] = useState(savedNote ?? "");
  const [done, setDone] = useState(false);
  const [refused, setRefused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // A click elsewhere closes the row; nothing is lost, as a reason saves on its tap.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  if (!vote) return null;
  const words = WHY_WORDS[vote];
  const list = VOTE_REASONS.image[vote];
  const shows = whyShows({ vote, open, reason, done });

  async function pick(key: string) {
    const next = key === reason ? null : key;
    setBusy(true);
    setError(null);
    setRefused(false);
    const r = await giveReason(assetId, next, null);
    setBusy(false);
    if (!r.ok) {
      setError(r.data.message ?? "Couldn't save the reason. Try again.");
      return;
    }
    setReason(next);
    setKept("");
    if (!next) setNote("");
  }

  async function finish() {
    if (!reason) return;
    setBusy(true);
    setError(null);
    const r = await giveReason(assetId, reason, note.trim() ? note.trim() : null);
    setBusy(false);
    if (r.status === 400 && r.data.error === "note_refused") {
      setRefused(true);
      return;
    }
    if (!r.ok) {
      setError(r.data.message ?? "Couldn't save the note. Try again.");
      return;
    }
    setRefused(false);
    setKept(note.trim());
    setDone(true);
    setOpen(false);
  }

  const id = `why-${assetId}`;
  return (
    <div ref={ref} className="mt-2 space-y-2 text-xs">
      {shows.link ? (
        <button type="button" aria-expanded="false" aria-controls={id} onClick={() => setOpen(true)} className="text-neutral-600 underline underline-offset-2 hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-white">
          {words.link}
        </button>
      ) : null}
      {shows.row ? (
        <div id={id} role="group" aria-label={words.title} className="space-y-2 rounded-md border border-neutral-200 p-2 dark:border-neutral-800">
          <p className="font-medium text-neutral-800 dark:text-neutral-100">{words.title}</p>
          <div className="flex flex-wrap gap-1.5">
            {list.map((r) => (
              <button
                key={r.key}
                type="button"
                aria-pressed={r.key === reason}
                disabled={busy}
                onClick={() => void pick(r.key)}
                className={`rounded-full border px-2.5 py-1 disabled:opacity-60 ${
                  r.key === reason ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900" : "border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
          {reason ? (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-neutral-600 dark:text-neutral-300">
                <label htmlFor={`${id}-note`}>{WHY_WORDS.noteLabel}</label>
                <span className="tabular-nums">{noteCount(note.length, VOTE_NOTE_CHARS)}</span>
              </div>
              <textarea
                id={`${id}-note`}
                rows={2}
                maxLength={VOTE_NOTE_CHARS}
                value={note}
                onChange={(e) => {
                  setNote(e.target.value.slice(0, VOTE_NOTE_CHARS));
                  setRefused(false);
                }}
                className="w-full rounded-md border border-neutral-300 px-2 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
              />
              {refused ? (
                <p role="alert" className="flex items-start gap-1.5 text-red-700 dark:text-red-300">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
                  <span>{NOTE_REFUSED_MESSAGE}</span>
                </p>
              ) : null}
              <div className="flex justify-end">
                <button type="button" disabled={busy} onClick={() => void finish()} className="rounded-md border border-neutral-300 px-3 py-1 font-medium hover:bg-neutral-50 disabled:opacity-60 dark:border-neutral-700 dark:hover:bg-neutral-900">
                  {WHY_WORDS.done}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
      {shows.done ? (
        <p role="status" className="text-neutral-600 dark:text-neutral-300">
          {reasonDoneLine(scope)}
        </p>
      ) : null}
      {shows.saved ? (
        <div className="space-y-0.5 text-neutral-600 dark:text-neutral-300">
          <p>
            {words.saved}{" "}
            <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-100">{reasonLabelOf(vote, reason)}</span>
          </p>
          {kept ? <p>Note: {kept}</p> : null}
        </div>
      ) : null}
      {error ? <p className="text-red-700 dark:text-red-300">{error}</p> : null}
    </div>
  );
}
