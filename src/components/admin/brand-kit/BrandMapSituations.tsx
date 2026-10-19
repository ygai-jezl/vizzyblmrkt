"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Star } from "lucide-react";
import { SITUATION_W_LABEL, type BrandMapSituation, type SituationSide, type SituationW } from "@/lib/types/brandMapRecords";
import type { SituationRead } from "@/lib/brandMap/situations";
import { api, errorText } from "@/components/admin/connect/api";
import { Banner, Button, inputClass } from "@/components/admin/connect/ui";
import { Dot, STATE_LABEL, WriteNext } from "./BrandMapCoverage";
import { smallLabel } from "./BrandMapParts";
import { useMapMove } from "./brandMapMove";
import { BrandMapFindSituations } from "./BrandMapFindSituations";
import { askedText, askSituation, proposedOf, type AskRun } from "./situationAsk";

/**
 * The Buying situations tab (BRAND_MAP_SITUATIONS_ENABLED): the situations people are in when
 * they look for something like the brand, in their own words, and what they ask. A person
 * stars the ones to focus on (no limit), adds their own, and adds or dismisses what research
 * proposes. One opens with its questions, the subjects they sit on and how far along each
 * is, what of the brand's own backs it, and where it was seen on the web. With
 * BRAND_MAP_SITUATION_ASK_ENABLED, any situation on the map (one a person wrote too) can find
 * what people in it ask, and its proposed questions are added or dismissed right there.
 */

const MAP = "/api/admin/brand-kit/map";
const SMALL = "rounded border border-neutral-300 px-2 py-0.5 text-[11px] hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";
const W_ORDER = Object.keys(SITUATION_W_LABEL) as SituationW[];
const SIDE_LABEL: Record<SituationSide, string> = { business: "Business", professional: "Professional" };

type Filter = { kind: "all" } | { kind: "focus" } | { kind: "proposed" } | { kind: "w"; w: SituationW } | { kind: "side"; side: SituationSide };
type Draft = { text: string; w: SituationW; wText: string; who: string; side: SituationSide; want: string; feel: string };
type Note = { tone: "ok" | "err" | "info"; text: string };
type Decide = (ids: { accept?: string[]; dismiss?: string[] }, done: string) => Promise<boolean>;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const draftOf = (s?: BrandMapSituation): Draft => ({
  text: s?.text ?? "",
  w: s?.w ?? "why",
  wText: s?.wText ?? "",
  who: s?.who ?? "",
  side: s?.side ?? "business",
  want: s?.want ?? "",
  feel: s?.feel ?? "",
});

const shows = (f: Filter, s: BrandMapSituation) =>
  f.kind === "all" ||
  (f.kind === "focus" && s.focus) ||
  (f.kind === "proposed" && s.status === "proposed") ||
  (f.kind === "w" && s.w === f.w) ||
  (f.kind === "side" && s.side === f.side);

export function BrandMapSituations({
  canEdit,
  canFind,
  askOn = false,
  canAsk = false,
  brandName,
  programmes,
}: {
  canEdit: boolean;
  /** Research can run here (its switch, and a model). */
  canFind: boolean;
  /** "Find what they ask" is switched on: a situation's proposed questions are decided in its panel. */
  askOn?: boolean;
  /** ...and research can run here to find them (a model). */
  canAsk?: boolean;
  brandName: string;
  programmes: Array<{ id: string; name: string }> | null;
}) {
  const { round } = useMapMove();
  const [finding, setFinding] = useState(false);
  const [list, setList] = useState<BrandMapSituation[] | null>(null);
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  const [openId, setOpenId] = useState<string | null>(null);
  const [open, setOpen] = useState<SituationRead | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  // "Find what they ask": the situation being asked about, what came back, and the page's run.
  const [asking, setAsking] = useState<string | null>(null);
  const [askNote, setAskNote] = useState<(Note & { id: string }) | null>(null);
  const askRun = useRef<AskRun | null>(null);
  const openRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ situations?: BrandMapSituation[]; error?: string }>(`${MAP}/situations`);
    if (r.ok && r.data.situations) setList(r.data.situations);
    else {
      setList([]);
      setNote({ tone: "err", text: errorText(r.data) });
    }
  }, []);
  const loadOpen = useCallback(async (id: string) => {
    const r = await api<SituationRead & { error?: string }>(`${MAP}/situations/${encodeURIComponent(id)}`);
    // Another one opened meanwhile: it has its own read.
    if (openRef.current === id) setOpen(r.ok ? r.data : null);
  }, []);

  useEffect(() => {
    void load();
  }, [load, round]);
  useEffect(() => {
    openRef.current = openId;
    if (openId) void loadOpen(openId);
    else setOpen(null);
  }, [openId, loadOpen]);

  async function act(run: () => Promise<{ ok: boolean; data: unknown }>, done?: string) {
    setBusy(true);
    setNote(null);
    const r = await run();
    setBusy(false);
    if (!r.ok) setNote({ tone: "err", text: errorText(r.data) });
    else if (done) setNote({ tone: "ok", text: done });
    await Promise.all([load(), openId ? loadOpen(openId) : Promise.resolve()]);
    return r.ok;
  }
  const decide = (id: string, accept: boolean) =>
    act(() => api(`${MAP}/proposals`, { method: "POST", body: JSON.stringify({ [accept ? "accept" : "dismiss"]: { situations: [id] } }) }));
  const star = (s: BrandMapSituation) => act(() => api(`${MAP}/situations/${encodeURIComponent(s.id)}`, { method: "PATCH", body: JSON.stringify({ baseRev: s.rev, focus: !s.focus }) }));
  const decideQuestions: Decide = (ids, done) => {
    setAskNote(null);
    return act(
      () =>
        api(`${MAP}/proposals`, {
          method: "POST",
          body: JSON.stringify({ ...(ids.accept?.length ? { accept: { questions: ids.accept } } : {}), ...(ids.dismiss?.length ? { dismiss: { questions: ids.dismiss } } : {}) }),
        }),
      done,
    );
  };

  async function ask(id: string) {
    setAsking(id);
    setAskNote(null);
    setNote(null);
    const r = await askSituation(id, askRun.current, { api });
    askRun.current = r.run;
    setAsking(null);
    setAskNote(
      r.ok
        ? { id, tone: "ok", text: askedText(r.questions) }
        : { id, tone: "err", text: r.status === 0 ? "Research may still be finishing. Open this situation again in a minute." : errorText(r.data) },
    );
    await Promise.all([load(), openRef.current === id ? loadOpen(id) : Promise.resolve()]);
  }

  async function add(d: Draft) {
    // The one added (or the one the map has already) opens, ready to find what people in it ask.
    const made = { id: "" };
    const ok = await act(async () => {
      const r = await api<{ value?: { id: string }; current?: { id: string } }>(`${MAP}/situations`, { method: "POST", body: JSON.stringify(d) });
      made.id = (askOn && (r.data.value?.id ?? r.data.current?.id)) || "";
      return r;
    }, canAsk ? "Added. Now find what people in it ask." : "Added. It's on your map.");
    if (made.id) setOpenId(made.id);
    if (ok) setAdding(false);
  }

  const shown = useMemo(() => (list ?? []).filter((s) => shows(filter, s)), [list, filter]);
  const proposed = shown.filter((s) => s.status === "proposed");
  const decided = shown.filter((s) => s.status === "decided");
  const chip = (f: Filter, label: string) => {
    const on = JSON.stringify(f) === JSON.stringify(filter);
    return (
      <button
        key={label}
        type="button"
        aria-pressed={on}
        onClick={() => setFilter(f)}
        className={`rounded-full border px-2.5 py-0.5 text-xs ${on ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900" : "border-neutral-300 dark:border-neutral-700"}`}
      >
        {label}
      </button>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-neutral-600 dark:text-neutral-300">The situations people are in when they look for something like you, and what they ask.</p>
        {canEdit ? (
          <span className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => setAdding((a) => !a)}>
              Add a situation
            </Button>
            {canFind ? (
              <Button tone="primary" disabled={busy || finding} onClick={() => setFinding(true)}>
                Find buying situations
              </Button>
            ) : null}
          </span>
        ) : null}
      </div>
      {note ? <Banner tone={note.tone}>{note.text}</Banner> : null}
      {finding ? <BrandMapFindSituations brandName={brandName} onChanged={() => void load()} onClose={() => setFinding(false)} /> : null}
      {adding ? (
        <SituationForm
          busy={busy}
          submitLabel="Add it"
          onCancel={() => setAdding(false)}
          onSubmit={(d) => void add(d)}
        />
      ) : null}

      <div className="space-y-1.5">
        <div className="flex flex-wrap gap-1.5">
          {chip({ kind: "all" }, "All")}
          {chip({ kind: "focus" }, "Focus")}
          {chip({ kind: "proposed" }, "Proposed")}
          {chip({ kind: "side", side: "business" }, "Business")}
          {chip({ kind: "side", side: "professional" }, "Professional")}
          {W_ORDER.map((w) => chip({ kind: "w", w }, SITUATION_W_LABEL[w]))}
        </div>
        <p className="text-[11px] text-neutral-500">Why, when, while, with whom, with what, how they feel: the questions research asks to find each situation.</p>
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <section aria-label="Buying situations" className="min-w-0 space-y-3">
          {list === null ? <p className="text-xs text-neutral-500">Loading…</p> : null}
          {proposed.length ? (
            <div className="space-y-1.5">
              <span className={smallLabel}>Proposed</span>
              {proposed.map((s) => (
                <SituationCard key={s.id} s={s} open={openId === s.id} onOpen={() => setOpenId(s.id)}>
                  {canEdit ? (
                    <span className="flex gap-1.5">
                      <button type="button" disabled={busy} onClick={() => void decide(s.id, true)} className={SMALL}>
                        Add to the map
                      </button>
                      <button type="button" disabled={busy} onClick={() => void decide(s.id, false)} className={SMALL}>
                        Dismiss
                      </button>
                    </span>
                  ) : null}
                </SituationCard>
              ))}
            </div>
          ) : null}
          <div className="space-y-1.5">
            {proposed.length && decided.length ? <span className={smallLabel}>On your map</span> : null}
            {list && !shown.length ? <p className="text-xs text-neutral-500">Nothing here yet.</p> : null}
            {decided.map((s) => (
              <SituationCard key={s.id} s={s} open={openId === s.id} onOpen={() => setOpenId(s.id)}>
                <button
                  type="button"
                  disabled={!canEdit || busy}
                  aria-pressed={s.focus}
                  aria-label={s.focus ? "Focus on this: on" : "Focus on this"}
                  title={s.focus ? "A focus: first wherever we suggest what to write next" : "Focus on this"}
                  onClick={() => void star(s)}
                  className="rounded p-0.5 text-amber-500 disabled:opacity-60"
                >
                  <Star size={16} fill={s.focus ? "currentColor" : "none"} />
                </button>
              </SituationCard>
            ))}
          </div>
        </section>

        <aside aria-label="Buying situation" className="min-w-0">
          {open ? (
            <SituationDetail
              key={`${open.situation.id}:${open.situation.rev}`}
              read={open}
              canEdit={canEdit}
              busy={busy}
              programmes={programmes}
              act={act}
              decide={decide}
              ask={
                askOn
                  ? {
                      can: canAsk,
                      asking: asking === open.situation.id,
                      elsewhere: asking !== null && asking !== open.situation.id,
                      note: askNote?.id === open.situation.id ? askNote : null,
                      run: () => void ask(open.situation.id),
                      decide: decideQuestions,
                    }
                  : null
              }
              onGone={() => setOpenId(null)}
            />
          ) : (
            <p className="text-xs text-neutral-500">Choose a situation to see what people in it ask, and what of yours backs it.</p>
          )}
        </aside>
      </div>
    </div>
  );
}

function SituationCard({ s, open, onOpen, children }: { s: BrandMapSituation; open: boolean; onOpen: () => void; children?: ReactNode }) {
  const meta = [s.who, SIDE_LABEL[s.side], s.wText ? `${SITUATION_W_LABEL[s.w]}: ${s.wText}` : ""].filter(Boolean).join(" · ");
  const pct = s.counts.questions ? Math.round((100 * s.counts.answered) / s.counts.questions) : 0;
  return (
    <div
      className={`flex items-start gap-2 rounded-md border p-2 ${
        open ? "border-neutral-900 dark:border-white" : s.status === "proposed" ? "border-dashed border-neutral-400" : "border-neutral-200 dark:border-neutral-800"
      }`}
    >
      <button type="button" aria-pressed={open} onClick={onOpen} className="min-w-0 flex-1 space-y-0.5 text-left">
        <span className="block text-sm font-medium">“{s.text}”</span>
        {meta ? <span className="block text-[11px] text-neutral-500">{meta}</span> : null}
        {s.want ? <span className="block text-[11px] text-neutral-600 dark:text-neutral-300">Wants: {s.want}</span> : null}
        <span className="flex items-center gap-1.5 text-[11px] text-neutral-500">
          <span aria-hidden className="inline-block h-1.5 w-16 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
            <span className="block h-1.5 rounded-full bg-blue-600" style={{ width: `${pct}%` }} />
          </span>
          {s.counts.answered} of {s.counts.questions} questions answered
          {!s.backed ? <span className="text-amber-700 dark:text-amber-400"> · not backed by your material</span> : null}
        </span>
      </button>
      {children}
    </div>
  );
}

function SituationDetail({
  read,
  canEdit,
  busy,
  programmes,
  act,
  decide,
  ask,
  onGone,
}: {
  read: SituationRead;
  canEdit: boolean;
  busy: boolean;
  programmes: Array<{ id: string; name: string }> | null;
  act: (run: () => Promise<{ ok: boolean; data: unknown }>, done?: string) => Promise<boolean>;
  decide: (id: string, accept: boolean) => Promise<boolean>;
  /** "Find what they ask" (its switch): null when it is off. */
  ask: { can: boolean; asking: boolean; elsewhere: boolean; note: Note | null; run: () => void; decide: Decide } | null;
  onGone: () => void;
}) {
  const { situation: s, questions } = read;
  const [editing, setEditing] = useState(false);
  // Research can look for its questions once it's on the map; only admins decide what goes on.
  const askable = Boolean(ask?.can && canEdit && s.status === "decided");
  const asking = Boolean(ask?.asking);
  const deciding = ask && canEdit ? ask.decide : null;
  const { onMap, onNew } = proposedOf(questions);
  const proposedCount = onMap.length + onNew.length;
  // Deciding here, what waits for a decision comes first.
  const listed = deciding ? [...questions.filter((q) => q.status === "proposed"), ...questions.filter((q) => q.status !== "proposed")] : questions;
  const facts = [
    s.wText ? [SITUATION_W_LABEL[s.w], s.wText] : null,
    s.who ? ["Who", s.who] : null,
    ["Side", SIDE_LABEL[s.side]],
    s.want ? ["What they want", s.want] : null,
    s.feel ? ["How it feels", s.feel] : null,
  ].filter((x): x is [string, string] => Boolean(x));

  if (editing) {
    return (
      <SituationForm
        initial={draftOf(s)}
        busy={busy}
        submitLabel="Save"
        onCancel={() => setEditing(false)}
        onSubmit={(d) =>
          void act(() => api(`${MAP}/situations/${encodeURIComponent(s.id)}`, { method: "PATCH", body: JSON.stringify({ baseRev: s.rev, ...d }) }), "Saved.").then(
            (ok) => ok && setEditing(false),
          )
        }
      />
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Buying situation</div>
      <h3 className="text-base font-semibold">“{s.text}”</h3>
      {s.status === "proposed" ? (
        <div className="space-y-1.5 rounded-md border border-dashed border-neutral-400 px-2.5 py-2 text-xs">
          <p>Proposed by {s.from === "vizzy" ? "Vizzy" : "research"}. Nothing is on your map until you add it.</p>
          {canEdit ? (
            <span className="flex gap-1.5">
              <button type="button" disabled={busy} onClick={() => void decide(s.id, true)} className={SMALL}>
                Add to the map
              </button>
              <button type="button" disabled={busy} onClick={() => void decide(s.id, false)} className={SMALL}>
                Dismiss
              </button>
            </span>
          ) : null}
        </div>
      ) : null}
      {!s.backed ? (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          Not backed by your site or knowledge. Research found people in it, but nothing of yours speaks to it yet.
        </p>
      ) : null}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        {facts.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-neutral-500">{k}</dt>
            <dd className="break-words">{v}</dd>
          </div>
        ))}
      </dl>

      <section aria-label="What they ask" className="space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className={smallLabel}>What they ask</span>
          {askable && questions.length ? (
            <button type="button" disabled={busy || asking || ask?.elsewhere} onClick={ask?.run} className={SMALL}>
              {asking ? "Finding…" : "Find more"}
            </button>
          ) : null}
        </div>
        {asking ? (
          <p role="status" className="text-xs text-neutral-500">
            Finding what people in it ask. This takes up to a minute.
          </p>
        ) : null}
        {ask?.note ? (
          <p role="status" className={`text-xs ${ask.note.tone === "err" ? "text-red-700 dark:text-red-400" : "text-neutral-700 dark:text-neutral-300"}`}>
            {ask.note.text}
          </p>
        ) : null}
        {deciding && proposedCount > 1 ? (
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {onMap.length ? (
              <button
                type="button"
                disabled={busy || asking}
                onClick={() => void deciding({ accept: onMap }, `${plural(onMap.length, "question")} added to your map.`)}
                className={SMALL}
              >
                Add all on your subjects ({onMap.length})
              </button>
            ) : null}
            <button
              type="button"
              disabled={busy || asking}
              onClick={() => void deciding({ dismiss: [...onMap, ...onNew] }, `${plural(proposedCount, "question")} dismissed. Research won't bring them back.`)}
              className={SMALL}
            >
              Dismiss all proposed ({proposedCount})
            </button>
          </div>
        ) : null}
        {deciding && onNew.length ? (
          <p className="text-[11px] text-neutral-500">
            {onNew.length === 1 ? "1 question is" : `${onNew.length} questions are`} on a subject that isn&apos;t on your map yet. Adding one adds its subject too. You can also look at new
            subjects on the Subjects tab first.
          </p>
        ) : null}
        {questions.length ? (
          <ul className="space-y-1.5">
            {listed.map((q) => (
              <li key={q.id} className={`rounded-md border px-2 py-1.5 ${q.status === "proposed" ? "border-dashed border-neutral-400" : "border-neutral-200 dark:border-neutral-800"}`}>
                <span className="block text-sm">{q.text}</span>
                <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-500">
                  <Dot state={q.state} />
                  {q.status === "proposed" ? "Proposed" : STATE_LABEL[q.state]}
                  {q.subjectName ? <span>· {deciding && q.status === "proposed" && q.newSubject ? `New subject: ${q.subjectName}` : q.subjectName}</span> : null}
                  {q.status === "decided" && q.state === "open" && programmes?.length ? <WriteNext questionId={q.id} programmes={programmes} situationId={s.status === "decided" ? s.id : undefined} /> : null}
                  {deciding && q.status === "proposed" ? (
                    <span className="flex gap-1.5">
                      <button
                        type="button"
                        disabled={busy || asking}
                        onClick={() => void deciding({ accept: [q.id] }, q.newSubject ? `Added, with its new subject “${q.subjectName}”.` : "Added to your map.")}
                        className={SMALL}
                      >
                        {q.newSubject ? "Add with its subject" : "Add"}
                      </button>
                      <button type="button" disabled={busy || asking} onClick={() => void deciding({ dismiss: [q.id] }, "Dismissed. Research won't bring it back.")} className={SMALL}>
                        Dismiss
                      </button>
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        ) : asking ? null : (
          <div className="space-y-2">
            <p className="text-xs text-neutral-500">No questions linked to it yet.</p>
            {askable ? (
              <div className="space-y-1">
                <Button tone="primary" disabled={busy || ask?.elsewhere} onClick={ask?.run}>
                  Find what they ask
                </Button>
                <p className="text-[11px] text-neutral-500">
                  Research finds the questions people in this situation ask, and the subject on your map each one belongs to. Nothing goes on your map until you add it.
                </p>
              </div>
            ) : null}
          </div>
        )}
      </section>

      {s.backedBy.length ? (
        <section aria-label="Backed by your material" className="space-y-1">
          <span className={smallLabel}>Backed by your material</span>
          <ul className="space-y-0.5 text-sm">
            {s.backedBy.map((b, i) => (
              <li key={`${i}-${b.label}`} className="break-words">
                {b.url ? (
                  <a href={b.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline dark:text-blue-400">
                    {b.label}
                  </a>
                ) : (
                  b.label
                )}
                <span className="text-xs text-neutral-500"> · {b.kind === "page" ? "your site" : "your knowledge"}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {s.seen.length ? (
        <section aria-label="Seen on the web" className="space-y-1">
          <span className={smallLabel}>Seen on the web</span>
          <ul className="space-y-0.5 text-sm">
            {s.seen.map((w, i) => (
              <li key={`${i}-${w.domain}`} className="break-words">
                {w.title || w.domain}
                {w.title ? <span className="text-xs text-neutral-500"> · {w.domain}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {canEdit ? (
        <div className="flex flex-wrap gap-2 pt-1">
          <button type="button" disabled={busy || asking} onClick={() => setEditing(true)} className={SMALL}>
            Edit
          </button>
          <button
            type="button"
            disabled={busy || asking}
            onClick={() =>
              void act(() => api(`${MAP}/situations/${encodeURIComponent(s.id)}`, { method: "DELETE" }), "Removed. Its questions stay on their subjects.").then((ok) => ok && onGone())
            }
            className={SMALL}
          >
            Remove
          </button>
        </div>
      ) : null}
    </div>
  );
}

function SituationForm({
  initial,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: Draft;
  busy: boolean;
  submitLabel: string;
  onSubmit: (d: Draft) => void;
  onCancel: () => void;
}) {
  const [d, setD] = useState<Draft>(initial ?? draftOf());
  const field = (key: keyof Draft, label: string, placeholder: string) => (
    <label className="space-y-1 text-xs">
      <span className="font-medium text-neutral-600 dark:text-neutral-300">{label}</span>
      <input value={d[key]} onChange={(e) => setD({ ...d, [key]: e.target.value })} placeholder={placeholder} maxLength={120} className={`${inputClass} text-sm`} />
    </label>
  );
  return (
    <form
      className="space-y-2.5 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
      onSubmit={(e) => {
        e.preventDefault();
        if (d.text.trim()) onSubmit(d);
      }}
    >
      <label className="block space-y-1 text-xs">
        <span className="font-medium text-neutral-600 dark:text-neutral-300">The situation, in the buyer&apos;s own words</span>
        <input
          value={d.text}
          onChange={(e) => setD({ ...d, text: e.target.value })}
          placeholder="Our clicks from Google are falling, but our rankings aren't"
          maxLength={200}
          required
          className={`${inputClass} text-sm`}
        />
      </label>
      <div className="grid gap-2.5 sm:grid-cols-2">
        <label className="space-y-1 text-xs">
          <span className="font-medium text-neutral-600 dark:text-neutral-300">What it turns on</span>
          <select value={d.w} onChange={(e) => setD({ ...d, w: e.target.value as SituationW })} className={`${inputClass} text-sm`}>
            {W_ORDER.map((w) => (
              <option key={w} value={w}>
                {SITUATION_W_LABEL[w]}
              </option>
            ))}
          </select>
        </label>
        {field("wText", "In a few words", "after the monthly traffic report")}
        {field("who", "Who they are", "Head of SEO")}
        <label className="space-y-1 text-xs">
          <span className="font-medium text-neutral-600 dark:text-neutral-300">Whose stake</span>
          <select value={d.side} onChange={(e) => setD({ ...d, side: e.target.value as SituationSide })} className={`${inputClass} text-sm`}>
            <option value="business">Business: its goals</option>
            <option value="professional">Professional: their own</option>
          </select>
        </label>
        {field("want", "What they want", "Win the clicks back, and explain the drop")}
        {field("feel", "How it feels", "Worried: the board will ask")}
      </div>
      <div className="flex gap-2">
        <Button type="submit" tone="primary" disabled={busy || !d.text.trim()}>
          {submitLabel}
        </Button>
        <Button type="button" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
