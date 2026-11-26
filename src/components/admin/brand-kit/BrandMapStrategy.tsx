"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Star } from "lucide-react";
import Link from "next/link";
import type { StrategyView, ViewCompetitor } from "@/lib/brandStrategy/adminApi";
import type { StrategyCompetitorsView } from "@/lib/brandStrategy/competitorsView";
import { BRAND_KIT_COMPETITORS_ROUTE } from "@/lib/content/brandKit";
import {
  BRAND_STRATEGY_LIMITS as L,
  COMPETITOR_GROUP_KINDS,
  COMPETITOR_GROUP_LABEL,
  NOT_GROUPED_LABEL,
  STRATEGY_SOURCE_LABEL,
  claimShown,
  type ClaimShown,
  type StrategyClaim,
} from "@/lib/types/brandStrategy";
import { api } from "@/components/admin/connect/api";
import { Banner, Button, inputClass } from "@/components/admin/connect/ui";
import { AddLine, RemoveButton, smallLabel } from "./BrandMapParts";
import { useMapMove } from "./brandMapMove";
import { APPROVED_NOTE, GAP_LABEL, PROPOSED_NOTE, TRUNCATED_NOTE, droppedNote, finderNote, foundNote, monitoredNote, notCompetitorNote, starsNotUpdatedNote, strategyErrorText } from "./strategyMessages";
import { BrandMapContentPlan } from "./BrandMapContentPlan";
import { CompetitorGroupPicker } from "./CompetitorGroupPicker";
import { FLAG_TEXT } from "./CompetitorCoverage";

/**
 * The Strategy tab (BRAND_STRATEGY_ENABLED): the brand strategy, one per brand, approved by a
 * person. Who it's for (audiences and 3 to 5 focus buying situations), who you compete with (found
 * by the competitor finder, ticked to monitor), where you win and where they do (each claim with its
 * proof, or a gap), what you say and what you're not, and the quarter's goal. Members read it;
 * admins propose, edit and approve. Each edit saves at once, naming the revision it started from.
 */

const STRATEGY = "/api/admin/brand-kit/map/strategy";
const COMPETITORS = "/api/admin/brand-kit/competitors";
const SMALL = "rounded border border-neutral-300 px-2 py-0.5 text-[11px] hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";
const CARD = "space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800";

type Note = { tone: "ok" | "err" | "info"; text: string };
type Reply = { strategy?: StrategyView; error?: string; dropped?: { claims: number }; found?: number; gapSkipped?: boolean; starsNotUpdated?: string[] };

/** Whose focus situations the Against your competitors card sets against them. */
const AGAINST_FROM: Record<NonNullable<StrategyCompetitorsView["against"]>["from"], string> = {
  approved: "Your approved focus situations, against their articles and the questions you've answered.",
  draft: "The focus situations in your draft, against their articles and the questions you've answered.",
  busiest: "No focus situations yet: the ones they write on most. Star your focus under Who it's for.",
};

const KIND_LABEL: Record<ClaimShown, string> = { site: "site", docs: "docs", them: "them", gap: "gap" };
const KIND_TONE: Record<ClaimShown, string> = {
  site: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  docs: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300",
  them: "bg-neutral-200 text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200",
  gap: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
};

const day = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
};
const pathOf = (url: string) => {
  try {
    const u = new URL(url);
    return u.pathname === "/" ? u.hostname : u.pathname;
  } catch {
    return url;
  }
};

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className={CARD} aria-label={title}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function BrandMapStrategy({ canEdit, contentPlan = false }: { canEdit: boolean; contentPlan?: boolean }) {
  const { round } = useMapMove();
  const [view, setView] = useState<StrategyView | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const [goalEdit, setGoalEdit] = useState<{ text: string; measure: string } | null>(null);
  const [claimEdit, setClaimEdit] = useState<{ id: string; text: string } | null>(null);

  const load = useCallback(async () => {
    const r = await api<Reply>(STRATEGY);
    if (r.ok && r.data.strategy) setView(r.data.strategy);
    else setNote({ tone: "err", text: strategyErrorText(r.data) });
  }, []);
  useEffect(() => {
    void load();
  }, [load, round]);

  // Joined to Competitors: what they write and how it sets against the strategy, read live.
  const [theirs, setTheirs] = useState<StrategyCompetitorsView | null>(null);
  const live = Boolean(view?.joined && view.canMonitor);
  const watchedCount = view?.competitors.filter((c) => c.monitored).length ?? 0;
  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    void api<{ competitors?: StrategyCompetitorsView }>(`${STRATEGY}/competitors`).then((r) => {
      if (!cancelled) setTheirs(r.ok && r.data.competitors ? r.data.competitors : null);
    });
    return () => {
      cancelled = true;
    };
  }, [live, round, watchedCount, view?.rev, view?.approved?.at]);

  /** Run a request; on success show the strategy it sends back, else say why and read it again. */
  async function run(path: string, init: RequestInit, done?: (data: Reply) => string): Promise<boolean> {
    setBusy(true);
    setNote(null);
    const r = await api<Reply>(path, init);
    setBusy(false);
    if (r.ok && r.data.strategy) {
      setView(r.data.strategy);
      // Approved, but some stars didn't change on the brand map: say which, whatever the request was.
      if (r.data.starsNotUpdated?.length) setNote({ tone: "info", text: starsNotUpdatedNote(r.data.starsNotUpdated) });
      else if (done) setNote({ tone: "ok", text: done(r.data) });
      return true;
    }
    setNote({ tone: "err", text: strategyErrorText(r.data) });
    await load();
    return false;
  }
  const edit = (patch: Record<string, unknown>, done?: string) =>
    run(STRATEGY, { method: "PUT", body: JSON.stringify({ baseRev: view?.rev ?? 0, ...patch }) }, done ? () => done : undefined);

  if (!view) return <p className="text-xs text-neutral-500">{note ? note.text : "Loading…"}</p>;
  const draft = view.draft;
  const editable = canEdit && Boolean(draft);
  const focus = new Set(draft?.focusSituationIds ?? []);
  const claims = draft?.claims ?? [];
  const claimBody = (list: StrategyClaim[]) => list.map((c) => ({ id: c.id, side: c.side, text: c.text, competitor: c.competitor }));

  const star = (id: string) => {
    const next = focus.has(id) ? [...focus].filter((x) => x !== id) : [...focus, id];
    if (next.length > L.focusMax) {
      setNote({ tone: "info", text: `Pick ${L.focusMin} to ${L.focusMax} focus situations. Unstar one first.` });
      return;
    }
    void edit({ focusSituationIds: next });
  };

  async function monitor(c: ViewCompetitor) {
    if (!c.site) return;
    setBusy(true);
    setNote(null);
    // Joined, Monitor carries the finder's group, and the list is live: nothing else to save.
    const r = await api<{ error?: string }>(COMPETITORS, {
      method: "POST",
      body: JSON.stringify({ name: c.name, website: c.site, ...(view?.joined && c.group ? { group: c.group } : {}) }),
    });
    setBusy(false);
    // Already watched counts as done: the tick is what this records.
    if (!r.ok && r.data.error !== "already_watching") {
      setNote({ tone: "err", text: strategyErrorText(r.data) });
      return;
    }
    if (view?.joined) {
      await load();
      setNote({ tone: "ok", text: monitoredNote(c.name) });
      return;
    }
    await edit({ ticked: [{ name: c.name, ticked: true }] }, monitoredNote(c.name));
  }

  const notCompetitor = (c: ViewCompetitor) =>
    run(`${STRATEGY}/competitors/not`, { method: "POST", body: JSON.stringify({ name: c.name, site: c.site }) }, () => notCompetitorNote(c.name));

  const stateLine =
    view.state === "approved" && view.approved
      ? `Approved ${day(view.approved.at)}`
      : view.state === "changed"
        ? "Changed since it was approved · not approved"
        : view.state === "draft"
          ? "Draft · not approved"
          : "No strategy yet";

  const groups = COMPETITOR_GROUP_KINDS.map((kind) => ({ kind, list: view.competitors.filter((c) => c.group === kind) })).filter((g) => g.list.length);
  // Joined to Competitors: the watched ones by the group a person chose, then the finder's suggestions.
  const profiles = new Map((theirs?.profiles ?? []).map((p) => [p.id, p] as const));
  const against = live ? theirs?.against : null;
  const watchedList = view.competitors.filter((c) => c.monitored);
  const watchedGroups = [
    ...COMPETITOR_GROUP_KINDS.map((kind) => ({ key: kind as string, label: COMPETITOR_GROUP_LABEL[kind], list: watchedList.filter((c) => c.group === kind) })),
    { key: "none", label: NOT_GROUPED_LABEL, list: watchedList.filter((c) => !c.group) },
  ].filter((g) => g.list.length);
  const suggestions = view.competitors.filter((c) => !c.monitored && c.from === "finder");
  const find = (mode: "quick" | "full") =>
    run(`${STRATEGY}/competitors`, { method: "POST", body: JSON.stringify({ mode }) }, (d) => foundNote(d.found ?? 0, d.gapSkipped, live));
  const proposedNot = (draft?.isNotProposals ?? []).filter((x) => x.state === "proposed");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-neutral-600 dark:text-neutral-300">
          Who you&apos;re for, who you compete with, where you win and the quarter&apos;s goal. Once approved, articles, research, Next up and Vizzy use it.
        </p>
        <span className="rounded-full border border-neutral-300 px-2.5 py-0.5 text-xs text-neutral-600 dark:border-neutral-700 dark:text-neutral-300">{stateLine}</span>
      </div>
      {note ? <Banner tone={note.tone}>{note.text}</Banner> : null}
      {!draft ? (
        <Banner tone="info">
          {canEdit ? "No strategy yet. Press Propose with Vizzy: it drafts one from your brand map, your site and your competitors for you to check." : "No strategy yet. An admin proposes and approves it."}
        </Banner>
      ) : null}

      <Section title="Who it's for">
        <div className="space-y-1.5">
          <span className={smallLabel}>Audiences</span>
          <div className="flex flex-wrap gap-1.5">
            {(draft?.audiences ?? []).map((a) => (
              <span key={a} className="inline-flex items-center gap-1 rounded-full bg-neutral-100 py-0.5 pl-2.5 pr-1 text-xs dark:bg-neutral-800">
                {a}
                {editable ? <RemoveButton label={`Remove ${a}`} disabled={busy} onClick={() => void edit({ audiences: (draft?.audiences ?? []).filter((x) => x !== a) })} /> : null}
              </span>
            ))}
            {!draft?.audiences.length ? <span className="text-xs text-neutral-500">None yet. Audiences come from the names on Who you are.</span> : null}
          </div>
          {editable && (draft?.audiences.length ?? 0) < L.audiences ? (
            <AddLine label="Add an audience" placeholder="Agencies with several clients" maxLength={L.audienceText} disabled={busy} onAdd={(t) => void edit({ audiences: [...(draft?.audiences ?? []), t] })} />
          ) : null}
        </div>
        <div className="space-y-1.5">
          <span className={smallLabel}>
            Focus situations ({L.focusMin} to {L.focusMax})
          </span>
          {!view.situations.length ? <p className="text-xs text-neutral-500">No buying situations on the map yet. Add them on the Buying situations tab.</p> : null}
          <ul className="space-y-1">
            {view.situations.map((s) => (
              <li key={s.id} className="flex items-start gap-2 text-sm">
                <button
                  type="button"
                  disabled={!editable || busy}
                  aria-pressed={s.focus}
                  aria-label={s.focus ? "A focus situation: on" : "Make this a focus situation"}
                  onClick={() => star(s.id)}
                  className="mt-0.5 rounded p-0.5 text-amber-500 disabled:opacity-60"
                >
                  <Star size={15} fill={s.focus ? "currentColor" : "none"} />
                </button>
                <span className="min-w-0 flex-1">{s.text}</span>
                <span className="shrink-0 text-xs text-neutral-500">
                  {s.questions} {s.questions === 1 ? "question" : "questions"} · {s.answered} live
                </span>
              </li>
            ))}
          </ul>
        </div>
      </Section>

      <Section
        title="Who you compete with"
        aside={
          canEdit && view.finder.on ? (
            <span className="flex flex-wrap items-center gap-2">
              <Button disabled={busy || (!view.finder.granted && view.finder.quickUsed)} onClick={() => void find("quick")}>
                Find competitors
              </Button>
              {view.finder.granted ? (
                <Button disabled={busy} onClick={() => void find("full")}>
                  Full search
                </Button>
              ) : null}
            </span>
          ) : null
        }
      >
        {view.finder.on ? (
          <p className="text-[11px] text-neutral-500">{finderNote(view.finder)}</p>
        ) : null}
        {live ? (
          <>
            {!watchedGroups.length && !suggestions.length ? <p className="text-xs text-neutral-500">No competitors yet. Watch one on Brand › Competitors, or press Find competitors.</p> : null}
            {watchedGroups.map((g) => (
              <div key={g.key} className="space-y-1">
                <span className={smallLabel}>{g.label}</span>
                <ul className="space-y-1 text-sm">
                  {g.list.map((c) => (
                    <li key={c.id ?? c.name} className="space-y-0.5">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span>{c.name}</span>
                        <span className="text-xs text-green-700 dark:text-green-400">
                          ✓ watched
                          {c.id && profiles.get(c.id)?.read ? ` · ${profiles.get(c.id)!.read} ${profiles.get(c.id)!.read === 1 ? "article" : "articles"} read` : ""}
                        </span>
                        {c.id ? <CompetitorGroupPicker id={c.id} name={c.name} group={c.group} canEdit={canEdit} onSaved={() => void load()} onError={(text) => setNote({ tone: "err", text })} /> : null}
                      </span>
                      {c.id && profiles.get(c.id)?.line ? <p className="text-xs text-neutral-500">{profiles.get(c.id)!.line}</p> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {suggestions.length ? (
              <div className="space-y-1">
                <span className={smallLabel}>Suggested by the finder</span>
                <ul className="space-y-1 text-sm">
                  {suggestions.map((c) => (
                    <li key={c.name} className="flex flex-wrap items-center gap-1.5" title={c.evidence.map((e) => e.title || e.domain).join(" · ") || undefined}>
                      <span>{c.name}</span>
                      {c.site ? <span className="text-xs text-neutral-500">{c.site}</span> : null}
                      {c.group ? <span className="text-[11px] text-neutral-500">· {COMPETITOR_GROUP_LABEL[c.group]}</span> : null}
                      {c.foundTimes > 1 ? <span className="text-[11px] text-neutral-500">named {c.foundTimes} times</span> : null}
                      {canEdit && c.site ? (
                        <button type="button" disabled={busy} className={SMALL} onClick={() => void monitor(c)}>
                          Monitor
                        </button>
                      ) : null}
                      {canEdit ? (
                        <button type="button" disabled={busy} className={SMALL} onClick={() => void notCompetitor(c)}>
                          Not a competitor
                        </button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        ) : null}
        {!live && !groups.length ? <p className="text-xs text-neutral-500">No competitors yet.</p> : null}
        {(live ? [] : groups).map((g) => (
          <div key={g.kind} className="space-y-1">
            <span className={smallLabel}>{COMPETITOR_GROUP_LABEL[g.kind]}</span>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {g.list.map((c) => (
                <li key={c.name} className="flex items-center gap-1.5" title={c.evidence.map((e) => e.title || e.domain).join(" · ") || undefined}>
                  <span>{c.name}</span>
                  {c.foundTimes > 1 ? <span className="text-[11px] text-neutral-500">named {c.foundTimes} times</span> : null}
                  {c.monitored ? (
                    <span className="text-xs text-green-700 dark:text-green-400">✓ monitored</span>
                  ) : editable && view.canMonitor && c.site ? (
                    <button type="button" disabled={busy} className={SMALL} onClick={() => void monitor(c)}>
                      Monitor
                    </button>
                  ) : editable ? (
                    <label className="flex items-center gap-1 text-[11px] text-neutral-500">
                      <input type="checkbox" checked={c.ticked} disabled={busy} onChange={(e) => void edit({ ticked: [{ name: c.name, ticked: e.target.checked }] })} />
                      Tick
                    </label>
                  ) : null}
                  {view.joined && canEdit && c.from === "finder" && !c.monitored ? (
                    <button type="button" disabled={busy} className={SMALL} onClick={() => void notCompetitor(c)}>
                      Not a competitor
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </Section>

      {against && (against.rows.length || against.onlyThem || against.namedNotWatched.length) ? (
        <Section title="Against your competitors" aside={<span className="text-[11px] text-neutral-500">Last {theirs?.days ?? 90} days</span>}>
          <p className="text-[11px] text-neutral-500">{AGAINST_FROM[against.from]}</p>
          {theirs?.truncated ? <p className="text-[11px] text-amber-700 dark:text-amber-400">{TRUNCATED_NOTE}</p> : null}
          {against.rows.length ? (
            <ul className="space-y-1.5 text-sm">
              {against.rows.map((r) => (
                <li key={r.id} className="grid gap-x-3 gap-y-0.5 sm:grid-cols-[minmax(0,1fr)_9rem_9rem_auto] sm:items-baseline">
                  <span className="min-w-0">{r.text}</span>
                  <span className="text-xs text-neutral-600 dark:text-neutral-300">
                    Them: {r.they}
                    {r.byCompetitor[0] ? ` (${r.byCompetitor[0].name} ${r.byCompetitor[0].count})` : ""}
                  </span>
                  <span className="text-xs text-neutral-600 dark:text-neutral-300">
                    You: {r.answered} of {r.questions} answered
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span className={`rounded px-1.5 py-0.5 font-medium ${FLAG_TEXT[r.flag].tone}`}>{FLAG_TEXT[r.flag].label}</span>
                    {r.newSince ? <span className="text-neutral-500">+{r.newSince} since approved</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {against.onlyThem ? (
            <p className="text-xs text-neutral-600 dark:text-neutral-300">
              Subjects only they write on: {against.onlyThem} ·{" "}
              <Link href={`${BRAND_KIT_COMPETITORS_ROUTE}/coverage`} className="underline">
                see what they write about
              </Link>
            </p>
          ) : null}
          {against.namedNotWatched.length ? (
            <p className="text-xs text-neutral-600 dark:text-neutral-300">
              On your map, not watched, named by them:{" "}
              {against.namedNotWatched.map((n, i) => (
                <span key={n.name}>
                  {i ? ", " : ""}
                  {n.name} ({n.count} {n.count === 1 ? "article" : "articles"})
                  {canEdit ? (
                    <>
                      {" "}
                      <Link href={`${BRAND_KIT_COMPETITORS_ROUTE}?name=${encodeURIComponent(n.name)}`} className="underline">
                        Monitor
                      </Link>
                    </>
                  ) : null}
                </span>
              ))}
            </p>
          ) : null}
        </Section>
      ) : null}

      <Section title="Where you win, and where they do">
        {!claims.length ? <p className="text-xs text-neutral-500">No claims yet.</p> : null}
        <ul className="space-y-1.5">
          {claims.map((c) => {
            const kind = claimShown(c);
            const editing = claimEdit?.id === c.id;
            return (
              <li key={c.id} className="flex items-start gap-2 text-sm">
                <span className={`mt-0.5 w-11 shrink-0 rounded px-1.5 py-0.5 text-center text-[11px] font-medium ${KIND_TONE[kind]}`}>{KIND_LABEL[kind]}</span>
                {editing ? (
                  <span className="flex min-w-0 flex-1 gap-2">
                    <input aria-label="The claim" className={inputClass} maxLength={L.claimText} value={claimEdit.text} onChange={(e) => setClaimEdit({ id: c.id, text: e.target.value })} />
                    <Button
                      disabled={busy || !claimEdit.text.trim()}
                      onClick={() => {
                        const text = claimEdit.text.trim();
                        void edit({ claims: claimBody(claims.map((x) => (x.id === c.id ? { ...x, text } : x))) }).then((ok) => ok && setClaimEdit(null));
                      }}
                    >
                      Save
                    </Button>
                    <Button onClick={() => setClaimEdit(null)}>Cancel</Button>
                  </span>
                ) : (
                  <span className="min-w-0 flex-1">
                    {c.competitor && c.side === "them" ? `${c.competitor}: ` : ""}
                    {c.text}{" "}
                    {c.proof ? (
                      <a href={c.proof.url} target="_blank" rel="noreferrer" className="text-xs text-neutral-500 underline">
                        proof: {pathOf(c.proof.url)}
                      </a>
                    ) : (
                      <span className="text-xs text-amber-700 dark:text-amber-400">{GAP_LABEL}</span>
                    )}
                  </span>
                )}
                {editable && !editing ? (
                  <span className="flex shrink-0 gap-1">
                    <button type="button" className={SMALL} disabled={busy} onClick={() => setClaimEdit({ id: c.id, text: c.text })}>
                      Edit
                    </button>
                    <RemoveButton label="Remove this claim" disabled={busy} onClick={() => void edit({ claims: claimBody(claims.filter((x) => x.id !== c.id)) })} />
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
        {editable && claims.length < L.claims ? (
          <AddLine label="Add a claim" placeholder="Where you win, in a few words" maxLength={L.claimText} disabled={busy} onAdd={(t) => void edit({ claims: [...claimBody(claims), { side: "you", text: t }] })} />
        ) : null}
        <p className="text-[11px] text-neutral-500">A claim without proof shows as a gap to close, never as fact. A fact about your product links to the public page or doc that shows it.</p>
      </Section>

      <Section title="What you say · What you're not">
        <dl className="grid gap-1 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
          <dt className="text-neutral-500">Category</dt>
          <dd>{view.identity.category || "Not set"}</dd>
          <dt className="text-neutral-500">What you are</dt>
          <dd>{view.identity.statement || "Not set"}</dd>
          <dt className="text-neutral-500">What you&apos;re not</dt>
          <dd>{view.identity.isNot.length ? view.identity.isNot.join(" · ") : "None yet"}</dd>
          {view.identity.avoid.length ? (
            <>
              <dt className="text-neutral-500">Words you avoid</dt>
              <dd>{view.identity.avoid.map((a) => a.term).join(" · ")}</dd>
            </>
          ) : null}
        </dl>
        <p className="text-[11px] text-neutral-500">Change these on Who you are.</p>
        {proposedNot.length ? (
          <ul className="space-y-1">
            {proposedNot.map((x) => (
              <li key={x.text} className="flex flex-wrap items-center gap-2 text-sm">
                <span>
                  Proposed: &ldquo;{x.text}&rdquo;{x.why ? <span className="text-xs text-neutral-500"> ({x.why})</span> : null}
                </span>
                {canEdit ? (
                  <span className="flex gap-1">
                    <button type="button" className={SMALL} disabled={busy} onClick={() => void run(`${STRATEGY}/is-not`, { method: "POST", body: JSON.stringify({ baseRev: view.rev, text: x.text, accept: true }) }, () => `Added to Who you are: ${x.text}.`)}>
                      Add
                    </button>
                    <button type="button" className={SMALL} disabled={busy} onClick={() => void run(`${STRATEGY}/is-not`, { method: "POST", body: JSON.stringify({ baseRev: view.rev, text: x.text, accept: false }) })}>
                      No
                    </button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      <Section
        title="The quarter's goal"
        aside={
          editable && !goalEdit ? (
            <button type="button" className={SMALL} disabled={busy} onClick={() => setGoalEdit({ text: draft?.goal?.text ?? "", measure: draft?.goal?.measure ?? "" })}>
              Edit
            </button>
          ) : null
        }
      >
        {goalEdit ? (
          <div className="space-y-2">
            <input aria-label="The goal" className={inputClass} maxLength={L.goalText} placeholder="200 waitlist sign-ups from organic search by March" value={goalEdit.text} onChange={(e) => setGoalEdit({ ...goalEdit, text: e.target.value })} />
            <input aria-label="How we'll know" className={inputClass} maxLength={L.measureText} placeholder="How we'll know, such as sign-ups" value={goalEdit.measure} onChange={(e) => setGoalEdit({ ...goalEdit, measure: e.target.value })} />
            <span className="flex gap-2">
              <Button
                tone="primary"
                disabled={busy}
                onClick={() => void edit({ goal: goalEdit.text.trim() ? { text: goalEdit.text.trim(), measure: goalEdit.measure.trim() } : null }).then((ok) => ok && setGoalEdit(null))}
              >
                Save goal
              </Button>
              <Button onClick={() => setGoalEdit(null)}>Cancel</Button>
            </span>
          </div>
        ) : draft?.goal ? (
          <p className="text-sm">
            &ldquo;{draft.goal.text}&rdquo;{draft.goal.measure ? <span className="text-neutral-500"> · measure: {draft.goal.measure}</span> : null}
          </p>
        ) : (
          <p className="text-xs text-neutral-500">No goal yet.</p>
        )}
        {!draft?.goal && (view.goalStart.want || view.goalStart.goals.length) ? (
          <p className="text-[11px] text-neutral-500">
            It starts from what you told Vizzy: {[view.goalStart.want, ...view.goalStart.goals].filter(Boolean).join("; ")}.
          </p>
        ) : null}
      </Section>

      {draft?.sources.length ? <p className="text-[11px] text-neutral-500">Made from: {draft.sources.map((s) => STRATEGY_SOURCE_LABEL[s]).join(", ")}.</p> : null}

      {canEdit ? (
        <div className="flex flex-wrap items-center gap-2">
          {view.canPropose ? (
            <Button disabled={busy} onClick={() => void run(`${STRATEGY}/propose`, { method: "POST" }, (d) => `${PROPOSED_NOTE}${droppedNote(d.dropped)}`)}>
              {busy ? "Working…" : "Propose with Vizzy"}
            </Button>
          ) : null}
          <Button tone="primary" disabled={busy || !draft || view.state === "approved"} onClick={() => void run(`${STRATEGY}/approve`, { method: "POST", body: JSON.stringify({ baseRev: view.rev }) }, () => APPROVED_NOTE)}>
            Approve strategy
          </Button>
          {view.state !== "none" ? (
            <Button
              tone="danger"
              disabled={busy}
              onClick={() => {
                if (window.confirm("Start over? The strategy, the ones approved before and what people decided go. Your brand map stays as it is.")) void run(STRATEGY, { method: "DELETE" });
              }}
            >
              Start over
            </Button>
          ) : null}
        </div>
      ) : null}

      {contentPlan ? <BrandMapContentPlan canEdit={canEdit} /> : null}
    </div>
  );
}
