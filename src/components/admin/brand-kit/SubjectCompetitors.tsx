"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorText } from "@/components/admin/connect/api";
import type { SubjectCompetitors as Data } from "@/lib/competitors/planningApi";
import { listWords } from "@/lib/competitors/view";
import { WriteNext } from "./BrandMapCoverage";

/**
 * Brand › Brand map › a subject › Competitors on this (COMPETITOR_ARTICLES_PLANNING_ENABLED):
 * how much each competitor wrote on it, the angles they took, outside numbers they cite, and what
 * nobody has: the subject's questions none of their articles answer, and formats nobody used.
 * Suggest an angle opens Write this next on the best of those questions. Their questions lists
 * what their articles answer that the subject lacks: an admin adds one, then writes it. Loaded on
 * its own, so the subject opens as fast as before.
 */
export function SubjectCompetitors({
  subjectId,
  questions,
  programmes,
  canEdit = false,
  onQuestionsChanged,
}: {
  subjectId: string;
  /** The subject's questions, and whether each is still open (nothing of yours answers it yet). */
  questions: Array<{ id: string; text: string; open: boolean }>;
  /** The programmes a question can be written in; null = not offered. */
  programmes: Array<{ id: string; name: string }> | null;
  /** Admins can add their questions to the subject. */
  canEdit?: boolean;
  /** After one of their questions is added, so the subject's questions load again. */
  onQuestionsChanged?: () => void;
}) {
  const [data, setData] = useState<Data | null>(null);
  // Their questions added here: the new question's id, or what went wrong.
  const [added, setAdded] = useState<Record<string, { id: string } | { error: string }>>({});
  const [adding, setAdding] = useState<string | null>(null);

  async function addQuestion(text: string) {
    setAdding(text);
    const res = await api<{ value: { id: string } }>(`/api/admin/brand-kit/map/subjects/${encodeURIComponent(subjectId)}/questions`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    setAdding(null);
    setAdded((cur) => ({ ...cur, [text]: res.ok ? { id: res.data.value.id } : { error: errorText(res.data) } }));
    if (res.ok) onQuestionsChanged?.();
  }

  useEffect(() => {
    let live = true;
    setData(null);
    void api<{ competitors: Data }>(`/api/admin/brand-kit/competitors/subjects/${encodeURIComponent(subjectId)}`, { method: "GET" }).then((res) => {
      if (live && res.ok) setData(res.data.competitors);
    });
    return () => {
      live = false;
    };
  }, [subjectId]);

  if (!data) return null;
  const byId = new Map(questions.map((q) => [q.id, q] as const));
  const uncovered = (data.uncovered ?? []).flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  // The question to suggest an angle for: one nobody answers that you haven't either, else any open one.
  const suggestFor = uncovered.find((q) => q.open) ?? questions.find((q) => q.open) ?? null;
  return (
    <section aria-label="Competitors on this" className="space-y-2 rounded-lg border border-blue-200 bg-blue-50/40 p-3 text-xs dark:border-blue-900 dark:bg-blue-950/20">
      <h4 className="font-semibold">Competitors on this{data.total ? ` · ${data.total} article${data.total === 1 ? "" : "s"}` : ""}</h4>
      {data.total ? (
        <>
          <ul className="space-y-1">
            {data.competitors.map((c) => (
              <li key={c.name}>
                <span className="font-medium">{c.name}</span> · {c.count}
                {c.formats.length ? ` · mostly ${c.formats.join(", ").toLowerCase()}` : ""}
                {c.asks.length ? ` · asks: ${c.asks.join(", ").toLowerCase()}` : ""}
                <span className="block text-neutral-500">
                  Latest:{" "}
                  <a href={c.latest.url} target="_blank" rel="noopener noreferrer nofollow" className="underline decoration-neutral-300">
                    {c.latest.title || c.latest.url}
                  </a>
                </span>
              </li>
            ))}
          </ul>
          {data.angles.length ? (
            <div>
              <p className="font-medium text-neutral-600 dark:text-neutral-300">Angles taken</p>
              <ul className="list-disc space-y-0.5 pl-4 text-neutral-600 dark:text-neutral-300">
                {data.angles.map((a) => (
                  <li key={a.url}>
                    {a.angle} <span className="text-neutral-500">({a.competitor})</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {data.stats.length ? (
            <div>
              <p className="font-medium text-neutral-600 dark:text-neutral-300">Outside numbers they cite</p>
              <ul className="space-y-0.5 text-neutral-600 dark:text-neutral-300">
                {data.stats.map((s) => (
                  <li key={`${s.figure}|${s.domain}`}>
                    <span className="font-semibold">{s.figure}</span> {s.about} ·{" "}
                    <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="underline decoration-neutral-300">
                      {s.domain}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {data.theirQuestions?.length ? (
            <div className="space-y-1">
              <p className="font-medium text-neutral-600 dark:text-neutral-300">Their questions, not on this subject yet</p>
              <ul className="space-y-1 text-neutral-600 dark:text-neutral-300">
                {data.theirQuestions.map((q) => {
                  const done = added[q.text];
                  return (
                    <li key={q.text} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span>
                        {q.text}{" "}
                        <a href={q.url} target="_blank" rel="noopener noreferrer nofollow" className="text-neutral-500 underline decoration-neutral-300">
                          ({q.competitor})
                        </a>
                      </span>
                      {done && "id" in done ? (
                        programmes?.length ? (
                          <WriteNext questionId={done.id} programmes={programmes} />
                        ) : (
                          <span className="text-neutral-500">Added</span>
                        )
                      ) : done ? (
                        <span className="text-red-700 dark:text-red-400">{done.error}</span>
                      ) : canEdit ? (
                        <button
                          type="button"
                          disabled={adding !== null}
                          onClick={() => void addQuestion(q.text)}
                          className="rounded border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
                        >
                          {adding === q.text ? "Adding…" : "Add"}
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
          {uncovered.length || data.nobodyHas.length ? (
            <div className="space-y-1">
              <p className="font-medium text-neutral-600 dark:text-neutral-300">Nobody has</p>
              {uncovered.length ? (
                <ul className="space-y-1 text-neutral-600 dark:text-neutral-300">
                  {uncovered.slice(0, 3).map((q) => (
                    <li key={q.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span>Answered &ldquo;{q.text}&rdquo;</span>
                      {q.open && programmes ? <WriteNext questionId={q.id} programmes={programmes} /> : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {data.nobodyHas.length ? <p className="text-neutral-600 dark:text-neutral-300">Written {listWords(data.nobodyHas, "or")} on this.</p> : null}
            </div>
          ) : null}
        </>
      ) : (
        <p className="text-neutral-500">None of their articles are on this subject yet.</p>
      )}
      {data.suggestAngle && suggestFor && programmes?.length ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-blue-200 pt-2 dark:border-blue-900">
          <WriteNext questionId={suggestFor.id} programmes={programmes} label="Suggest an angle" />
          <span className="text-neutral-500">for &ldquo;{suggestFor.text}&rdquo;, steering away from the angles they took.</span>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The box for one subject, on its own (What they write about › a row): loads the subject's
 * questions and whether each is still open, as the brand map's subject panel has them.
 */
export function SubjectCompetitorsBox({
  subjectId,
  programmes,
  canEdit,
}: {
  subjectId: string;
  programmes: Array<{ id: string; name: string }> | null;
  canEdit: boolean;
}) {
  const [questions, setQuestions] = useState<Array<{ id: string; text: string; open: boolean }> | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const res = await api<{
      questions: Array<{ id: string; text: string; status: string }>;
      coverage: { questions: Array<{ id: string; state: string }> } | null;
    }>(`/api/admin/brand-kit/map/subjects/${encodeURIComponent(subjectId)}`, { method: "GET" });
    if (!res.ok) {
      setFailed(true);
      return;
    }
    const states = new Map((res.data.coverage?.questions ?? []).map((q) => [q.id, q.state] as const));
    setQuestions(
      res.data.questions.filter((q) => q.status === "decided").map((q) => ({ id: q.id, text: q.text, open: (states.get(q.id) ?? "open") === "open" })),
    );
  }, [subjectId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (failed) return <p className="text-xs text-neutral-500">This subject couldn&rsquo;t be loaded. It may have been removed from your map.</p>;
  if (!questions) return <p className="text-xs text-neutral-500">Loading…</p>;
  return <SubjectCompetitors subjectId={subjectId} questions={questions} programmes={programmes} canEdit={canEdit} onQuestionsChanged={() => void load()} />;
}
