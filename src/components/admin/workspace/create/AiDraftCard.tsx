"use client";

import { useEffect, useRef, useState } from "react";
import type { AiOriginalView, DraftSectionView } from "@/lib/content/create/aiOriginalView";
import type { EditMeasures, OriginalBy } from "@/lib/types/aiOriginal";

/**
 * The AI draft of a piece (CONTENT_AI_ORIGINALS_ENABLED): who wrote it and when, how a person
 * changed it before approving it, and Compare, section by section. On an article it is a card in
 * the hub panel; on a post, one line in the inspector. /help/write-and-schedule#ai-draft explains it.
 */

export const AI_DRAFT_NOTE = "YouGrow keeps the copy as it was written, so it can learn from how your team edits it.";
export const AI_DRAFT_NONE = "No AI draft kept for this piece yet. YouGrow keeps one from the next time it is written.";

const BY: Record<OriginalBy, string> = { person: "Written on the canvas", autopilot: "Written by the autopilot", vizzy: "Written by Vizzy in a chat" };

const day = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("en-GB", { day: "numeric", month: "short" });
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pct = (share: number) => `${Math.round(share * 100)}%`;

/** "23% of words changed · 1 section added, 1 cut · 2 figures changed · 1 link added". */
export function measuresLine(m: EditMeasures): string {
  if (m.approvedAsWritten) return "no words changed";
  const parts = [`${pct(m.wordsChangedShare)} of words changed`];
  const added = m.sectionsAdded.length;
  const cut = m.sectionsCut.length;
  if (added && cut) parts.push(`${plural(added, "section")} added, ${cut} cut`);
  else if (added) parts.push(`${plural(added, "section")} added`);
  else if (cut) parts.push(`${plural(cut, "section")} cut`);
  const figures = m.figuresAdded.length + m.figuresRemoved.length;
  if (figures) parts.push(`${plural(figures, "figure")} changed`);
  if (m.linksAdded.length) parts.push(`${plural(m.linksAdded.length, "link")} added`);
  if (m.linksCut.length) parts.push(`${plural(m.linksCut.length, "link")} cut`);
  return parts.join(" · ");
}

function sectionLabel(s: DraftSectionView): string {
  if (s.state === "added") return "added by you";
  if (s.state === "cut") return "cut";
  if (s.state === "same") return "the same";
  return `${plural(s.wordsChanged, "word")} changed`;
}

function Segments({ section }: { section: DraftSectionView }) {
  return (
    <p className="whitespace-pre-wrap rounded bg-neutral-50 p-2 leading-5 text-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
      {section.segments.map((s, i) =>
        s.op === "del" ? (
          <del key={i} className="bg-red-100 text-red-900 dark:bg-red-950/60 dark:text-red-200">
            {s.text}
          </del>
        ) : s.op === "ins" ? (
          <ins key={i} className="bg-green-100 text-green-900 no-underline dark:bg-green-950/60 dark:text-green-200">
            {s.text}
          </ins>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </p>
  );
}

export function AiDraftCard({
  read,
  stamp,
  compact = false,
}: {
  /** Reads the piece's AI original; null when it can't be read. */
  read: () => Promise<AiOriginalView | null | undefined>;
  /** Changes when the copy changes underneath, so the card reads again. */
  stamp: string;
  /** One line, for a post in the inspector. */
  compact?: boolean;
}) {
  const [view, setView] = useState<AiOriginalView | null | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState<number | null>(null);
  const latest = useRef(read);
  latest.current = read;

  useEffect(() => {
    let gone = false;
    void latest.current().then((v) => {
      if (!gone) setView(v);
    });
    return () => {
      gone = true;
    };
  }, [stamp]);

  // Still reading, or it couldn't be read: show nothing rather than a wrong line.
  if (view === undefined) return null;
  if (view === null) return compact ? null : <p className="text-xs text-neutral-500 dark:text-neutral-400">{AI_DRAFT_NONE}</p>;

  const approval = view.approval;
  const said = approval
    ? `${approval.trigger === "live" ? "Found live" : "Approved"} ${day(approval.at)} with ${measuresLine(approval.measures)}`
    : view.now.approvedAsWritten
      ? "Not changed yet"
      : `So far: ${measuresLine(view.now)}`;
  const changedSince = approval && view.now.wordsChanged !== approval.measures.wordsChanged;
  const compare = (
    <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="font-medium text-blue-700 hover:underline dark:text-blue-400">
      {open ? "Hide" : "Compare"}
    </button>
  );

  if (compact) {
    return (
      <div className="text-xs">
        <p className="text-neutral-500 dark:text-neutral-400">
          {approval ? said : `AI draft, ${day(view.at)}: ${view.now.approvedAsWritten ? "not changed yet" : measuresLine(view.now)}`}
          {view.now.approvedAsWritten ? null : <> · {compare}</>}
        </p>
        {open && view.sections[0] ? <div className="mt-1.5">{<Segments section={view.sections[0]} />}</div> : null}
      </div>
    );
  }

  return (
    <section id="ai-draft" aria-labelledby="ai-draft-h" className="space-y-2 rounded-md border border-neutral-200 p-3 text-xs dark:border-neutral-800">
      <h3 id="ai-draft-h" className="text-xs font-semibold">
        AI draft
      </h3>
      <p className="text-neutral-700 dark:text-neutral-300">
        {BY[view.by]}, {day(view.at)}
        {view.regenerations ? ` · written ${view.regenerations === 1 ? "once more" : `${view.regenerations} more times`}` : ""}
      </p>
      <p className="text-neutral-700 dark:text-neutral-300">
        {said}
        {view.now.approvedAsWritten ? null : <> · {compare}</>}
      </p>
      {changedSince ? <p className="text-neutral-500 dark:text-neutral-400">Changed again since: {measuresLine(view.now)}</p> : null}
      {open ? (
        <ul className="space-y-1">
          {view.sections.map((s, i) => (
            <li key={i} className="space-y-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-neutral-700 dark:text-neutral-300">{s.heading || "Opening"}</span>
                {s.state === "same" ? (
                  <span className="text-neutral-500 dark:text-neutral-400">{sectionLabel(s)}</span>
                ) : (
                  <button type="button" aria-expanded={shown === i} onClick={() => setShown(shown === i ? null : i)} className="text-blue-700 hover:underline dark:text-blue-400">
                    {sectionLabel(s)}
                  </button>
                )}
              </div>
              {shown === i ? <Segments section={s} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-neutral-500 dark:text-neutral-400">{AI_DRAFT_NOTE}</p>
    </section>
  );
}
