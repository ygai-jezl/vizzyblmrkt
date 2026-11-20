"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { WriteNext } from "@/components/admin/brand-kit/BrandMapCoverage";
import type { NextUpChip, NextUpDoc, NextUpPick } from "@/lib/types/autopilot";
import { FoundTrays, type RunView } from "./FoundTrays";
import { AutopilotSettingsCard } from "./AutopilotSettingsCard";

/**
 * Brand › Brand map, above the tabs (BRAND_MAP_NEXT_UP_ENABLED and the brand's next_up feature):
 * Next up, the brand's three best next articles with why, and what the autopilot learned from the
 * brand's people. /help/brand-map#next-up explains it.
 */

const CARD = "rounded-lg border border-neutral-200 p-4 dark:border-neutral-800";
const HINT = "text-xs text-neutral-500 dark:text-neutral-400";
const BUTTON = "rounded-md border border-neutral-300 px-2.5 py-1 text-xs hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";
const PRIMARY = "rounded-md bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900";

const CHIP: Record<NextUpChip["kind"], string> = {
  map: "border-neutral-300 dark:border-neutral-700",
  you: "border-blue-400 bg-blue-50 dark:border-blue-500 dark:bg-blue-950/40",
  them: "border-dashed border-neutral-400 dark:border-neutral-500",
  num: "border-neutral-300 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900",
};

function Chips({ chips }: { chips: NextUpChip[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((c, i) => (
        <span key={`${c.kind}-${i}`} className={`rounded-full border px-2 py-0.5 text-[11px] text-neutral-700 dark:text-neutral-300 ${CHIP[c.kind]}`}>
          <b className="font-medium">{c.label}:</b> {c.text}
        </span>
      ))}
    </div>
  );
}

function Pick({
  pick,
  top,
  programmes,
  onSkip,
  children,
}: {
  pick: NextUpPick;
  top: boolean;
  programmes: Array<{ id: string; name: string }> | null;
  onSkip: (reason: string) => Promise<void>;
  children?: ReactNode;
}) {
  const [skipping, setSkipping] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <li className={`space-y-2 rounded-md border p-3 ${top ? "border-blue-400 dark:border-blue-500" : "border-neutral-200 dark:border-neutral-800"}`}>
      <div>
        <p className="text-sm font-medium">&ldquo;{pick.question}&rdquo;</p>
        <p className={HINT}>Subject: {pick.subjectName}</p>
      </div>
      <p className="rounded bg-neutral-50 px-2 py-1.5 text-xs text-neutral-800 dark:bg-neutral-900 dark:text-neutral-200">
        <b className="font-medium">Why now:</b> {pick.because}
      </p>
      <Chips chips={pick.chips} />
      <div className="flex flex-wrap items-center gap-2">
        {children}
        {programmes?.length ? <WriteNext questionId={pick.questionId} programmes={programmes} label="Write it" /> : null}
        {skipping ? (
          <span className="flex flex-wrap items-center gap-1.5">
            <input
              aria-label="Why not now (optional)"
              placeholder="Why not now (optional)"
              value={reason}
              maxLength={200}
              onChange={(e) => setReason(e.target.value)}
              className="w-56 rounded-md border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900"
            />
            <button
              type="button"
              disabled={busy}
              className={BUTTON}
              onClick={async () => {
                setBusy(true);
                await onSkip(reason);
                setBusy(false);
              }}
            >
              Skip it
            </button>
          </span>
        ) : (
          <button type="button" className={BUTTON} onClick={() => setSkipping(true)}>
            Not now
          </button>
        )}
      </div>
    </li>
  );
}

function NotOnMap({ topics, isAdmin }: { topics: NextUpDoc["notOnMap"]; isAdmin: boolean }) {
  const [done, setDone] = useState<Record<string, string>>({});
  if (!topics.length) return null;
  return (
    <ul className="space-y-1.5">
      {topics.map((t) => (
        <li key={t.topic} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed border-neutral-300 px-3 py-2 text-xs dark:border-neutral-700">
          <span>
            Competitors write about it, your brand map doesn&apos;t: <b className="font-medium">{t.topic}</b>
            <span className={`block ${HINT}`}>
              {t.competitors.join(" and ")}, {t.count} article{t.count === 1 ? "" : "s"} in 90 days
            </span>
          </span>
          {done[t.topic] ? (
            <span className={HINT}>{done[t.topic]}</span>
          ) : isAdmin ? (
            <button
              type="button"
              className={BUTTON}
              onClick={async () => {
                const res = await fetch("/api/admin/brand-kit/competitors/coverage", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ topics: [t.topic] }),
                }).catch(() => null);
                setDone((d) => ({ ...d, [t.topic]: res?.ok ? "Suggested: it waits on your brand map." : "That didn't go through. Try again." }));
              }}
            >
              Suggest it
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function NextUpCard({
  isAdmin,
  programmes,
}: {
  isAdmin: boolean;
  programmes: Array<{ id: string; name: string }> | null;
}) {
  const [current, setCurrent] = useState<NextUpDoc | null | undefined>(undefined);
  const [ready, setReady] = useState<Array<RunView & { question: { questionId: string; text: string; subjectId: string; subjectName: string } }>>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    void fetch("/api/admin/brand-kit/autopilot/next-up")
      .then((r) => (r.ok ? (r.json() as Promise<{ nextUp: NextUpDoc | null; ready?: (typeof ready)[number] | null; readyAll?: typeof ready }>) : null))
      .then((d) => {
        if (gone) return;
        setCurrent(d ? d.nextUp : null);
        setReady(d?.readyAll ?? (d?.ready ? [d.ready] : []));
      })
      .catch(() => !gone && setCurrent(null));
    return () => {
      gone = true;
    };
  }, []);

  const choose = async () => {
    setBusy(true);
    setMessage("Choosing. It reads your brand map, what you made, competitors and Google: about half a minute.");
    const res = await fetch("/api/admin/brand-kit/autopilot/next-up", { method: "POST" }).catch(() => null);
    const body = res ? ((await res.json().catch(() => ({}))) as { nextUp?: NextUpDoc; error?: string }) : {};
    setBusy(false);
    if (res?.ok && body.nextUp) {
      setCurrent(body.nextUp);
      setMessage(null);
      return;
    }
    setMessage(
      body.error === "rate_limited"
        ? "Next up was chosen a moment ago. Try again in a few minutes."
        : body.error === "no_questions"
          ? "Every question on your brand map is answered or planned. Add questions to choose from."
          : body.error === "no_map"
            ? "Save your brand map first: Next up chooses from its questions."
            : "Next up couldn't choose just now. Try again in a minute.",
    );
  };

  const skip = async (pick: NextUpPick, reason: string) => {
    const res = await fetch("/api/admin/brand-kit/autopilot/next-up/skip", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ questionId: pick.questionId, question: pick.question, ...(reason.trim() ? { reason: reason.trim() } : {}) }),
    }).catch(() => null);
    if (res?.ok) setCurrent(((await res.json()) as { nextUp: NextUpDoc | null }).nextUp);
  };

  if (current === undefined) return null;
  return (
    <section className={CARD} aria-labelledby="next-up">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="next-up" className="text-sm font-semibold">
          Next up
        </h2>
        <span className="flex items-center gap-2">
          {current ? <span className={HINT}>Chosen {new Date(current.at).toLocaleDateString()}</span> : null}
          <button type="button" className={current ? BUTTON : PRIMARY} disabled={busy} onClick={() => void choose()}>
            {busy ? "Choosing…" : current ? "Choose again" : "Choose now"}
          </button>
        </span>
      </div>
      {message ? (
        <p className={`mb-2 ${HINT}`} aria-live="polite">
          {message}
        </p>
      ) : null}
      {ready.length ? (
        <div className="mb-3 space-y-2">
          {ready.map((r, i) => (
            <details key={r.id} open={i === 0} className="rounded-md border border-blue-400 p-3 dark:border-blue-500">
              <summary className="cursor-pointer text-sm">
                <b className="font-medium">Ready to write:</b> &ldquo;{r.question.text}&rdquo;
              </summary>
              <div className="mt-2 space-y-2">
                <p className={HINT}>Autopilot found and sorted what buyers ask. Check the trays, then write it.</p>
                <FoundTrays
                  pick={{ questionId: r.question.questionId, question: r.question.text, subjectId: r.question.subjectId, subjectName: r.question.subjectName, because: "", chips: [], from: "code" }}
                  isAdmin={isAdmin}
                  programmes={programmes}
                  initialRun={r}
                />
              </div>
            </details>
          ))}
        </div>
      ) : null}
      {!current ? (
        <p className={HINT}>Next up picks the three articles worth writing next from your brand map, with why.</p>
      ) : (
        <div className="space-y-3">
          {current.picks.length ? (
            <ol className="space-y-2">
              {current.picks.map((p, i) => (
                <Pick key={p.questionId} pick={p} top={i === 0} programmes={programmes} onSkip={(r) => skip(p, r)}>
                  <FoundTrays pick={p} isAdmin={isAdmin} programmes={programmes} />
                </Pick>
              ))}
            </ol>
          ) : (
            <p className={HINT}>Nothing left to suggest. Choose again for a fresh look.</p>
          )}
          <NotOnMap topics={current.notOnMap} isAdmin={isAdmin} />
          {current.missing.length ? <p className={HINT}>Not weighed: {current.missing.join(" ")}</p> : null}
        </div>
      )}
    </section>
  );
}

interface LearnedRow {
  id: string;
  line: string;
  at: string;
}

function LearnedList({ isAdmin }: { isAdmin: boolean }) {
  const [rows, setRows] = useState<LearnedRow[] | null>(null);
  const load = useCallback(async () => {
    const res = await fetch("/api/admin/brand-kit/autopilot/learned").catch(() => null);
    setRows(res?.ok ? ((await res.json()) as { learned: LearnedRow[] }).learned : []);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  if (!rows?.length) return null;
  const forget = async (body: object) => {
    await fetch("/api/admin/brand-kit/autopilot/learned", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    await load();
  };
  return (
    <details className={CARD}>
      <summary className="cursor-pointer text-sm font-semibold">What autopilot learned ({rows.length})</summary>
      <p className={`mt-1 ${HINT}`}>From what your team skipped, moved and added back. Next up and the sort read it, so the same things aren&apos;t suggested again.</p>
      <ul className="mt-2 space-y-1">
        {rows.map((r) => (
          <li key={r.id} className="flex items-start justify-between gap-2 text-xs">
            <span>{r.line}</span>
            {isAdmin ? (
              <button type="button" className={BUTTON} onClick={() => void forget({ id: r.id })}>
                Remove
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {isAdmin ? (
        <button type="button" className={`mt-2 ${BUTTON}`} onClick={() => void forget({ all: true })}>
          Clear all
        </button>
      ) : null}
    </details>
  );
}

export function AutopilotPanel({
  isAdmin,
  programmes,
  children,
  autopilot = false,
}: {
  isAdmin: boolean;
  programmes: Array<{ id: string; name: string }> | null;
  /** More cards under Next up. */
  children?: ReactNode;
  /** Show the Autopilot settings (CREATE_ARTICLE_AUTOPILOT_ENABLED). */
  autopilot?: boolean;
}) {
  return (
    <div className="space-y-3">
      <NextUpCard isAdmin={isAdmin} programmes={programmes} />
      {autopilot ? <AutopilotSettingsCard isAdmin={isAdmin} /> : null}
      {children}
      <LearnedList isAdmin={isAdmin} />
    </div>
  );
}
