"use client";

import { Fragment, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight } from "lucide-react";
import { api, errorText } from "@/components/admin/connect/api";
import { Banner, Button } from "@/components/admin/connect/ui";
import type { AddedTopic, CoverageFlag, CoverageView, NotOnMapTopic } from "@/lib/competitors/coverage";
import { addedNote, type AddTopicsResult } from "@/lib/competitors/addTopics";
import { SubjectCompetitorsBox } from "./SubjectCompetitors";

/**
 * What they write about: a row per subject on the brand map, a column per competitor and one for
 * the brand. Each row says what it means for what to write next, and opens the subject's
 * Competitors on this box (on a moved map), to plan an article. Below, subjects they write about
 * that aren't on the map, which an admin adds to it, and the ones added.
 */

export const FLAG_TEXT: Record<CoverageFlag, { label: string; note: string; tone: string }> = {
  gap: { label: "Gap", note: "they write about it, you don't yet", tone: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300" },
  open: { label: "Open", note: "nobody writes about it", tone: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300" },
  crowded: { label: "Crowded", note: "a new angle stands out", tone: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300" },
  you_lead: { label: "You lead", note: "", tone: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300" },
  even: { label: "Even", note: "", tone: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300" },
};

function Cell({ n, max }: { n: number; max: number }) {
  const share = max ? n / max : 0;
  return (
    <td className="px-2 py-1.5 text-center tabular-nums">
      <span
        className="inline-block min-w-8 rounded px-1.5 py-0.5 font-medium"
        style={n ? { backgroundColor: `color-mix(in srgb, rgb(37 99 235) ${Math.round(10 + share * 40)}%, transparent)` } : undefined}
      >
        {n || "·"}
      </span>
    </td>
  );
}

/** Rows worth planning an article on: nobody's there yet, only they are, or it's crowded. */
const PLAN_FLAGS = new Set<CoverageFlag>(["gap", "crowded", "open"]);

const STATE_TAG: Record<NotOnMapTopic["state"], string | null> = { new: null, suggested: "Suggested", dismissed: "Dismissed before" };

export function CompetitorCoverage({
  view,
  canEdit,
  canPlan,
  programmes,
}: {
  view: CoverageView;
  /** Admins add topics (COMPETITOR_ARTICLES_PLANNING_ENABLED). */
  canEdit: boolean;
  /** Rows open their subject's box (COMPETITOR_ARTICLES_PLANNING_ENABLED, on a moved map). */
  canPlan: boolean;
  /** Where Write this next can start an article; null = not offered. */
  programmes: Array<{ id: string; name: string }> | null;
}) {
  const router = useRouter();
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [notOnMap, setNotOnMap] = useState<NotOnMapTopic[]>(view.notOnMap);
  const [added, setAdded] = useState<AddedTopic[]>(view.added);
  const max = Math.max(1, ...view.rows.flatMap((r) => Object.values(r.byCompetitor)));
  const columns = view.competitors.length + 3;

  // The page drawn again (after an add): its lists are the truth.
  useEffect(() => {
    setNotOnMap(view.notOnMap);
    setAdded(view.added);
  }, [view]);

  async function add() {
    setBusy(true);
    setError(null);
    setNote(null);
    const res = await api<AddTopicsResult>("/api/admin/brand-kit/competitors/coverage", { method: "POST", body: JSON.stringify({ topics: picked }) });
    setBusy(false);
    if (!res.ok) {
      setError(errorText(res.data));
      return;
    }
    setPicked([]);
    setNote(addedNote(res.data));
    if (res.data.mode === "added" && res.data.added.length) {
      // Move them down straight away; the table gets their rows when the page is drawn again.
      const now = new Set(res.data.added.map((t) => t.toLowerCase()));
      const moving = notOnMap.filter((t) => now.has(t.topic.toLowerCase()));
      setNotOnMap((cur) => cur.filter((t) => !now.has(t.topic.toLowerCase())));
      setAdded((cur) => [...moving.map((t) => ({ topic: t.topic, subjectId: "", count: t.count, competitors: t.competitors })), ...cur]);
      router.refresh();
    } else if (res.data.mode === "suggested" && res.data.filed) {
      const now = new Set(picked.map((t) => t.toLowerCase()));
      setNotOnMap((cur) => cur.map((t) => (now.has(t.topic.toLowerCase()) && t.state === "new" ? { ...t, state: "suggested" } : t)));
    }
  }

  if (!view.articles) {
    return (
      <p className="rounded-lg border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
        No articles read in the last {view.days} days yet. We read each competitor&rsquo;s new posts after the weekly check of their news page.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      <p className="text-xs text-neutral-500">
        {view.articles} article{view.articles === 1 ? "" : "s"} read from {view.competitors.length} competitor{view.competitors.length === 1 ? "" : "s"}.
      </p>
      {view.rows.length ? (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="w-full min-w-[560px] text-sm">
            <thead>
              <tr className="border-b border-neutral-200 text-left text-xs text-neutral-500 dark:border-neutral-800">
                <th className="px-3 py-2 font-medium">Your subject</th>
                {view.competitors.map((c) => (
                  <th key={c.id} className="px-2 py-2 text-center font-medium">
                    {c.name}
                  </th>
                ))}
                <th className="px-2 py-2 text-center font-medium">You</th>
                <th className="px-3 py-2 font-medium">What it means</th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map((r) => {
                const open = canPlan && openId === r.subjectId;
                const toggle = () => setOpenId(open ? null : r.subjectId);
                return (
                  <Fragment key={r.subjectId}>
                    <tr className="border-t border-neutral-100 dark:border-neutral-900">
                      <td className="px-3 py-1.5">
                        {canPlan ? (
                          <button type="button" aria-expanded={open} onClick={toggle} className="inline-flex items-center gap-1 text-left hover:underline">
                            {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
                            {r.name}
                          </button>
                        ) : (
                          r.name
                        )}
                      </td>
                      {view.competitors.map((c) => (
                        <Cell key={c.id} n={r.byCompetitor[c.id] ?? 0} max={max} />
                      ))}
                      <td className="px-2 py-1.5 text-center font-medium tabular-nums">{r.you}</td>
                      <td className="px-3 py-1.5">
                        <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${FLAG_TEXT[r.flag].tone}`}>{FLAG_TEXT[r.flag].label}</span>
                        {FLAG_TEXT[r.flag].note ? <span className="ml-1.5 text-xs text-neutral-500">{FLAG_TEXT[r.flag].note}</span> : null}
                        {canPlan && PLAN_FLAGS.has(r.flag) && !open ? (
                          <button
                            type="button"
                            onClick={toggle}
                            className="ml-2 rounded border border-neutral-300 px-2 py-0.5 text-[11px] text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
                          >
                            Plan it
                          </button>
                        ) : null}
                      </td>
                    </tr>
                    {open ? (
                      <tr>
                        <td colSpan={columns} className="px-3 pb-3">
                          <SubjectCompetitorsBox subjectId={r.subjectId} programmes={programmes} canEdit={canEdit} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-neutral-500">None of their articles matched a subject on your brand map yet.</p>
      )}

      {notOnMap.length ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">They write about these, and your map doesn&rsquo;t have them</h2>
          <ul className="space-y-1.5">
            {notOnMap.map((t) => (
              <li key={t.topic} className="flex items-start gap-2 text-sm">
                {canEdit ? (
                  <input
                    id={`topic-${t.topic}`}
                    type="checkbox"
                    className="mt-1"
                    checked={picked.includes(t.topic)}
                    onChange={(e) => setPicked((cur) => (e.target.checked ? [...cur, t.topic] : cur.filter((x) => x !== t.topic)))}
                  />
                ) : null}
                <label htmlFor={`topic-${t.topic}`}>
                  <span className="font-medium">{t.topic}</span>
                  <span className="text-neutral-500">
                    {" "}
                    · {t.count} article{t.count === 1 ? "" : "s"} by {t.competitors.join(", ")}
                  </span>
                  {STATE_TAG[t.state] ? (
                    <span className="ml-2 rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">{STATE_TAG[t.state]}</span>
                  ) : null}
                </label>
              </li>
            ))}
          </ul>
          {canEdit ? (
            <Button disabled={busy || !picked.length} onClick={() => void add()}>
              {view.moved ? (busy ? "Adding…" : "Add to my map") : busy ? "Suggesting…" : "Suggest for my map"}
            </Button>
          ) : null}
        </section>
      ) : null}
      {error ? <Banner tone="err">{error}</Banner> : null}
      {note ? <Banner tone="ok">{note}</Banner> : null}

      {added.length ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">On your map now</h2>
          <ul className="space-y-1.5">
            {added.map((t) => (
              <li key={t.topic} className="flex items-start gap-2 text-sm">
                <span aria-hidden className="text-green-700 dark:text-green-400">
                  ✓
                </span>
                <span>
                  <span className="font-medium">{t.topic}</span>
                  <span className="text-neutral-500">
                    {" "}
                    · {t.count} article{t.count === 1 ? "" : "s"} by {t.competitors.join(", ")}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
