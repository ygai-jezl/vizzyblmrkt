"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ClipboardPaste, MessageCircle, RefreshCw, X } from "lucide-react";
import { useShell } from "@/components/admin/nav/ShellProvider";
import {
  BRAND_NOTE_KINDS,
  BRAND_NOTE_KIND_LABEL,
  BRAND_NOTE_LIMITS,
  type BrandNote,
  type BrandNoteKind,
  type BrandNoteSource,
  type NoteArticle,
  type NotesRest,
  NOTES_REST_LIMITS,
} from "@/lib/types/brandNote";
import { noteRest, restDate, usesOf, type NoteRestState } from "@/lib/brandNotes/rest";
import { createAnswerQueue, type AnswerSave } from "@/lib/brandNotes/answerQueue";
import { summariseNotes } from "@/lib/brandNotes/summary";
import { KIND_QUESTIONS, noteQuestion, suggestKind, suggestSubjects } from "@/lib/brandNotes/prompts";
import type { NoteSubject } from "@/lib/brandNotes/subjects";
import type { FoundNote } from "@/lib/brandNotes/extract";

/**
 * Brand › What we've seen: add a note (prompted by a question aimed at what the brand has least
 * of), the notes themselves, and two panels that push for a rich and varied set: the mix of
 * kinds, and which brand map subjects nothing covers yet. Members see it all; admins change it.
 * With open questions (BRAND_NOTES_QUESTIONS_ENABLED), the questions articles asked the team are
 * listed apart, each with the articles that asked it and a box that saves its answer as it is typed.
 * With notes resting (BRAND_NOTES_REST_ENABLED), each note says where and when it was used and
 * whether it rests, and admins set how long a note rests and after how many articles.
 */

const CARD = "rounded-lg border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-950";
const LABEL = "block text-xs font-medium text-neutral-600 dark:text-neutral-300";
const HINT = "text-xs text-neutral-500 dark:text-neutral-400";
const FIELD =
  "w-full rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900";
const PRIMARY =
  "rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900";
const SECONDARY =
  "rounded-md border border-neutral-300 px-2.5 py-1 text-xs hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";
/** A number inside a sentence: sized to its digits, not the line. */
const NUMBER_FIELD =
  "rounded-md border border-neutral-300 px-2 py-1 text-sm tabular-nums disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900";
const CHIP = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs";
const SUBJECT_CHIP = `${CHIP} border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-200`;

const SOURCE_LABEL: Record<BrandNoteSource, string> = {
  typed: "Typed here",
  paste: "From a pasted call or document",
  article: "Written for an article",
  chat: "Suggested by Vizzy",
  question: "Answer to a question",
};

type Filter = "all" | "suggested" | "unused" | "open" | "ready" | "resting" | "used_up" | BrandNoteKind;
type Prefill = { nonce: number; kind?: BrandNoteKind; subjectId?: string };

async function send(url: string, method: string, body?: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { ok: res.ok, status: res.status, data: ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
  } catch {
    return { ok: false, status: 0, data: {} };
  }
}

function problem(status: number, data: Record<string, unknown>): string {
  if (status === 409 && data.error === "too_many_notes") {
    return `You have as many notes as a brand can hold (${BRAND_NOTE_LIMITS.MAX_NOTES.toLocaleString()}). Remove some first.`;
  }
  if (status === 403) return "Only an admin can change notes.";
  if (status === 400) return `The note couldn't be saved: write at least ${BRAND_NOTE_LIMITS.MIN_TEXT} characters and choose a kind.`;
  return "That didn't save. Check your connection and try again.";
}

/** What the button asks Vizzy (BRAND_NOTES_CHAT_ENABLED). */
const INTERVIEW =
  "Interview me for What we've seen: ask me one question at a time about something our team has seen, starting with the kinds of note we have least of, and file each answer as a suggested note in my words once I agree.";
/** The same, starting with the questions our articles asked (BRAND_NOTES_QUESTIONS_ENABLED). */
const INTERVIEW_OPEN =
  "Interview me for What we've seen: ask me one question at a time about something our team has seen, starting with our open questions and then the kinds of note we have least of, and file each answer as a suggested note in my words once I agree.";

export function BrandNotesPage({
  initialNotes,
  subjects,
  canEdit,
  chatOn = false,
  questionsOn = false,
  rest = null,
}: {
  initialNotes: BrandNote[];
  /** The decided subjects on the brand's saved map; null = no saved map (no coverage shown). */
  subjects: NoteSubject[] | null;
  canEdit: boolean;
  /** Vizzy can interview a person for notes (BRAND_NOTES_CHAT_ENABLED). */
  chatOn?: boolean;
  /** Open questions are listed and can be answered (BRAND_NOTES_QUESTIONS_ENABLED). */
  questionsOn?: boolean;
  /** Notes rest after use (BRAND_NOTES_REST_ENABLED): the brand's setting, and when the page was drawn. */
  rest?: { settings: NotesRest; now: string } | null;
}) {
  const shell = useShell();
  const [notes, setNotes] = useState(initialNotes);
  const [filter, setFilter] = useState<Filter>("all");
  const [prefill, setPrefill] = useState<Prefill>({ nonce: 0 });
  const addRef = useRef<HTMLElement>(null);
  const summary = useMemo(() => summariseNotes(notes), [notes]);
  const [restSettings, setRestSettings] = useState(rest?.settings ?? null);
  // Whether each kept note rests, as of when the page was drawn (the same on the server and in the browser).
  const restOf = useMemo(() => {
    const out = new Map<string, NoteRestState>();
    if (!rest || !restSettings) return out;
    const now = new Date(rest.now);
    for (const n of notes) if (n.status === "kept") out.set(n.id, noteRest(n, restSettings, now));
    return out;
  }, [notes, rest, restSettings]);
  const restCounts = useMemo(() => {
    const c = { ready: 0, resting: 0, used_up: 0 };
    for (const r of restOf.values()) c[r.reason === "used_up" ? "used_up" : r.reason ? "resting" : "ready"] += 1;
    return c;
  }, [restOf]);
  const names = useMemo(() => new Map((subjects ?? []).map((s) => [s.id, s.name])), [subjects]);
  const uncovered = useMemo(() => {
    const covered = new Set(summary.subjectIds);
    return (subjects ?? []).filter((s) => !covered.has(s.id));
  }, [subjects, summary.subjectIds]);

  const ask = (next: Omit<Prefill, "nonce">) => {
    setPrefill((p) => ({ nonce: p.nonce + 1, ...next }));
    addRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const replace = (note: BrandNote) => setNotes((list) => list.map((n) => (n.id === note.id ? note : n)));

  // Open questions aren't notes yet: they show only under their own filter.
  const shown = notes.filter((n) =>
    filter === "open"
      ? n.status === "asked"
      : n.status === "asked"
        ? false
        : filter === "all"
          ? true
          : filter === "suggested"
            ? n.status === "suggested"
            : filter === "unused"
              ? !n.usedBy?.length && !usesOf(n).length
              : filter === "ready" || filter === "resting" || filter === "used_up"
                ? restFilter(restOf.get(n.id)) === filter
                : n.kind === filter,
  );

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-5">
        {canEdit || (chatOn && shell) ? (
          <div className="flex flex-wrap justify-end gap-2">
            {canEdit ? <PasteNotes subjects={subjects} onAdded={(added) => setNotes((list) => [...added, ...list])} /> : null}
            {chatOn && shell ? (
              <button type="button" onClick={() => shell.ask(questionsOn && summary.asked ? INTERVIEW_OPEN : INTERVIEW)} className={`${SECONDARY} inline-flex items-center gap-1.5 bg-white py-1.5 text-sm dark:bg-neutral-950`}>
                <MessageCircle size={14} aria-hidden /> Let Vizzy interview me
              </button>
            ) : null}
          </div>
        ) : null}
        {rest && restSettings ? <RestSetting settings={restSettings} canEdit={canEdit} onSaved={setRestSettings} /> : null}
        {canEdit ? (
          <section ref={addRef} aria-label="Add a note" className={CARD}>
            <AddNote
              key={prefill.nonce}
              prefill={prefill}
              kinds={summary.kinds}
              uncovered={uncovered}
              subjects={subjects}
              onSaved={(note) => setNotes((list) => [note, ...list])}
            />
          </section>
        ) : (
          <p className={`${CARD} text-sm text-neutral-600 dark:text-neutral-300`}>Only an admin of this brand can add or change notes.</p>
        )}

        <section aria-label="Your notes" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">
              Your notes <span className="font-normal text-neutral-500 dark:text-neutral-400">{summary.total}</span>
            </h2>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Show">
              <FilterChip on={filter === "all"} onClick={() => setFilter("all")}>
                All
              </FilterChip>
              {summary.suggested ? (
                <FilterChip on={filter === "suggested"} onClick={() => setFilter("suggested")}>
                  Suggested · {summary.suggested}
                </FilterChip>
              ) : null}
              {questionsOn && summary.asked ? (
                <FilterChip on={filter === "open"} onClick={() => setFilter("open")}>
                  Open questions · {summary.asked}
                </FilterChip>
              ) : null}
              {rest ? (
                <>
                  <FilterChip on={filter === "ready"} onClick={() => setFilter("ready")}>
                    Ready · {restCounts.ready}
                  </FilterChip>
                  {restCounts.resting ? (
                    <FilterChip on={filter === "resting"} onClick={() => setFilter("resting")}>
                      Resting · {restCounts.resting}
                    </FilterChip>
                  ) : null}
                  {restCounts.used_up ? (
                    <FilterChip on={filter === "used_up"} onClick={() => setFilter("used_up")}>
                      Used up · {restCounts.used_up}
                    </FilterChip>
                  ) : null}
                </>
              ) : null}
              <FilterChip on={filter === "unused"} onClick={() => setFilter("unused")}>
                Not used yet
              </FilterChip>
              {BRAND_NOTE_KINDS.filter((k) => summary.kinds[k] > 0).map((k) => (
                <FilterChip key={k} on={filter === k} onClick={() => setFilter(k)}>
                  {BRAND_NOTE_KIND_LABEL[k].many} · {summary.kinds[k]}
                </FilterChip>
              ))}
            </div>
          </div>
          {shown.length === 0 ? (
            <p className={`${CARD} ${HINT}`}>
              {summary.total === 0 && filter !== "open"
                ? "No notes yet. Start with the question above: one story, test or mistake per note, in your own words."
                : "No notes match this filter."}
            </p>
          ) : (
            shown.map((n) =>
              n.status === "asked" ? (
                <OpenQuestionCard key={n.id} note={n} canEdit={canEdit} onChange={replace} onRemoved={(id) => setNotes((list) => list.filter((x) => x.id !== id))} />
              ) : (
                <NoteCard
                  key={n.id}
                  note={n}
                  names={names}
                  subjects={subjects}
                  canEdit={canEdit}
                  onChange={replace}
                  onRemoved={(id) => setNotes((list) => list.filter((x) => x.id !== id))}
                  {...(rest ? { rest: { state: restOf.get(n.id) ?? null, now: rest.now } } : {})}
                />
              ),
            )
          )}
        </section>
      </div>

      <aside className="space-y-5">
        {rest ? <RestPanel counts={restCounts} onShow={setFilter} /> : null}
        {questionsOn && summary.asked ? <OpenQuestionsPanel count={summary.asked} onShow={() => setFilter("open")} /> : null}
        <MixPanel kinds={summary.kinds} canEdit={canEdit} onAsk={(kind) => ask({ kind })} openQuestions={questionsOn && summary.asked > 0} />
        {subjects ? <CoveragePanel subjects={subjects} uncovered={uncovered} canEdit={canEdit} onAsk={(subjectId) => ask({ subjectId })} /> : null}
        <section aria-label="What makes a good note" className="rounded-lg bg-neutral-100 p-4 text-sm leading-relaxed dark:bg-neutral-900">
          <h2 className="text-sm font-semibold">What makes a good note</h2>
          <ul className="mt-2 space-y-1.5 text-neutral-700 dark:text-neutral-300">
            <li>Something you saw or did, not a general truth.</li>
            <li>One story, test or result per note.</li>
            <li>What surprised you, and what you did next.</li>
            <li>No names unless they agreed: articles keep people anonymous otherwise.</li>
          </ul>
        </section>
      </aside>
    </div>
  );
}

function FilterChip({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`${CHIP} ${on ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900" : "border-neutral-300 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"}`}
    >
      {children}
    </button>
  );
}

/** Choose the brand map subjects a note is about: the ones its words suggest, or any found by name. */
function SubjectPicker({
  text,
  chosen,
  onChange,
  subjects,
}: {
  text: string;
  chosen: string[];
  onChange: (ids: string[]) => void;
  subjects: NoteSubject[];
}) {
  const id = useId();
  const [find, setFind] = useState("");
  const name = (sid: string) => subjects.find((s) => s.id === sid)?.name ?? "No longer on your brand map";
  const suggested = suggestSubjects(text, subjects).filter((s) => !chosen.includes(s.id));
  const q = find.trim().toLowerCase();
  const found = q ? subjects.filter((s) => !chosen.includes(s.id) && s.name.toLowerCase().includes(q)).slice(0, 6) : [];
  const full = chosen.length >= BRAND_NOTE_LIMITS.MAX_SUBJECTS;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {chosen.map((sid) => (
          <span key={sid} className={SUBJECT_CHIP}>
            {name(sid)}
            <button type="button" aria-label={`Take off ${name(sid)}`} onClick={() => onChange(chosen.filter((x) => x !== sid))} className="rounded-full p-0.5 hover:bg-blue-100 dark:hover:bg-blue-900">
              <X size={12} aria-hidden />
            </button>
          </span>
        ))}
        {!full
          ? suggested.map((s) => (
              <button key={s.id} type="button" onClick={() => onChange([...chosen, s.id])} className={`${CHIP} border-dashed border-neutral-400 text-neutral-700 hover:bg-neutral-50 dark:text-neutral-300 dark:hover:bg-neutral-800`}>
                + {s.name}
              </button>
            ))
          : null}
      </div>
      {!full ? (
        <div className="relative max-w-xs">
          <label htmlFor={`${id}-find`} className="sr-only">
            Find a subject
          </label>
          <input id={`${id}-find`} value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a subject on your brand map" className={`${FIELD} text-xs`} />
          {found.length ? (
            <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-md border border-neutral-200 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-950">
              {found.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onChange([...chosen, s.id]);
                      setFind("");
                    }}
                    className="block w-full px-2.5 py-1.5 text-left text-xs hover:bg-neutral-50 dark:hover:bg-neutral-900"
                  >
                    {s.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function AddNote({
  prefill,
  kinds,
  uncovered,
  subjects,
  onSaved,
}: {
  prefill: Prefill;
  kinds: Record<BrandNoteKind, number>;
  uncovered: NoteSubject[];
  subjects: NoteSubject[] | null;
  onSaved: (note: BrandNote) => void;
}) {
  const id = useId();
  const [turn, setTurn] = useState(0);
  const [text, setText] = useState("");
  const [kind, setKind] = useState<BrandNoteKind | null>(prefill.kind ?? null);
  const [chosen, setChosen] = useState<string[]>(prefill.subjectId ? [prefill.subjectId] : []);
  const [canName, setCanName] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const prefilledSubject = prefill.subjectId ? subjects?.find((s) => s.id === prefill.subjectId)?.name : undefined;
  const question =
    turn === 0 && prefill.kind
      ? KIND_QUESTIONS[prefill.kind][0]!
      : turn === 0 && prefilledSubject
        ? `What have you seen first-hand about ${prefilledSubject}?`
        : noteQuestion(kinds, uncovered.map((s) => s.name), turn).question;
  const suggestedKind = suggestKind(text);
  const shownKind = kind ?? suggestedKind;
  const long = text.trim().length >= BRAND_NOTE_LIMITS.MIN_TEXT;

  async function save() {
    setBusy(true);
    setError(null);
    const r = await send("/api/admin/brand-kit/notes", "POST", { text: text.trim(), kind: shownKind, subjectIds: chosen, canName });
    setBusy(false);
    if (!r.ok || !r.data.note) {
      setError(problem(r.status, r.data));
      return;
    }
    onSaved(r.data.note as BrandNote);
    setText("");
    setKind(null);
    setChosen([]);
    setCanName(false);
    setSaved(true);
    setTurn((t) => t + 1);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Add a note</h2>
        <button type="button" onClick={() => setTurn((t) => t + 1)} className="inline-flex items-center gap-1.5 rounded px-1.5 py-1 text-xs text-blue-700 hover:bg-blue-50 dark:text-blue-300 dark:hover:bg-blue-950">
          <RefreshCw size={13} aria-hidden /> Another question
        </button>
      </div>
      <p className="rounded-md bg-neutral-100 px-3 py-2.5 text-sm text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100" aria-live="polite">
        {question}
      </p>
      <div>
        <label htmlFor={`${id}-text`} className={LABEL}>
          Your note
        </label>
        <textarea
          id={`${id}-text`}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSaved(false);
          }}
          rows={3}
          maxLength={BRAND_NOTE_LIMITS.MAX_TEXT}
          placeholder="What happened, to whom (no names needed), and what surprised you."
          className={`mt-1 ${FIELD} leading-relaxed`}
        />
      </div>
      <div className="flex flex-wrap items-start gap-4">
        <label className={LABEL}>
          Kind {kind ? null : <span className="font-normal text-neutral-500 dark:text-neutral-400">(suggested)</span>}
          <select value={shownKind} onChange={(e) => setKind(e.target.value as BrandNoteKind)} className={`mt-1 block ${FIELD} w-auto text-xs`}>
            {BRAND_NOTE_KINDS.map((k) => (
              <option key={k} value={k}>
                {BRAND_NOTE_KIND_LABEL[k].one}
              </option>
            ))}
          </select>
        </label>
        {subjects ? (
          <div className="min-w-0 flex-1">
            <div className={LABEL}>Subjects on your brand map</div>
            <div className="mt-1">
              <SubjectPicker text={text} chosen={chosen} onChange={setChosen} subjects={subjects} />
            </div>
          </div>
        ) : null}
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={canName} onChange={(e) => setCanName(e.target.checked)} className="mt-1" />
        <span>
          It names a customer or person who agreed to be named
          <span className={`block ${HINT}`}>Left unticked, articles keep people and companies anonymous.</span>
        </span>
      </label>
      <div className="flex items-center justify-end gap-3">
        <span role="status" className={error ? "text-xs text-red-600 dark:text-red-400" : HINT}>
          {error ?? (saved ? "Saved. Here's another question." : "")}
        </span>
        <button type="button" onClick={() => void save()} disabled={busy || !long} className={PRIMARY}>
          {busy ? "Saving…" : "Save note"}
        </button>
      </div>
    </div>
  );
}

function NoteCard({
  note,
  names,
  subjects,
  canEdit,
  onChange,
  onRemoved,
  rest,
}: {
  note: BrandNote;
  names: Map<string, string>;
  subjects: NoteSubject[] | null;
  canEdit: boolean;
  onChange: (note: BrandNote) => void;
  onRemoved: (id: string) => void;
  /** Notes rest after use: whether this one does (null for one not kept), and when the page was drawn. */
  rest?: { state: NoteRestState | null; now: string };
}) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.text);
  const [kind, setKind] = useState(note.kind);
  const [chosen, setChosen] = useState(note.subjectIds ?? []);
  const [canName, setCanName] = useState(note.canName);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const used = rest?.state ? rest.state.written : (note.usedBy?.length ?? 0);
  const last = rest?.state?.last ? ` · last on ${restDate(rest.state.last.at, rest.now)}` : "";

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const r = await send(`/api/admin/brand-kit/notes/${note.id}`, "PATCH", body);
    setBusy(false);
    if (!r.ok || !r.data.note) return setError(problem(r.status, r.data));
    onChange(r.data.note as BrandNote);
    setEditing(false);
  }

  async function remove() {
    setBusy(true);
    const r = await send(`/api/admin/brand-kit/notes/${note.id}`, "DELETE");
    setBusy(false);
    if (!r.ok) return setError(problem(r.status, r.data));
    onRemoved(note.id);
  }

  return (
    <article className={`${CARD} space-y-2.5 ${note.status === "suggested" ? "border-dashed" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-700 dark:text-neutral-300">
          {BRAND_NOTE_KIND_LABEL[note.kind].one}
          {note.status === "suggested" ? <span className="ml-2 font-medium normal-case tracking-normal text-amber-700 dark:text-amber-400">Suggested, not kept yet</span> : null}
          {rest?.state?.reason ? <RestPill state={rest.state} now={rest.now} /> : null}
        </span>
        <span className={HINT}>
          {SOURCE_LABEL[note.source]} · {used ? `used in ${used} article${used === 1 ? "" : "s"}${last}` : "not used yet"}
        </span>
      </div>
      {editing ? (
        <div className="space-y-2.5">
          <label htmlFor={`${id}-text`} className="sr-only">
            The note
          </label>
          <textarea id={`${id}-text`} value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={BRAND_NOTE_LIMITS.MAX_TEXT} className={`${FIELD} leading-relaxed`} />
          <div className="flex flex-wrap items-start gap-4">
            <label className={LABEL}>
              Kind
              <select value={kind} onChange={(e) => setKind(e.target.value as BrandNoteKind)} className={`mt-1 block ${FIELD} w-auto text-xs`}>
                {BRAND_NOTE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {BRAND_NOTE_KIND_LABEL[k].one}
                  </option>
                ))}
              </select>
            </label>
            {subjects ? (
              <div className="min-w-0 flex-1">
                <div className={LABEL}>Subjects</div>
                <div className="mt-1">
                  <SubjectPicker text={text} chosen={chosen} onChange={setChosen} subjects={subjects} />
                </div>
              </div>
            ) : null}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={canName} onChange={(e) => setCanName(e.target.checked)} />
            It names someone who agreed to be named
          </label>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setEditing(false)} className={SECONDARY}>
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || text.trim().length < BRAND_NOTE_LIMITS.MIN_TEXT}
              onClick={() => void patch({ text: text.trim(), kind, subjectIds: chosen, canName })}
              className={PRIMARY}
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      ) : (
        <>
          {note.question ? <p className={`${HINT} leading-relaxed`}>Asked: {note.question}</p> : null}
          <p className="whitespace-pre-line text-sm leading-relaxed">{note.text}</p>
          {note.askedFor?.length ? <AskedFor articles={note.askedFor} /> : null}
          {rest ? <WhereUsed note={note} state={rest.state} now={rest.now} /> : null}
          <div className="flex flex-wrap items-center gap-1.5">
            {(note.subjectIds ?? []).map((sid) => (
              <span key={sid} className={SUBJECT_CHIP}>
                {names.get(sid) ?? "No longer on your brand map"}
              </span>
            ))}
            {note.canName ? <span className={`${CHIP} border-neutral-300 text-neutral-600 dark:border-neutral-700 dark:text-neutral-300`}>Can be named</span> : null}
          </div>
          {canEdit ? (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {note.status === "suggested" ? (
                <button type="button" disabled={busy} onClick={() => void patch({ status: "kept" })} className={PRIMARY}>
                  Keep it
                </button>
              ) : null}
              <button type="button" onClick={() => setEditing(true)} className={SECONDARY}>
                Edit
              </button>
              {confirm ? (
                <>
                  <span className={HINT}>Articles already written keep what they said.</span>
                  <button type="button" disabled={busy} onClick={() => void remove()} className={`${SECONDARY} border-red-300 text-red-700 dark:border-red-900 dark:text-red-400`}>
                    Remove for good
                  </button>
                  <button type="button" onClick={() => setConfirm(false)} className={SECONDARY}>
                    Keep
                  </button>
                </>
              ) : (
                <button type="button" onClick={() => setConfirm(true)} className={SECONDARY}>
                  {note.status === "suggested" ? "Dismiss" : "Remove"}
                </button>
              )}
            </div>
          ) : null}
        </>
      )}
      {error ? (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </article>
  );
}

/** Where to open an article a note is linked to (`<workspaceId>/<planId>`). */
function articleHref(ref: string): string | null {
  const [ws, plan] = ref.split("/");
  return ws && plan ? `/admin/workspace/${encodeURIComponent(ws)}/create/${encodeURIComponent(plan)}` : null;
}

/** Which of the rest filters a kept note falls under. */
const restFilter = (r: NoteRestState | undefined): Filter | null => (!r ? null : r.reason === "used_up" ? "used_up" : r.reason ? "resting" : "ready");

/** Why a note rests, as a pill beside its kind. */
function RestPill({ state, now }: { state: NoteRestState; now: string }) {
  const [label, tone] =
    state.reason === "used_up"
      ? ["Used up", "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"]
      : state.reason === "held"
        ? ["In a draft", "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200"]
        : [`Resting until ${restDate(state.until, now)}`, "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"];
  return <span className={`ml-2 rounded-full px-2 py-0.5 text-[11px] font-medium normal-case tracking-normal ${tone}`}>{label}</span>;
}

/** Where a note was used and when, newest first, each a link to the article; and what its rest means. */
function WhereUsed({ note, state, now }: { note: BrandNote; state: NoteRestState | null; now: string }) {
  const [open, setOpen] = useState(false);
  const uses = usesOf(note).sort((a, b) => b.at.localeCompare(a.at));
  const dated = new Set(uses.map((u) => u.ref));
  const earlier = (note.usedBy ?? []).filter((ref) => !dated.has(ref)).length;
  const held = state?.reason === "held" && state.by ? state.by : null;
  if (!uses.length && !earlier) return null;
  return (
    <div className="space-y-1.5 border-t border-neutral-100 pt-2 text-xs dark:border-neutral-900">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-neutral-600 dark:text-neutral-300">
          {state?.reason === "used_up"
            ? "Goes in only when someone adds it to an article."
            : held
              ? `In the draft “${held.title}”, not written yet. Other articles leave it alone meanwhile.`
              : ""}
        </span>
        <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="text-blue-700 hover:underline dark:text-blue-300">
          Where it was used · {open ? "Hide" : "Show"}
        </button>
      </div>
      {open ? (
        <ul className="space-y-1">
          {uses.map((u) => {
            const href = articleHref(u.ref);
            const name = u.title || "An article";
            return (
              <li key={u.ref} className="flex flex-wrap justify-between gap-3">
                {href ? (
                  <a href={href} className="text-blue-700 hover:underline dark:text-blue-300">
                    {name}
                  </a>
                ) : (
                  <span>{name}</span>
                )}
                <span className="text-neutral-500 dark:text-neutral-400">{u.written ? `written ${restDate(u.at, now)}` : `in a draft since ${restDate(u.at, now)}`}</span>
              </li>
            );
          })}
          {earlier ? (
            <li className="text-neutral-500 dark:text-neutral-400">
              And {earlier} earlier {earlier === 1 ? "article" : "articles"}, from before dates were kept
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

/** How often a note goes into articles by itself; admins change it, everyone reads it. */
function RestSetting({ settings, canEdit, onSaved }: { settings: NotesRest; canEdit: boolean; onSaved: (s: NotesRest) => void }) {
  const id = useId();
  const [days, setDays] = useState(String(settings.restDays));
  const [uses, setUses] = useState(String(settings.maxUses));
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const restDays = Number(days);
  const maxUses = Number(uses);
  const valid =
    Number.isInteger(restDays) &&
    restDays >= NOTES_REST_LIMITS.restDays.min &&
    restDays <= NOTES_REST_LIMITS.restDays.max &&
    Number.isInteger(maxUses) &&
    maxUses >= NOTES_REST_LIMITS.maxUses.min &&
    maxUses <= NOTES_REST_LIMITS.maxUses.max;
  const changed = restDays !== settings.restDays || maxUses !== settings.maxUses;

  async function save() {
    setBusy(true);
    setStatus(null);
    const r = await send("/api/admin/brand-kit/notes/settings", "PUT", { restDays, maxUses });
    setBusy(false);
    if (!r.ok || !r.data.rest) return setStatus(r.status === 403 ? "Only an admin can change this." : "That didn't save. Check your connection and try again.");
    onSaved(r.data.rest as NotesRest);
    setStatus("Saved");
  }

  return (
    <section aria-label="How often a note goes in" className={`${CARD} space-y-2.5`}>
      <h2 className="text-sm font-semibold">How often a note goes in</h2>
      {canEdit ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>A note rests for</span>
          <label htmlFor={`${id}-days`} className="sr-only">
            Days a note rests after an article uses it
          </label>
          <input
            id={`${id}-days`}
            type="number"
            inputMode="numeric"
            min={NOTES_REST_LIMITS.restDays.min}
            max={NOTES_REST_LIMITS.restDays.max}
            value={days}
            onChange={(e) => {
              setDays(e.target.value);
              setStatus(null);
            }}
            className={`${NUMBER_FIELD} w-16`}
          />
          <span>days after an article uses it. After</span>
          <label htmlFor={`${id}-uses`} className="sr-only">
            Articles before a note goes in only when you add it
          </label>
          <input
            id={`${id}-uses`}
            type="number"
            inputMode="numeric"
            min={NOTES_REST_LIMITS.maxUses.min}
            max={NOTES_REST_LIMITS.maxUses.max}
            value={uses}
            onChange={(e) => {
              setUses(e.target.value);
              setStatus(null);
            }}
            className={`${NUMBER_FIELD} w-14`}
          />
          <span>articles, it goes in only when you add it.</span>
          <span className="ml-auto flex items-center gap-2">
            <span role="status" className={HINT}>
              {status ?? (valid ? "" : `Use 0 to ${NOTES_REST_LIMITS.restDays.max} days and 1 to ${NOTES_REST_LIMITS.maxUses.max} articles.`)}
            </span>
            <button type="button" disabled={busy || !valid || !changed} onClick={() => void save()} className={PRIMARY}>
              {busy ? "Saving…" : "Save"}
            </button>
          </span>
        </div>
      ) : (
        <p className="text-sm">
          A note rests for {settings.restDays} days after an article uses it. After {settings.maxUses} articles, it goes in only when someone adds it.
        </p>
      )}
      <p className={HINT}>Every article also asks your team three new questions, so there is always something new to add.</p>
    </section>
  );
}

/** How many notes are ready for an article, resting, and used up; each count shows those notes. */
function RestPanel({ counts, onShow }: { counts: { ready: number; resting: number; used_up: number }; onShow: (f: Filter) => void }) {
  const rows: Array<[Filter, string, number, string]> = [
    ["ready", "Ready for an article", counts.ready, ""],
    ["resting", "Resting", counts.resting, "text-amber-800 dark:text-amber-300"],
    ["used_up", "Used up", counts.used_up, "text-neutral-600 dark:text-neutral-300"],
  ];
  return (
    <section aria-label="Ready, resting and used up" className={`${CARD} space-y-2.5`}>
      <h2 className="text-sm font-semibold">Ready for articles</h2>
      <ul className="space-y-1.5">
        {rows.map(([f, label, n, tone]) => (
          <li key={f}>
            <button type="button" onClick={() => onShow(f)} className="flex w-full items-center justify-between rounded px-1 py-0.5 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-900">
              <span>{label}</span>
              <span className={`font-semibold tabular-nums ${tone}`}>{n}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className={HINT}>When most of a subject&rsquo;s notes are resting, its next articles lean on new questions.</p>
    </section>
  );
}

/** The articles that asked a question, each a link to the article. */
function AskedFor({ articles }: { articles: NoteArticle[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
      <span>Asked for</span>
      {articles.map((a) => {
        const href = articleHref(a.ref);
        const name = a.title || "An article";
        return href ? (
          <a key={a.ref} href={href} className={`${SUBJECT_CHIP} hover:underline`}>
            {name}
          </a>
        ) : (
          <span key={a.ref} className={SUBJECT_CHIP}>
            {name}
          </span>
        );
      })}
    </div>
  );
}

const ANSWER_STATUS: Record<AnswerSave, string> = {
  saving: "Saving…",
  saved: "Saved",
  failed: "Couldn't save. Your text is kept; it tries again as you type.",
};

/**
 * A question an article asked the team, not answered yet: the articles that asked it, and (for
 * admins) a box that saves the answer as it is typed. Once answered and the person leaves the
 * box, it shows as a note like any other.
 */
function OpenQuestionCard({
  note,
  canEdit,
  onChange,
  onRemoved,
}: {
  note: BrandNote;
  canEdit: boolean;
  onChange: (note: BrandNote) => void;
  onRemoved: (id: string) => void;
}) {
  const id = useId();
  const [text, setText] = useState(note.text);
  const [save, setSave] = useState<AnswerSave | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = useRef(onChange);
  changed.current = onChange;
  const queue = useMemo(
    () =>
      createAnswerQueue(
        (noteId) => `/api/admin/brand-kit/notes/${noteId}/answer`,
        (_id, s) => setSave(s),
        undefined,
        (_id, data, done) => {
          const saved = (data as { note?: BrandNote } | null)?.note;
          if (done && saved && saved.status !== "asked") changed.current(saved);
        },
      ),
    [],
  );
  useEffect(() => {
    window.addEventListener("pagehide", queue.leave);
    return () => {
      window.removeEventListener("pagehide", queue.leave);
      queue.leave();
    };
  }, [queue]);
  const asked = note.askedFor?.length ?? 0;

  async function remove() {
    setBusy(true);
    const r = await send(`/api/admin/brand-kit/notes/${note.id}`, "DELETE");
    setBusy(false);
    if (!r.ok) return setError(problem(r.status, r.data));
    onRemoved(note.id);
  }

  return (
    <article className={`${CARD} space-y-2.5 border-dashed border-amber-400 dark:border-amber-700`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">Open question</span>
        <span className={HINT}>
          Asked for {asked === 1 ? "1 article" : `${asked} articles`} · not answered yet
        </span>
      </div>
      <p className="text-sm leading-relaxed">{note.question}</p>
      {asked ? <AskedFor articles={note.askedFor ?? []} /> : null}
      {canEdit ? (
        <div className="space-y-1.5">
          <label htmlFor={`${id}-answer`} className={LABEL}>
            Your answer
          </label>
          <textarea
            id={`${id}-answer`}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              queue.save(note.id, e.target.value);
            }}
            onBlur={() => queue.done(note.id)}
            rows={3}
            maxLength={BRAND_NOTE_LIMITS.MAX_TEXT}
            placeholder="Answer it here. It saves as you type, and every article that asked it can use it."
            className={`${FIELD} leading-relaxed`}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span role="status" className={save === "failed" ? "text-xs text-red-600 dark:text-red-400" : HINT}>
              {save ? ANSWER_STATUS[save] : ""}
            </span>
            {confirm ? (
              <span className="flex flex-wrap items-center gap-2">
                <span className={HINT}>The articles that asked it stop showing it.</span>
                <button type="button" disabled={busy} onClick={() => void remove()} className={`${SECONDARY} border-red-300 text-red-700 dark:border-red-900 dark:text-red-400`}>
                  Remove for good
                </button>
                <button type="button" onClick={() => setConfirm(false)} className={SECONDARY}>
                  Keep
                </button>
              </span>
            ) : (
              <button type="button" onClick={() => setConfirm(true)} className={SECONDARY}>
                Remove question
              </button>
            )}
          </div>
        </div>
      ) : (
        <p className={HINT}>Only an admin can answer it here. Anyone working on an article that asked it can answer it there.</p>
      )}
      {error ? (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
    </article>
  );
}

/** How many questions articles asked that nobody has answered yet. */
function OpenQuestionsPanel({ count, onShow }: { count: number; onShow: () => void }) {
  return (
    <section aria-label="Open questions" className={`${CARD} space-y-2 border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40`}>
      <h2 className="text-sm font-semibold">Open questions</h2>
      <p className="text-sm">
        <span className="text-2xl font-semibold tabular-nums text-amber-800 dark:text-amber-300">{count}</span>{" "}
        <span className="text-neutral-700 dark:text-neutral-300">asked by your articles, not answered yet</span>
      </p>
      <p className={HINT}>Answer one and every article that asked it can speak from experience.</p>
      <button type="button" onClick={onShow} className={SECONDARY}>
        Show them
      </button>
    </section>
  );
}

function MixPanel({
  kinds,
  canEdit,
  onAsk,
  openQuestions = false,
}: {
  kinds: Record<BrandNoteKind, number>;
  canEdit: boolean;
  onAsk: (kind: BrandNoteKind) => void;
  /** There are open questions: say they count once answered. */
  openQuestions?: boolean;
}) {
  const order = [...BRAND_NOTE_KINDS].sort((a, b) => kinds[b] - kinds[a]);
  return (
    <section aria-label="Mix of experience" className={`${CARD} space-y-3`}>
      <div>
        <h2 className="text-sm font-semibold">Mix of experience</h2>
        <p className={`mt-0.5 ${HINT}`}>Articles read best when they can draw on different kinds.</p>
      </div>
      <ul className="space-y-2.5">
        {order.map((k) => (
          <li key={k} className="space-y-1.5">
            <div className="flex items-center gap-2 text-sm">
              <span className="w-36 shrink-0">{BRAND_NOTE_KIND_LABEL[k].many}</span>
              <span className="flex min-w-0 flex-1 gap-0.5" aria-hidden>
                {Array.from({ length: Math.min(kinds[k], 10) }, (_, i) => (
                  <span key={i} className="h-2.5 w-3 rounded-sm bg-blue-600 dark:bg-blue-400" />
                ))}
                {kinds[k] === 0 ? <span className="h-2.5 w-3 rounded-sm border border-dashed border-amber-600" /> : null}
              </span>
              <span className="w-8 text-right text-xs tabular-nums text-neutral-500 dark:text-neutral-400">{kinds[k]}</span>
            </div>
            {kinds[k] === 0 ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
                None yet. {KIND_QUESTIONS[k][0]}{" "}
                {canEdit ? (
                  <button type="button" onClick={() => onAsk(k)} className="font-medium underline underline-offset-2">
                    Add one
                  </button>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {openQuestions ? <p className={HINT}>Open questions don&rsquo;t count here until they&rsquo;re answered.</p> : null}
    </section>
  );
}

/** How many squares to draw before a bar says it instead. */
const MAX_SQUARES = 120;

function CoveragePanel({
  subjects,
  uncovered,
  canEdit,
  onAsk,
}: {
  subjects: NoteSubject[];
  uncovered: NoteSubject[];
  canEdit: boolean;
  onAsk: (subjectId: string) => void;
}) {
  const [all, setAll] = useState(false);
  const covered = subjects.length - uncovered.length;
  const missing = new Set(uncovered.map((s) => s.id));
  const list = all ? uncovered : uncovered.slice(0, 5);
  return (
    <section aria-label="What your notes cover" className={`${CARD} space-y-3`}>
      <div>
        <h2 className="text-sm font-semibold">What your notes cover</h2>
        <p className={`mt-0.5 ${HINT}`}>
          {subjects.length
            ? `Notes touch ${covered} of ${subjects.length} subject${subjects.length === 1 ? "" : "s"} on your brand map.`
            : "Your brand map has no subjects yet."}
        </p>
      </div>
      {subjects.length ? (
        subjects.length <= MAX_SQUARES ? (
          <div className="flex flex-wrap gap-1" role="img" aria-label={`${covered} of ${subjects.length} subjects have a note`}>
            {subjects.map((s) =>
              missing.has(s.id) ? (
                <span key={s.id} title={s.name} className="h-5 w-5 rounded border-[1.5px] border-neutral-400 dark:border-neutral-600" />
              ) : (
                <span key={s.id} title={s.name} className="h-5 w-5 rounded bg-blue-600 dark:bg-blue-400" />
              ),
            )}
          </div>
        ) : (
          <div className="h-2.5 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800" role="img" aria-label={`${covered} of ${subjects.length} subjects have a note`}>
            <div className="h-full bg-blue-600 dark:bg-blue-400" style={{ width: `${Math.round((covered / subjects.length) * 100)}%` }} />
          </div>
        )
      ) : null}
      {uncovered.length ? (
        <div>
          <h3 className="text-xs font-semibold text-neutral-700 dark:text-neutral-300">Nothing yet on</h3>
          <ul className={`mt-1 ${all ? "max-h-72 overflow-y-auto" : ""}`}>
            {list.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-2 border-t border-neutral-100 py-1.5 text-sm first:border-t-0 dark:border-neutral-900">
                <span className="min-w-0 truncate">{s.name}</span>
                {canEdit ? (
                  <button type="button" onClick={() => onAsk(s.id)} className="shrink-0 text-xs text-blue-700 underline-offset-2 hover:underline dark:text-blue-300">
                    Add a note
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          {uncovered.length > 5 ? (
            <button type="button" onClick={() => setAll((v) => !v)} className="mt-1 text-xs text-blue-700 underline-offset-2 hover:underline dark:text-blue-300">
              {all ? "Show fewer" : `Show all ${uncovered.length}`}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

type Candidate = FoundNote & { tick: boolean; canName: boolean; subjectIds: string[] };

/** Paste a call, a thread or a case study; tick the notes found in it to keep them. */
function PasteNotes({ subjects, onAdded }: { subjects: NoteSubject[] | null; onAdded: (notes: BrandNote[]) => void }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [found, setFound] = useState<Candidate[] | null>(null);
  const [busy, setBusy] = useState<null | "find" | "add">(null);
  const [error, setError] = useState<string | null>(null);
  const ticked = found?.filter((f) => f.tick) ?? [];

  const reset = () => {
    setText("");
    setFound(null);
    setError(null);
  };

  async function find() {
    setBusy("find");
    setError(null);
    const r = await send("/api/admin/brand-kit/notes/extract", "POST", { text });
    setBusy(null);
    if (!r.ok) {
      setError(
        r.status === 429
          ? "Too many runs just now. Try again in a few minutes."
          : r.status === 400
            ? "Paste a few sentences at least, and no more than 30,000 characters."
            : "Vizzy couldn't read it this time. Try again.",
      );
      return;
    }
    const list = ((r.data.found as FoundNote[] | undefined) ?? []).map((f) => ({
      ...f,
      tick: true,
      canName: false,
      subjectIds: suggestSubjects(f.text, subjects ?? [], 2).map((s) => s.id),
    }));
    setFound(list);
  }

  async function add() {
    setBusy("add");
    setError(null);
    const added: BrandNote[] = [];
    for (const f of ticked) {
      const r = await send("/api/admin/brand-kit/notes", "POST", { text: f.text, kind: f.kind, subjectIds: f.subjectIds, canName: f.canName, source: "paste" });
      if (!r.ok || !r.data.note) {
        setError(`${added.length ? `Added ${added.length}. ` : ""}${problem(r.status, r.data)}`);
        break;
      }
      added.push(r.data.note as BrandNote);
    }
    setBusy(null);
    if (added.length) onAdded(added);
    if (added.length === ticked.length) {
      setOpen(false);
      reset();
    } else setFound((list) => list?.filter((f) => !added.some((a) => a.text === f.text)) ?? null);
  }

  const update = (i: number, patch: Partial<Candidate>) => setFound((list) => list?.map((f, j) => (j === i ? { ...f, ...patch } : f)) ?? null);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <Dialog.Trigger className={`${SECONDARY} inline-flex items-center gap-1.5 bg-white py-1.5 text-sm dark:bg-neutral-950`}>
        <ClipboardPaste size={14} aria-hidden /> Paste a call or document
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed inset-x-4 top-[6vh] z-50 mx-auto flex max-h-[88vh] max-w-4xl flex-col overflow-hidden rounded-xl bg-white shadow-xl dark:bg-neutral-950">
          <div className="flex items-start justify-between gap-3 border-b border-neutral-200 px-5 py-4 dark:border-neutral-800">
            <div>
              <Dialog.Title className="text-base font-semibold">Paste a call or document</Dialog.Title>
              <Dialog.Description className={`mt-1 ${HINT}`}>
                A sales call, a support thread, a case study. Vizzy pulls out what your team saw. You choose what to keep.
              </Dialog.Description>
            </div>
            <Dialog.Close aria-label="Close" className="rounded p-1 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-900">
              <X size={18} aria-hidden />
            </Dialog.Close>
          </div>
          <div className="grid min-h-0 flex-1 gap-0 overflow-y-auto md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
            <div className="space-y-2 border-neutral-200 p-5 md:border-r dark:border-neutral-800">
              <label htmlFor={`${id}-paste`} className={LABEL}>
                What you pasted
              </label>
              <textarea
                id={`${id}-paste`}
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={14}
                maxLength={30_000}
                className={`${FIELD} leading-relaxed`}
                placeholder="Paste a transcript, a thread or a document here."
              />
              <p className={HINT}>The pasted text isn&rsquo;t kept. Only the notes you add are saved.</p>
            </div>
            <div className="space-y-3 p-5">
              {found === null ? (
                <p className={HINT}>Vizzy finds the first-hand experience in it: stories, tests, results, mistakes, objections. Generic claims are left out.</p>
              ) : found.length === 0 ? (
                <p className={HINT}>No first-hand experience found in that. Try a call transcript or a case study.</p>
              ) : (
                <>
                  <h3 className="text-sm font-semibold">Vizzy found {found.length === 1 ? "1 note" : `${found.length} notes`}</h3>
                  <ul className="space-y-2">
                    {found.map((f, i) => (
                      <li key={i} className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
                        <div className="flex items-start gap-3">
                          <input type="checkbox" checked={f.tick} onChange={(e) => update(i, { tick: e.target.checked })} aria-label={`Keep: ${f.text}`} className="mt-1" />
                          <div className="min-w-0 flex-1 space-y-2">
                            <select
                              value={f.kind}
                              onChange={(e) => update(i, { kind: e.target.value as BrandNoteKind })}
                              aria-label="Kind"
                              className={`${FIELD} w-auto py-1 text-xs`}
                            >
                              {BRAND_NOTE_KINDS.map((k) => (
                                <option key={k} value={k}>
                                  {BRAND_NOTE_KIND_LABEL[k].one}
                                </option>
                              ))}
                            </select>
                            <p className="text-sm leading-relaxed">{f.text}</p>
                            {f.subjectIds.length ? (
                              <div className="flex flex-wrap gap-1.5">
                                {f.subjectIds.map((sid) => (
                                  <span key={sid} className={SUBJECT_CHIP}>
                                    {subjects?.find((s) => s.id === sid)?.name}
                                  </span>
                                ))}
                              </div>
                            ) : null}
                            {f.namesSomeone ? (
                              <label className="flex items-start gap-2 rounded-md bg-amber-50 px-2.5 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                                <input type="checkbox" checked={f.canName} onChange={(e) => update(i, { canName: e.target.checked })} className="mt-0.5" />
                                It names someone. Tick only if they agreed to be named; otherwise articles keep them anonymous.
                              </label>
                            ) : null}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {error ? (
                <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                  {error}
                </p>
              ) : null}
            </div>
          </div>
          <div className="flex justify-end gap-2 border-t border-neutral-200 px-5 py-3 dark:border-neutral-800">
            <Dialog.Close className={SECONDARY}>Cancel</Dialog.Close>
            {found && found.length ? (
              <button type="button" onClick={() => void add()} disabled={busy !== null || !ticked.length} className={PRIMARY}>
                {busy === "add" ? "Adding…" : `Add ticked (${ticked.length})`}
              </button>
            ) : (
              <button type="button" onClick={() => void find()} disabled={busy !== null || text.trim().length < 40} className={PRIMARY}>
                {busy === "find" ? "Reading…" : "Find notes"}
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
