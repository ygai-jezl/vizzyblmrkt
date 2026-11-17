"use client";

import { useEffect, useState } from "react";
import { api } from "@/components/admin/connect/api";
import type { SubjectCompetitors as Data } from "@/lib/competitors/planningApi";

/**
 * Brand › Brand map › a subject › Competitors on this (COMPETITOR_ARTICLES_PLANNING_ENABLED):
 * how much each competitor wrote on it, the angles they took, outside numbers they cite and the
 * formats nobody has used yet. Loaded on its own, so the subject opens as fast as before.
 */
export function SubjectCompetitors({ subjectId }: { subjectId: string }) {
  const [data, setData] = useState<Data | null>(null);

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
          {data.nobodyHas.length ? <p className="text-neutral-600 dark:text-neutral-300">Nobody has written a {data.nobodyHas.join(", ").toLowerCase()} on this yet.</p> : null}
        </>
      ) : (
        <p className="text-neutral-500">None of their articles are on this subject yet.</p>
      )}
    </section>
  );
}
