"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { BrandMapGroup, BrandMapQuestionRecord, BrandMapSubjectRecord, GroupTotals } from "@/lib/types/brandMapRecords";
import type { Coverage, SubjectCoverage } from "@/lib/content/blog/coverage";
import { api, errorText, type ApiResponse } from "@/components/admin/connect/api";
import { Banner, Button, inputClass } from "@/components/admin/connect/ui";
import { PageLink, QuestionStatus, WriteNext } from "./BrandMapCoverage";
import { matchSubjects, type SubjectName } from "./MapSubjectSearch";
import { useMapMove } from "./brandMapMove";

/**
 * The Subjects tab of a map at any size (BRAND_MAP_SCALE_ENABLED): groups on the left, a
 * group's subjects least answered first, and one subject's questions, home page and what
 * its pages answer. Proposals sit in place, dashed, to add or dismiss. Members see it all;
 * admins change it. The page moves the brand's subjects into their records the first time
 * an admin opens it (brandMapMove); this tab reads them again when that finishes.
 */

const MAP = "/api/admin/brand-kit/map";
const SMALL = "rounded border border-neutral-300 px-2 py-0.5 text-[11px] hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";

type View = { kind: "all" } | { kind: "none" } | { kind: "proposed" } | { kind: "group"; id: string } | { kind: "suggested"; id: string };

interface SubjectRead {
  subject: BrandMapSubjectRecord;
  questions: BrandMapQuestionRecord[];
  coverage: SubjectCoverage | null;
  overlaps: Coverage["overlaps"];
  missingLinks: Coverage["missingLinks"];
}

const pct = (answered: number, questions: number) => (questions ? Math.round((100 * answered) / questions) : 0);

/** One batch of "Sort into groups", as the route answers it. */
type SortStep = { done?: boolean; next?: string | null; suggested?: number; proposedGroups?: string[]; error?: string };

export function BrandMapSubjectsTab({
  canEdit,
  programmes,
  ungroupedTotals: ungroupedAtLoad,
}: {
  canEdit: boolean;
  /** The programmes an open question can be written in; null = not offered. */
  programmes: Array<{ id: string; name: string }> | null;
  ungroupedTotals: Partial<GroupTotals> | null;
}) {
  const { moved, progress, round } = useMapMove();
  const [note, setNote] = useState<{ tone: "ok" | "err" | "info"; text: string } | null>(null);
  const [view, setView] = useState<View>({ kind: "all" });
  const [groups, setGroups] = useState<BrandMapGroup[]>([]);
  const [ungroupedTotals, setUngroupedTotals] = useState(ungroupedAtLoad);
  const [subjects, setSubjects] = useState<BrandMapSubjectRecord[] | null>(null);
  const [names, setNames] = useState<SubjectName[] | null>(null);
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [open, setOpen] = useState<SubjectRead | null>(null);
  const [busy, setBusy] = useState(false);
  const [newSubject, setNewSubject] = useState("");
  const [newGroup, setNewGroup] = useState("");
  const [sorting, setSorting] = useState<string | null>(null);

  const loadGroups = useCallback(async () => {
    const r = await api<{ groups?: BrandMapGroup[]; ungrouped?: Partial<GroupTotals> | null }>(`${MAP}/groups`);
    if (r.ok && r.data.groups) setGroups(r.data.groups);
    if (r.ok && r.data.ungrouped !== undefined) setUngroupedTotals(r.data.ungrouped);
  }, []);

  const loadSubjects = useCallback(async (v: View) => {
    const q =
      v.kind === "group"
        ? `?group=${encodeURIComponent(v.id)}`
        : v.kind === "suggested"
          ? `?suggested=${encodeURIComponent(v.id)}`
          : v.kind === "none"
            ? "?group=none"
            : v.kind === "proposed"
              ? "?status=proposed"
              : "";
    const r = await api<{ subjects?: BrandMapSubjectRecord[] }>(`${MAP}/subjects${q}`);
    setSubjects(r.ok && r.data.subjects ? r.data.subjects : []);
  }, []);

  const loadNames = useCallback(() => {
    if (names) return;
    void api<{ subjects?: SubjectName[] }>(`${MAP}/subjects/names`).then((r) => setNames(r.data.subjects ?? []));
  }, [names]);

  const loadOpen = useCallback(async (id: string) => {
    const r = await api<SubjectRead & { error?: string }>(`${MAP}/subjects/${encodeURIComponent(id)}`);
    if (r.ok) setOpen(r.data);
    else {
      setOpen(null);
      setNote({ tone: "err", text: errorText(r.data) });
    }
  }, []);

  // Read again when the page's move (and its count) finishes: `round` goes up.
  useEffect(() => {
    if (!moved) return;
    void loadGroups();
  }, [moved, round, loadGroups]);
  useEffect(() => {
    if (!moved) return;
    setSubjects(null);
    void loadSubjects(view);
  }, [moved, round, view, loadSubjects]);
  useEffect(() => {
    if (openId) {
      void loadOpen(openId);
      // Names, for "looks like" and merging (read once).
      loadNames();
    } else setOpen(null);
  }, [openId, loadOpen, loadNames]);

  const refresh = useCallback(async () => {
    await Promise.all([loadGroups(), loadSubjects(view), openId ? loadOpen(openId) : Promise.resolve()]);
  }, [loadGroups, loadSubjects, loadOpen, view, openId]);

  async function act(run: () => Promise<{ ok: boolean; data: unknown }>, done?: string) {
    setBusy(true);
    setNote(null);
    const r = await run();
    setBusy(false);
    if (!r.ok) setNote({ tone: "err", text: errorText(r.data) });
    else if (done) setNote({ tone: "ok", text: done });
    await refresh();
    return r.ok;
  }

  const decide = (kind: "subjects" | "questions" | "groups", id: string, accept: boolean, done?: string) =>
    act(() => api(`${MAP}/proposals`, { method: "POST", body: JSON.stringify({ [accept ? "accept" : "dismiss"]: { [kind]: [id] } }) }), done);

  /** "Sort into groups": one research allowance, then a batch of subjects in no group per step. */
  async function sortIntoGroups() {
    setBusy(true);
    setNote(null);
    const start = await api<{ run?: { id: string }; error?: string }>(`${MAP}/runs`, { method: "POST", body: JSON.stringify({ kind: "groups" }) });
    if (!start.ok || !start.data.run) {
      setBusy(false);
      setNote({ tone: "err", text: errorText(start.data) });
      return;
    }
    let cursor: string | null = null;
    let suggested = 0;
    const made: string[] = [];
    for (let batch = 1; batch <= 40; batch += 1) {
      setSorting(`Sorting your subjects into groups (batch ${batch})…`);
      const r: ApiResponse<SortStep> = await api<SortStep>(`${MAP}/groups/sort`, {
        method: "POST",
        body: JSON.stringify({ runId: start.data.run.id, cursor }),
      });
      if (!r.ok) {
        setNote({ tone: "err", text: errorText(r.data) });
        break;
      }
      suggested += r.data.suggested ?? 0;
      made.push(...(r.data.proposedGroups ?? []));
      if (r.data.done || !r.data.next) {
        setNote(
          suggested
            ? {
                tone: "ok",
                text: `Suggested a group for ${suggested} subject${suggested === 1 ? "" : "s"}${made.length ? `, with ${made.length} new group${made.length === 1 ? "" : "s"} proposed` : ""}. Nothing has moved: add the groups you want, below.`,
              }
            : { tone: "info", text: "None of the subjects in no group fit a group yet." },
        );
        break;
      }
      cursor = r.data.next;
    }
    setSorting(null);
    setBusy(false);
    await refresh();
  }

  const sorted = useMemo(
    () =>
      [...(subjects ?? [])].sort(
        (a, b) => Number(b.status === "proposed") - Number(a.status === "proposed") || a.answeredShare - b.answeredShare || a.name.localeCompare(b.name),
      ),
    [subjects],
  );
  const found = useMemo(() => (names && query.trim() ? matchSubjects(names, query, 20) : []), [names, query]);
  const groupName = (id: string | null) => (id ? (groups.find((g) => g.id === id)?.name ?? "A group") : "Ungrouped");
  const decidedGroups = groups.filter((g) => g.status === "decided");
  const proposedGroups = groups.filter((g) => g.status === "proposed");
  // The group being looked at, and the subjects suggested for it.
  const shown = view.kind === "group" || view.kind === "suggested" ? (groups.find((g) => g.id === view.id) ?? null) : null;

  if (!moved) {
    // The page says how the move is going.
    return progress ? null : <Banner tone="info">Your subjects move here the first time an admin opens this page.</Banner>;
  }

  return (
    <div className="space-y-4">
      {sorting ? (
        <p role="status" className="text-xs text-neutral-500">
          {sorting}
        </p>
      ) : null}
      {note ? <Banner tone={note.tone}>{note.text}</Banner> : null}

      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-[14rem] flex-1">
          <span className="sr-only">Find a subject</span>
          <input
            type="search"
            value={query}
            onFocus={loadNames}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a subject"
            className={inputClass}
          />
        </label>
        {canEdit ? (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const name = newSubject.trim();
              if (!name) return;
              void act(() => api(`${MAP}/subjects`, { method: "POST", body: JSON.stringify({ name, groupId: view.kind === "group" ? view.id : null }) }), `Added “${name}”.`).then(
                (ok) => ok && setNewSubject(""),
              );
            }}
          >
            <input aria-label="A new subject" value={newSubject} onChange={(e) => setNewSubject(e.target.value)} placeholder="A new subject" maxLength={80} className={inputClass} />
            <Button type="submit" tone="primary" disabled={busy || !newSubject.trim()}>
              Add
            </Button>
          </form>
        ) : null}
      </div>
      {found.length ? (
        <ul aria-label="Matching subjects" className="flex flex-wrap gap-1.5">
          {found.map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => setOpenId(s.id)} className={SMALL}>
                {s.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="grid items-start gap-4 lg:grid-cols-[14rem_minmax(0,1fr)_minmax(0,1.2fr)]">
        <nav aria-label="Groups" className="space-y-1">
          {[
            { key: "all", label: "All subjects", view: { kind: "all" } as View, meta: null as string | null },
            { key: "proposed", label: "Proposed", view: { kind: "proposed" } as View, meta: null },
            {
              key: "none",
              label: "Ungrouped",
              view: { kind: "none" } as View,
              meta: ungroupedTotals ? `${ungroupedTotals.subjects ?? 0} subjects · ${ungroupedTotals.answered ?? 0} of ${ungroupedTotals.questions ?? 0} answered` : null,
            },
            ...decidedGroups.map((g) => ({
              key: g.id,
              label: g.name,
              view: { kind: "group", id: g.id } as View,
              meta: `${g.totals.subjects} subjects · ${g.totals.answered} of ${g.totals.questions} answered${g.suggested ? ` · ${g.suggested} suggested` : ""}`,
            })),
          ].map((item) => {
            const on = JSON.stringify(item.view) === JSON.stringify(view);
            return (
              <button
                key={item.key}
                type="button"
                aria-pressed={on}
                onClick={() => setView(item.view)}
                className={`block w-full rounded-md border px-2.5 py-1.5 text-left ${on ? "border-neutral-900 bg-neutral-50 dark:border-white dark:bg-neutral-900" : "border-neutral-200 dark:border-neutral-800"}`}
              >
                <span className="block text-sm">{item.label}</span>
                {item.meta ? <span className="block text-[11px] text-neutral-500">{item.meta}</span> : null}
              </button>
            );
          })}
          {canEdit ? (
            <form
              className="flex gap-1.5 pt-1"
              onSubmit={(e) => {
                e.preventDefault();
                const name = newGroup.trim();
                if (!name) return;
                void act(() => api(`${MAP}/groups`, { method: "POST", body: JSON.stringify({ name }) })).then((ok) => ok && setNewGroup(""));
              }}
            >
              <input aria-label="A new group" value={newGroup} onChange={(e) => setNewGroup(e.target.value)} placeholder="A new group" maxLength={80} className={`${inputClass} text-xs`} />
              <button type="submit" disabled={busy || !newGroup.trim()} className={SMALL}>
                Add
              </button>
            </form>
          ) : null}
          {canEdit ? (
            <button type="button" disabled={busy} onClick={() => void sortIntoGroups()} className={`${SMALL} w-full`}>
              Sort into groups
            </button>
          ) : null}
          {proposedGroups.length ? (
            <div className="space-y-1 pt-2">
              <span className="block text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Proposed groups</span>
              {proposedGroups.map((g) => {
                const on = view.kind === "suggested" && view.id === g.id;
                return (
                  <div key={g.id} className={`rounded-md border border-dashed px-2.5 py-1.5 ${on ? "border-neutral-900 dark:border-white" : "border-neutral-400"}`}>
                    <button type="button" aria-pressed={on} onClick={() => setView({ kind: "suggested", id: g.id })} className="block w-full text-left">
                      <span className="block text-sm">{g.name}</span>
                      <span className="block text-[11px] text-neutral-500">
                        {g.suggested} subject{g.suggested === 1 ? "" : "s"} would move here
                      </span>
                    </button>
                    {canEdit ? (
                      <span className="mt-1 flex gap-1.5">
                        <button type="button" disabled={busy} onClick={() => void decide("groups", g.id, true, `Added “${g.name}”, with the subjects suggested for it.`)} className={SMALL}>
                          Add
                        </button>
                        <button type="button" disabled={busy} onClick={() => void decide("groups", g.id, false)} className={SMALL}>
                          Dismiss
                        </button>
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
        </nav>

        <section aria-label="Subjects" className="min-w-0 space-y-1.5">
          {shown && shown.status === "decided" && shown.suggested > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-dashed border-neutral-400 px-2.5 py-1.5 text-xs">
              <span className="flex-1">
                {shown.suggested} subject{shown.suggested === 1 ? " is" : "s are"} suggested for {shown.name}.
              </span>
              <button type="button" onClick={() => setView(view.kind === "suggested" ? { kind: "group", id: shown.id } : { kind: "suggested", id: shown.id })} className={SMALL}>
                {view.kind === "suggested" ? "Back to the group" : "See them"}
              </button>
              {canEdit ? (
                <>
                  <button type="button" disabled={busy} onClick={() => void decide("groups", shown.id, true, `Moved them into “${shown.name}”.`)} className={SMALL}>
                    Move them here
                  </button>
                  <button type="button" disabled={busy} onClick={() => void decide("groups", shown.id, false)} className={SMALL}>
                    Dismiss
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
          {view.kind === "suggested" && shown?.status === "proposed" ? (
            <div className="text-[11px] text-neutral-500">Suggested for the proposed group “{shown.name}”. Nothing moves until you add it.</div>
          ) : null}
          <div className="text-[11px] text-neutral-500">Least answered first. No limit on how many.</div>
          {subjects === null ? <p className="text-xs text-neutral-500">Loading…</p> : null}
          {subjects && !sorted.length ? <p className="text-xs text-neutral-500">Nothing here yet.</p> : null}
          {sorted.map((s) => {
            const proposed = s.status === "proposed";
            return (
              <div key={s.id} className={`rounded-md border p-2 ${openId === s.id ? "border-neutral-900 dark:border-white" : proposed ? "border-dashed border-neutral-400" : "border-neutral-200 dark:border-neutral-800"}`}>
                <button type="button" aria-pressed={openId === s.id} onClick={() => setOpenId(s.id)} className="flex w-full flex-wrap items-center gap-2 text-left">
                  <span className="min-w-0 flex-1 text-sm font-medium">{s.name}</span>
                  <span className="flex items-center gap-1.5 text-[11px] text-neutral-500">
                    <span aria-hidden className="inline-block h-1.5 w-16 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
                      <span className="block h-1.5 rounded-full bg-blue-600" style={{ width: `${pct(s.counts.answered, s.counts.questions)}%` }} />
                    </span>
                    {s.counts.answered} of {s.counts.questions} answered
                  </span>
                  {view.kind === "all" ? <span className="text-[11px] text-neutral-500">{groupName(s.groupId)}</span> : null}
                  {s.suggestedGroupId && view.kind !== "suggested" ? (
                    <span className="text-[11px] text-neutral-500">Suggested group: {groupName(s.suggestedGroupId)}</span>
                  ) : null}
                </button>
                {proposed ? (
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-500">
                    <span className="flex-1">{s.reason || `Proposed by ${s.from}`}</span>
                    {canEdit ? (
                      <>
                        <button type="button" disabled={busy} onClick={() => void decide("subjects", s.id, true)} className={SMALL}>
                          Add
                        </button>
                        <button type="button" disabled={busy} onClick={() => void decide("subjects", s.id, false)} className={SMALL}>
                          Dismiss
                        </button>
                      </>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </section>

        <aside aria-label="Subject" className="min-w-0">
          {open ? (
            <SubjectDetail
              key={`${open.subject.id}:${open.subject.rev}`}
              read={open}
              groups={groups}
              canEdit={canEdit}
              busy={busy}
              programmes={programmes}
              names={names}
              act={act}
              decide={decide}
              onGone={() => setOpenId(null)}
            />
          ) : (
            <p className="text-xs text-neutral-500">Choose a subject to see its questions and what your pages answer.</p>
          )}
        </aside>
      </div>
    </div>
  );
}

function SubjectDetail({
  read,
  groups,
  canEdit,
  busy,
  programmes,
  names,
  act,
  decide,
  onGone,
}: {
  read: SubjectRead;
  groups: BrandMapGroup[];
  canEdit: boolean;
  busy: boolean;
  programmes: Array<{ id: string; name: string }> | null;
  names: SubjectName[] | null;
  act: (run: () => Promise<{ ok: boolean; data: unknown }>, done?: string) => Promise<boolean>;
  decide: (kind: "subjects" | "questions", id: string, accept: boolean) => Promise<boolean>;
  onGone: () => void;
}) {
  const { subject, questions, coverage } = read;
  const [name, setName] = useState(subject.name);
  const [home, setHome] = useState(subject.home ?? "");
  const [question, setQuestion] = useState("");
  const [mergeQuery, setMergeQuery] = useState("");
  const path = `${MAP}/subjects/${encodeURIComponent(subject.id)}`;
  const patch = (body: Record<string, unknown>, done?: string) => act(() => api(path, { method: "PATCH", body: JSON.stringify({ baseRev: subject.rev, ...body }) }), done);
  const states = new Map((coverage?.questions ?? []).map((q) => [q.id, q] as const));
  const decided = questions.filter((q) => q.status === "decided");
  const proposed = questions.filter((q) => q.status === "proposed");
  const mergeTargets = names && mergeQuery.trim() ? matchSubjects(names.filter((n) => n.id !== subject.id), mergeQuery, 8) : [];
  const looksLike = subject.looksLike ? names?.find((n) => n.id === subject.looksLike) : null;

  return (
    <div className="space-y-3 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="space-y-1.5">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Subject{subject.status === "proposed" ? " · proposed" : ""}</div>
        {canEdit ? (
          <form
            className="flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim() && name.trim() !== subject.name) void patch({ name: name.trim() });
            }}
          >
            <input aria-label="Subject name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className={`${inputClass} font-medium`} />
            <button type="submit" disabled={busy || !name.trim() || name.trim() === subject.name} className={SMALL}>
              Rename
            </button>
          </form>
        ) : (
          <h3 className="text-base font-semibold">{subject.name}</h3>
        )}
        {subject.status === "proposed" && canEdit ? (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="flex-1 text-neutral-500">{subject.reason || `Proposed by ${subject.from}`}</span>
            <Button tone="primary" disabled={busy} onClick={() => void decide("subjects", subject.id, true)}>
              Add to the map
            </Button>
            <Button disabled={busy} onClick={() => void decide("subjects", subject.id, false)}>
              Dismiss
            </Button>
          </div>
        ) : null}
        {looksLike ? (
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
            <span>Looks like “{looksLike.name}”.</span>
            {canEdit ? (
              <button type="button" disabled={busy} onClick={() => void act(() => api(`${MAP}/subjects/merge`, { method: "POST", body: JSON.stringify({ from: subject.id, into: looksLike.id }) })).then((ok) => ok && onGone())} className={SMALL}>
                Merge into it
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-1 text-xs">
          <span className="font-medium text-neutral-600 dark:text-neutral-300">Home page</span>
          {canEdit ? (
            <span className="flex gap-1.5">
              <input aria-label="Home page" value={home} onChange={(e) => setHome(e.target.value)} placeholder="https://" className={`${inputClass} text-xs`} />
              <button type="button" disabled={busy || (home.trim() || null) === (subject.home ?? null)} onClick={() => void patch({ home: home.trim() || null })} className={SMALL}>
                Save
              </button>
            </span>
          ) : (
            <span className="block">{subject.home ?? "Not set"}</span>
          )}
          {subject.suggestedHome && !subject.home && canEdit ? (
            <span className="flex items-center gap-1.5 text-[11px] text-neutral-500">
              Suggested: {subject.suggestedHome}
              <button type="button" disabled={busy} onClick={() => void patch({ home: subject.suggestedHome })} className={SMALL}>
                Use it
              </button>
            </span>
          ) : null}
        </label>
        <label className="space-y-1 text-xs">
          <span className="font-medium text-neutral-600 dark:text-neutral-300">Group</span>
          <select
            aria-label="Group"
            value={subject.groupId ?? ""}
            disabled={!canEdit || busy}
            onChange={(e) => void patch({ groupId: e.target.value || null })}
            className={`${inputClass} text-xs`}
          >
            <option value="">Ungrouped</option>
            {/* Decided groups (a proposed one is added from the list of groups first). */}
            {groups
              .filter((g) => g.status === "decided" || g.id === subject.groupId)
              .map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
          </select>
        </label>
      </div>

      <section aria-label="Questions" className="space-y-1.5">
        <div className="flex items-baseline justify-between text-xs">
          <h4 className="font-semibold">Questions</h4>
          <span className="text-neutral-500">
            {subject.counts.answered} of {decided.length} answered
          </span>
        </div>
        <ul className="space-y-1">
          {decided.map((q) => (
            <li key={q.id} className="rounded-md border border-neutral-100 p-2 dark:border-neutral-800">
              <div className="flex items-start gap-2">
                <span className="min-w-0 flex-1 text-sm">{q.text}</span>
                {canEdit ? (
                  <button type="button" aria-label={`Remove “${q.text}”`} disabled={busy} onClick={() => void act(() => api(`${MAP}/questions/${encodeURIComponent(q.id)}`, { method: "DELETE" }))} className={SMALL}>
                    ✕
                  </button>
                ) : null}
              </div>
              <QuestionStatus q={states.get(q.id)} action={programmes ? <WriteNext questionId={q.id} programmes={programmes} /> : null} />
            </li>
          ))}
          {proposed.map((q) => (
            <li key={q.id} className="rounded-md border border-dashed border-neutral-400 p-2">
              <div className="text-sm">{q.text}</div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-500">
                <span className="flex-1">{q.evidence || q.reason || `Proposed by ${q.from}`}</span>
                {canEdit ? (
                  <>
                    <button type="button" disabled={busy} onClick={() => void decide("questions", q.id, true)} className={SMALL}>
                      Add
                    </button>
                    <button type="button" disabled={busy} onClick={() => void decide("questions", q.id, false)} className={SMALL}>
                      Dismiss
                    </button>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
        {canEdit ? (
          <form
            className="flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              const text = question.trim();
              if (!text) return;
              void act(() => api(`${path}/questions`, { method: "POST", body: JSON.stringify({ text }) })).then((ok) => ok && setQuestion(""));
            }}
          >
            <input aria-label="A question people ask" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Add a question people ask" maxLength={200} className={`${inputClass} text-xs`} />
            <button type="submit" disabled={busy || !question.trim()} className={SMALL}>
              Add
            </button>
          </form>
        ) : null}
      </section>

      {read.overlaps.length || read.missingLinks.length ? (
        <section aria-label="Needs a look" className="space-y-1 text-xs">
          <h4 className="font-semibold">Needs a look</h4>
          {read.overlaps.map((o) => (
            <p key={o.pages.map((p) => p.id).join("|")} className="text-neutral-600 dark:text-neutral-300">
              Same main question on {o.pages.length} pages: {o.pages.map((p, i) => (
                <span key={p.id}>
                  {i ? ", " : ""}
                  <PageLink page={p} />
                </span>
              ))}
            </p>
          ))}
          {read.missingLinks.map((m) => (
            <p key={`${m.from.id}>${m.to.id}`} className="text-neutral-600 dark:text-neutral-300">
              <PageLink page={m.from} /> should link to the newer <PageLink page={m.to} />
            </p>
          ))}
        </section>
      ) : null}

      {canEdit ? (
        <div className="space-y-1.5 border-t border-neutral-100 pt-2 dark:border-neutral-800">
          <label className="block text-xs">
            <span className="font-medium text-neutral-600 dark:text-neutral-300">Merge into another subject</span>
            <input type="search" value={mergeQuery} onChange={(e) => setMergeQuery(e.target.value)} placeholder={names ? "Find the subject to merge into" : "Search above first to load your subjects"} disabled={!names} className={`${inputClass} mt-1 text-xs`} />
          </label>
          {mergeTargets.length ? (
            <div className="flex flex-wrap gap-1.5">
              {mergeTargets.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Merge “${subject.name}” into “${t.name}”? Its questions move across.`)) {
                      void act(() => api(`${MAP}/subjects/merge`, { method: "POST", body: JSON.stringify({ from: subject.id, into: t.id }) })).then((ok) => ok && onGone());
                    }
                  }}
                  className={SMALL}
                >
                  Into “{t.name}”
                </button>
              ))}
            </div>
          ) : null}
          <Button
            tone="danger"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Remove “${subject.name}” and its questions? Articles written for it keep their link.`)) {
                void act(() => api(path, { method: "DELETE" })).then((ok) => ok && onGone());
              }
            }}
          >
            Remove
          </Button>
        </div>
      ) : null}
    </div>
  );
}
