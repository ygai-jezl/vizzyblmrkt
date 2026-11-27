"use client";

import { useCallback, useEffect, useState } from "react";
import type { ContentPlanView, ViewEntry } from "@/lib/contentStrategy/adminApi";
import { CONTENT_STRATEGY_LIMITS as L, PAGE_KIND_LABEL, type ContentStage, type PageKind } from "@/lib/types/contentStrategy";
import { api } from "@/components/admin/connect/api";
import { Banner, Button, inputClass } from "@/components/admin/connect/ui";
import { smallLabel } from "./BrandMapParts";
import { NOT_ARTICLES_LABEL, PLAN_APPROVED_NOTE, PLAN_APPROVED_QUIET_NOTE, hubLine, madeNote, planErrorText } from "./contentPlanMessages";

/**
 * The Content plan section of the Strategy tab (CONTENT_STRATEGY_ENABLED): the brand's plan for the
 * quarter. Its pillars with what is live and each hub, the next three weeks of the roadmap with why,
 * the funnel mix against the brand's questions today, and the pages that aren't articles. Members
 * read it; admins make it, change it (rename a pillar, move or skip a pick, split or join slots) and
 * approve it. Each change saves at once, naming the revision it started from.
 */

const PLAN = "/api/admin/brand-kit/map/strategy/content";
const SMALL = "rounded border border-neutral-300 px-2 py-0.5 text-[11px] hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";
const CARD = "space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800";
const HINT = "text-[11px] text-neutral-500";

type Note = { tone: "ok" | "err" | "info"; text: string };
type Reply = { plan?: ContentPlanView; error?: string; notes?: { lookupsAsked?: number; byMeaning?: boolean; leftOut?: number } };
type PillarSlot = { id: string; title: string; kind: PageKind; stage: ContentStage; live: number; questions: Array<{ id: string; text: string }> };

const ACTION_LABEL: Record<ViewEntry["action"], string> = { write: "", refresh: "Refresh: ", combine: "Combine: " };
const MONTH = (m: string) => {
  const d = new Date(`${m}-01T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? m : d.toLocaleDateString(undefined, { month: "short", timeZone: "UTC" });
};
const day = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
};
const wk = (w: string) => `Wk ${w.slice(-2)}`;

function Funnel({ view }: { view: ContentPlanView }) {
  const t = view.funnel.target;
  const q = view.funnel.questions;
  return (
    <p className="text-xs text-neutral-700 dark:text-neutral-300">
      <span className="font-medium">Funnel</span> learn {t.learn}% · consider {t.consider}% · choose {t.choose}%{" "}
      <span className={HINT}>
        (your questions today: {q.learn} · {q.consider} · {q.choose})
      </span>
    </p>
  );
}

function PillarSlots({ pillarId, canEdit, busy, onEdit }: { pillarId: string; canEdit: boolean; busy: boolean; onEdit: (patch: Record<string, unknown>) => Promise<boolean> }) {
  const [slots, setSlots] = useState<PillarSlot[] | null>(null);
  const [joining, setJoining] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await api<{ slots?: PillarSlot[] }>(`${PLAN}?pillar=${encodeURIComponent(pillarId)}`);
    setSlots(r.ok ? (r.data.slots ?? []) : []);
  }, [pillarId]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!slots) return <p className={HINT}>Loading…</p>;
  if (!slots.length) return <p className={HINT}>No slots in this pillar.</p>;
  const act = async (patch: Record<string, unknown>) => {
    if (await onEdit(patch)) await load();
  };
  return (
    <ul className="space-y-2 border-l border-neutral-200 pl-3 dark:border-neutral-800">
      {slots.map((s) => (
        <li key={s.id} className="space-y-1 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{s.title}</span>
            <span className={HINT}>
              {PAGE_KIND_LABEL[s.kind]} · {s.stage}
              {s.live ? ` · ${s.live} live` : ""}
            </span>
            {canEdit ? (
              joining === s.id ? (
                <select
                  aria-label="Join with"
                  className="rounded border border-neutral-300 px-1 py-0.5 text-[11px] dark:border-neutral-700 dark:bg-neutral-900"
                  disabled={busy}
                  defaultValue=""
                  onChange={(e) => {
                    setJoining(null);
                    if (e.target.value) void act({ op: "join", slotId: e.target.value, intoSlotId: s.id });
                  }}
                >
                  <option value="">Join which slot into this one?</option>
                  {slots
                    .filter((x) => x.id !== s.id && x.questions.length + s.questions.length <= L.questionsPerSlot)
                    .map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.title}
                      </option>
                    ))}
                </select>
              ) : (
                <button type="button" className={SMALL} disabled={busy} onClick={() => setJoining(s.id)}>
                  Join
                </button>
              )
            ) : null}
          </div>
          {s.questions.length > 1 ? (
            <ul className="space-y-0.5 pl-3">
              {s.questions.map((q) => (
                <li key={q.id} className="flex items-center gap-2 text-neutral-600 dark:text-neutral-400">
                  <span>{q.text}</span>
                  {canEdit ? (
                    <button type="button" className={SMALL} disabled={busy} onClick={() => void act({ op: "split", slotId: s.id, questionId: q.id })}>
                      Split
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function BrandMapContentPlan({ canEdit }: { canEdit: boolean }) {
  const [view, setView] = useState<ContentPlanView | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [skipping, setSkipping] = useState<{ slotId: string; reason: string } | null>(null);

  const load = useCallback(async () => {
    const r = await api<Reply>(PLAN);
    if (r.ok && r.data.plan) setView(r.data.plan);
    else setNote({ tone: "err", text: planErrorText(r.data) });
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  /** Run a request; on success show the plan it sends back, else say why and read it again. */
  async function run(path: string, init: RequestInit, done?: (data: Reply) => string): Promise<boolean> {
    setBusy(true);
    setNote(null);
    const r = await api<Reply>(path, init);
    setBusy(false);
    if (r.ok && r.data.plan) {
      setView(r.data.plan);
      if (done) setNote({ tone: "ok", text: done(r.data) });
      return true;
    }
    setNote({ tone: "err", text: planErrorText(r.data) });
    await load();
    return false;
  }
  const edit = (patch: Record<string, unknown>) => run(PLAN, { method: "PUT", body: JSON.stringify({ baseRev: view?.rev ?? 0, ...patch }) });

  if (!view) return <p className={HINT}>{note ? note.text : "Loading…"}</p>;
  const has = view.state !== "none";
  const stateLine =
    view.state === "approved" && view.approved
      ? `approved ${day(view.approved.at)}`
      : view.state === "changed"
        ? "changed since it was approved · not approved"
        : view.state === "draft"
          ? "draft · not approved"
          : "no plan yet";
  const laterWeek = (e: ViewEntry) => view.weeks[view.weeks.indexOf(e.week) + 1] ?? null;
  const weeks = [...new Set(view.next.map((e) => e.week))];

  return (
    <section className={CARD} aria-label="Content plan">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">
          Content plan{view.firstWeek ? ` · 12 weeks from ${wk(view.firstWeek)}` : ""} · <span className="font-normal text-neutral-500">{stateLine}</span>
        </h2>
        {canEdit ? (
          <span className="flex flex-wrap items-center gap-2">
            <Button disabled={busy} onClick={() => void run(`${PLAN}/make`, { method: "POST" }, (d) => madeNote(d.notes))}>
              {busy ? "Working…" : "Make the plan"}
            </Button>
            <Button
              tone="primary"
              disabled={busy || (view.state !== "draft" && view.state !== "changed")}
              onClick={() => void run(`${PLAN}/approve`, { method: "POST", body: JSON.stringify({ baseRev: view.rev }) }, (d) => (d.plan?.feedsNextUp ? PLAN_APPROVED_NOTE : PLAN_APPROVED_QUIET_NOTE))}
            >
              Approve plan
            </Button>
          </span>
        ) : null}
      </div>
      <p className="max-w-2xl text-xs text-neutral-600 dark:text-neutral-300">
        Your questions merged into the articles they belong in, grouped into pillars, and the next 12 weeks of what to write, refresh or combine.
        {view.feedsNextUp ? " Once approved, Next up takes 3 of every 4 picks from it." : ""}
      </p>
      {note ? <Banner tone={note.tone}>{note.text}</Banner> : null}
      {!has ? (
        <Banner tone="info">{canEdit ? "No plan yet. Press Make the plan: it reads your brand map, your strategy and your articles." : "No plan yet. An admin makes and approves it."}</Banner>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <span className={smallLabel}>Pillars</span>
              <ul className="space-y-1.5">
                {view.pillars.map((p) => (
                  <li key={p.id} className="space-y-1 text-sm">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      {renaming?.id === p.id ? (
                        <span className="flex gap-1">
                          <input aria-label="Pillar name" className={inputClass} maxLength={L.pillarName} value={renaming.name} onChange={(e) => setRenaming({ id: p.id, name: e.target.value })} />
                          <Button disabled={busy || !renaming.name.trim()} onClick={() => void edit({ op: "rename_pillar", pillarId: p.id, name: renaming.name.trim() }).then((ok) => ok && setRenaming(null))}>
                            Save
                          </Button>
                          <Button onClick={() => setRenaming(null)}>Cancel</Button>
                        </span>
                      ) : (
                        <button type="button" className="text-left font-medium hover:underline" aria-expanded={open === p.id} onClick={() => setOpen(open === p.id ? null : p.id)}>
                          {p.name}
                        </button>
                      )}
                      <span className={HINT}>
                        {p.live} live · {p.open} to write · {hubLine(p)}
                        {p.focus.length ? ` · focus ${p.focus.map(MONTH).join(", ")}` : ""}
                      </span>
                      {canEdit && renaming?.id !== p.id ? (
                        <button type="button" className={SMALL} disabled={busy} onClick={() => setRenaming({ id: p.id, name: p.name })}>
                          Rename
                        </button>
                      ) : null}
                    </div>
                    {p.about ? <p className={HINT}>{p.about}</p> : null}
                    {open === p.id ? <PillarSlots pillarId={p.id} canEdit={canEdit} busy={busy} onEdit={edit} /> : null}
                  </li>
                ))}
              </ul>
            </div>
            <div className="space-y-1.5">
              <span className={smallLabel}>Next {weeks.length || 3} weeks</span>
              {!view.next.length ? <p className={HINT}>Nothing on the roadmap for the coming weeks.</p> : null}
              <ul className="space-y-2">
                {view.next.map((e) => (
                  <li key={`${e.week}-${e.slotId}`} className="space-y-0.5 text-sm">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="w-12 shrink-0 text-xs text-neutral-500">{wk(e.week)}</span>
                      <span className="min-w-0 flex-1">
                        {ACTION_LABEL[e.action]}
                        {e.title}
                        {e.live.length && e.action !== "write" ? <span className={HINT}> ({e.live.length} live)</span> : null}
                      </span>
                      <span className={HINT}>{e.action === "write" ? `${PAGE_KIND_LABEL[e.kind]} · ${e.stage}` : e.action}</span>
                    </div>
                    {e.why.length ? <p className={`pl-14 ${HINT}`}>{e.why.slice(0, 3).join(" · ")}</p> : null}
                    {e.live.length && e.action !== "write" ? (
                      <p className={`pl-14 ${HINT}`}>
                        {e.live.map((l, i) => (
                          <span key={`${l.title}-${i}`}>
                            {i ? " · " : ""}
                            {l.url ? (
                              <a href={l.url} target="_blank" rel="noreferrer" className="underline">
                                {l.title}
                              </a>
                            ) : (
                              l.title
                            )}
                          </span>
                        ))}
                      </p>
                    ) : null}
                    {canEdit ? (
                      skipping?.slotId === e.slotId ? (
                        <span className="flex flex-wrap items-center gap-1.5 pl-14">
                          <input
                            aria-label="Why skip it (optional)"
                            placeholder="Why skip it (optional)"
                            value={skipping.reason}
                            maxLength={L.decisionText}
                            onChange={(x) => setSkipping({ slotId: e.slotId, reason: x.target.value })}
                            className="w-56 rounded-md border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900"
                          />
                          <button type="button" className={SMALL} disabled={busy} onClick={() => void edit({ op: "skip", slotId: e.slotId, reason: skipping.reason.trim() }).then((ok) => ok && setSkipping(null))}>
                            Skip it
                          </button>
                          <button type="button" className={SMALL} onClick={() => setSkipping(null)}>
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <span className="flex gap-1 pl-14">
                          {laterWeek(e) ? (
                            <button type="button" className={SMALL} disabled={busy} onClick={() => void edit({ op: "move", slotId: e.slotId, week: laterWeek(e) })}>
                              A week later
                            </button>
                          ) : null}
                          <button type="button" className={SMALL} disabled={busy} onClick={() => setSkipping({ slotId: e.slotId, reason: "" })}>
                            Skip
                          </button>
                        </span>
                      )
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <Funnel view={view} />
          {view.notArticles.length ? (
            <p className="text-xs text-neutral-700 dark:text-neutral-300">
              <span className="font-medium">{NOT_ARTICLES_LABEL}:</span> {view.notArticles.map((n) => `${n.title} (${PAGE_KIND_LABEL[n.kind]})`).join(" · ")}
            </p>
          ) : null}
          <p className={HINT}>
            {view.counts.slots} slots from {view.counts.questions} questions · {view.counts.live} answered by a live article · {view.counts.open} to write
            {view.sources.length ? `. Made from: ${view.sources.join(", ")}.` : "."}
          </p>
          {canEdit ? (
            <div>
              <Button
                tone="danger"
                disabled={busy}
                onClick={() => {
                  if (window.confirm("Start over? The content plan, the ones approved before and what people decided go. Your brand map and strategy stay as they are.")) void run(PLAN, { method: "DELETE" });
                }}
              >
                Start over
              </Button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
