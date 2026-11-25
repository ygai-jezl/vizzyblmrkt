"use client";

import { useEffect, useRef, useState } from "react";
import { Check, FileText, Loader2, MessageCircle, Mic } from "lucide-react";
import {
  confirmBody,
  initialAnswers,
  learnedSource,
  removeFact,
  removedNote,
  undoRemove,
  unclearWords,
} from "@/lib/onboarding/learnedReview";
import { LEARNED_WORDS } from "@/lib/onboarding/words";
import type { ProfileAnswers, ProfileKey } from "@/lib/types/businessProfile";
import type { ConversationSource, LearnedAnswer, LearnedFact } from "@/lib/types/onboarding";
import { useOnboarding } from "./OnboardingFrame";
import { BasicsGrid, FactList, TranscriptDialog } from "./parts";

export interface LearnedReviewProps {
  conversation: { id: string; source: ConversationSource; startedAt: string; lengthSec: number; turnCount: number };
  learned: { answers: Record<ProfileKey, LearnedAnswer>; facts: LearnedFact[] };
}

type Saving = "idle" | "saving" | "failed";

const SECTION_HEAD = "flex items-baseline gap-2 text-[11px] font-semibold uppercase leading-4 tracking-[0.05em] text-shell-muted";

/**
 * /admin/welcome/learned: the four answers Vizzy took from the call, then what else it heard,
 * each with the member's own words. Changes and removals stay on this page (Remove has Undo)
 * until "Looks right" sends them once; then Home. "Read the transcript" opens the words here, so
 * nothing unsaved is lost.
 */
export function LearnedReview({ conversation, learned }: LearnedReviewProps) {
  const { answers: saved } = useOnboarding();
  const [answers, setAnswers] = useState<ProfileAnswers>(() => initialAnswers(learned.answers, saved));
  const [removed, setRemoved] = useState<string[]>([]);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState<Saving>("idle");
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus();
  }, []);

  const words = unclearWords(learned.answers);
  const facts = learned.facts.filter((f) => !removed.includes(f.id));
  const note = removedNote(learned.facts, removed);
  const chat = conversation.source === "chat";
  const SourceIcon = chat ? MessageCircle : Mic;

  const looksRight = async () => {
    if (saving === "saving") return;
    setSaving("saving");
    try {
      const res = await fetch(`/api/admin/onboarding/conversations/${encodeURIComponent(conversation.id)}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(confirmBody(answers, learned.facts, removed)),
      });
      if (!res.ok) throw new Error(String(res.status));
      // A whole page load, so Home and the sidebar read the brand's new profile.
      window.location.assign("/admin");
    } catch {
      setSaving("failed");
    }
  };

  return (
    <div className="w-full max-w-[760px]">
      <p className="inline-flex items-center gap-1.5 rounded-full bg-shell-accent-soft px-2.5 py-1 text-xs font-medium text-shell-accent">
        <SourceIcon size={14} aria-hidden />
        {learnedSource(conversation)}
      </p>
      <h1 ref={heading} tabIndex={-1} className="mt-3.5 text-[32px] font-semibold leading-10 tracking-[-0.02em] outline-none">
        {LEARNED_WORDS.title}
      </h1>
      <p className="mt-1.5 text-[15px] leading-[22px] text-shell-muted">{LEARNED_WORDS.lead}</p>

      <section aria-labelledby="lr-basics" className="mt-8">
        <h2 id="lr-basics" className={SECTION_HEAD}>
          {LEARNED_WORDS.basics}
        </h2>
        <BasicsGrid answers={answers} blank="unsure" words={words} onPick={(key, value) => setAnswers((a) => ({ ...a, [key]: value }))} />
      </section>

      <section aria-labelledby="lr-facts" className="mt-8">
        <h2 id="lr-facts" className={SECTION_HEAD}>
          {LEARNED_WORDS.heard} <span className="font-medium text-shell-faint">{facts.length}</span>
        </h2>
        {facts.length ? (
          <FactList facts={facts} onRemove={(id) => setRemoved((r) => removeFact(r, id))} />
        ) : (
          <p className="mt-2.5 rounded-xl border border-dashed border-shell-line px-4 py-5 text-center text-sm text-shell-faint">{LEARNED_WORDS.nothing}</p>
        )}
        {note ? (
          <p role="status" className="mt-2 flex items-center justify-between gap-3 rounded-lg bg-shell-active px-3 py-2 text-[13px] leading-[18px] text-shell-muted">
            <span className="min-w-0">{note}</span>
            <button type="button" onClick={() => setRemoved((r) => undoRemove(r))} className="shrink-0 font-medium text-shell-accent hover:underline">
              {LEARNED_WORDS.undo}
            </button>
          </p>
        ) : null}
      </section>

      <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3">
        <button
          type="button"
          onClick={() => void looksRight()}
          disabled={saving === "saving"}
          aria-busy={saving === "saving" || undefined}
          className="inline-flex items-center gap-2 rounded-xl bg-shell-ink px-[22px] py-3 text-[15px] font-semibold leading-[22px] text-shell-side shadow-lg hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-shell-accent disabled:opacity-70"
        >
          {saving === "saving" ? <Loader2 size={18} aria-hidden className="animate-spin" /> : <Check size={18} aria-hidden />}
          {LEARNED_WORDS.looksRight}
        </button>
        <button
          type="button"
          onClick={() => setReading(true)}
          aria-haspopup="dialog"
          className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm text-shell-muted hover:bg-shell-hover hover:text-shell-ink"
        >
          <FileText size={16} aria-hidden />
          {chat ? LEARNED_WORDS.readChat : LEARNED_WORDS.readTranscript}
        </button>
      </div>
      {saving === "failed" ? (
        <p role="alert" className="mt-4 text-sm text-shell-ink">
          {LEARNED_WORDS.notSaved}
        </p>
      ) : null}

      <TranscriptDialog open={reading} onClose={() => setReading(false)} conversation={conversation} />
    </div>
  );
}
