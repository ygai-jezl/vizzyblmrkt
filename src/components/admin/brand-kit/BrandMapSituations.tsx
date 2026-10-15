"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Star } from "lucide-react";
import { SITUATION_W_LABEL, type BrandMapSituation, type SituationSide, type SituationW } from "@/lib/types/brandMapRecords";
import type { SituationRead } from "@/lib/brandMap/situations";
import { api, errorText } from "@/components/admin/connect/api";
import { Banner, Button, inputClass } from "@/components/admin/connect/ui";
import { Dot, STATE_LABEL, WriteNext } from "./BrandMapCoverage";
import { smallLabel } from "./BrandMapParts";
import { useMapMove } from "./brandMapMove";

/**
 * The Buying situations tab (BRAND_MAP_SITUATIONS_ENABLED): the situations people are in when
 * they look for something like the brand, in their own words, and what they ask. A person
 * stars the ones to focus on (no limit), adds their own, and adds or dismisses what research
 * proposes. One opens with its questions, the subjects they sit on and how far along each
 * is, what of the brand's own backs it, and where it was seen on the web.
 */

const MAP = "/api/admin/brand-kit/map";
const SMALL = "rounded border border-neutral-300 px-2 py-0.5 text-[11px] hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";
const W_ORDER = Object.keys(SITUATION_W_LABEL) as SituationW[];
const SIDE_LABEL: Record<SituationSide, string> = { business: "Business", professional: "Professional" };

type Filter = { kind: "all" } | { kind: "focus" } | { kind: "proposed" } | { kind: "w"; w: SituationW } | { kind: "side"; side: SituationSide };
type Draft = { text: string; w: SituationW; wText: string; who: string; side: SituationSide; want: string; feel: string };

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

export function BrandMapSituations({ canEdit, programmes }: { canEdit: boolean; programmes: Array<{ id: string; name: string }> | null }) {
  const { round } = useMapMove();
  const [list, setList] = useState<BrandMapSituation[] | null>(null);
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  const [openId, setOpenId] = useState<string | null>(null);
  const [open, setOpen] = useState<SituationRead | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "err" | "info"; text: string } | null>(null);

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
    setOpen(r.ok ? r.data : null);
  }, []);

  useEffect(() => {
    void load();
  }, [load, round]);
  useEffect(() => {
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
          <Button disabled={busy} onClick={() => setAdding((a) => !a)}>
            Add a situation
          </Button>
        ) : null}
      </div>
      {note ? <Banner tone={note.tone}>{note.text}</Banner> : null}
      {adding ? (
        <SituationForm
          busy={busy}
          submitLabel="Add it"
          onCancel={() => setAdding(false)}
          onSubmit={(d) =>
            void act(() => api(`${MAP}/situations`, { method: "POST", body: JSON.stringify(d) }), "Added. It's on your map.").then((ok) => ok && setAdding(false))
          }
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
  onGone,
}: {
  read: SituationRead;
  canEdit: boolean;
  busy: boolean;
  programmes: Array<{ id: string; name: string }> | null;
  act: (run: () => Promise<{ ok: boolean; data: unknown }>, done?: string) => Promise<boolean>;
  decide: (id: string, accept: boolean) => Promise<boolean>;
  onGone: () => void;
}) {
  const { situation: s, questions } = read;
  const [editing, setEditing] = useState(false);
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
        <span className={smallLabel}>What they ask</span>
        {questions.length ? (
          <ul className="space-y-1.5">
            {questions.map((q) => (
              <li key={q.id} className={`rounded-md border px-2 py-1.5 ${q.status === "proposed" ? "border-dashed border-neutral-400" : "border-neutral-200 dark:border-neutral-800"}`}>
                <span className="block text-sm">{q.text}</span>
                <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-500">
                  <Dot state={q.state} />
                  {q.status === "proposed" ? "Proposed" : STATE_LABEL[q.state]}
                  {q.subjectName ? <span>· {q.subjectName}</span> : null}
                  {q.status === "decided" && q.state === "open" && programmes?.length ? <WriteNext questionId={q.id} programmes={programmes} /> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-neutral-500">No questions linked to it yet.</p>
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
          <button type="button" disabled={busy} onClick={() => setEditing(true)} className={SMALL}>
            Edit
          </button>
          <button
            type="button"
            disabled={busy}
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
