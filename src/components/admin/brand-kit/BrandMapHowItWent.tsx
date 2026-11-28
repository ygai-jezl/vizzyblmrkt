"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { ShownMonth, StrategyMonthsView } from "@/lib/brandStrategy/monthView";
import { monthBefore, moveFor } from "@/lib/brandStrategy/monthRules";
import { OUTCOME_KINDS, OUTCOME_WORDS, OUTCOMES, type KindCoverage, type OutcomeKind } from "@/lib/metrics/outcomes";
import type { MonthNumbers } from "@/lib/types/brandStrategy";
import { api } from "@/components/admin/connect/api";
import { HOW_IT_WENT_WORDS as W, strategyErrorText } from "./strategyMessages";

/**
 * How it went (STRATEGY_RESULTS_ENABLED), on the Strategy tab: each month the approved strategy's
 * focus situations beside the rest of the map, with one column for each kind of result measured
 * that month and none for a kind that wasn't, an arrow against the month before only where both
 * months had the same source, and a line on what can be measured now and what to connect. Any
 * member reads it. Shown only while its switch is on.
 */

const PATH = "/api/admin/brand-kit/map/strategy/month";
const CARD = "space-y-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800";
const ARROW = { up: "▲", down: "▼", same: "=" } as const;

const n = (v: number) => v.toLocaleString("en-GB");
const dayWords = (iso: string) => {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00.000Z` : iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
};
const monthWords = (month: string) => new Date(`${month}-01T00:00:00.000Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

/** The kinds a month measured by page, in order: one column each. */
const columnsOf = (m: ShownMonth) => OUTCOME_KINDS.filter((k) => m.sources[k] && !m.sources[k]!.siteOnly);

function Measuring({ list }: { list: KindCoverage[] }) {
  const measured = list.filter((c): c is Extract<KindCoverage, { state: "measured" }> => c.state === "measured");
  const missing = list.filter((c): c is Exclude<KindCoverage, { state: "measured" }> => c.state !== "measured");
  return (
    <div className="space-y-1 text-xs text-neutral-600 dark:text-neutral-300">
      <p>
        <span className="font-medium">{OUTCOME_WORDS.lead}</span>{" "}
        {measured.length ? measured.map((c) => `✓ ${OUTCOME_WORDS.measured(c)}`).join(" · ") : OUTCOME_WORDS.builtInOnly}
      </p>
      {missing.length ? (
        <ul className="space-y-0.5">
          {missing.map((c) => (
            <li key={c.kind} className="flex flex-wrap items-center gap-1.5">
              <span>
                {OUTCOMES[c.kind].label}: {OUTCOME_WORDS.missing(c)}
              </span>
              {c.state === "not_connected" ? (
                c.could.map((x) => (
                  <Link key={x.connectorId} href={x.href} className="underline">
                    Connect {x.name}
                  </Link>
                ))
              ) : (
                <Link href={c.href} className="underline">
                  {c.state === "not_shared" ? `Share ${c.connector}` : `Check ${c.connector}`}
                </Link>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function MonthTable({ month, before }: { month: ShownMonth; before: ShownMonth | null }) {
  const kinds = columnsOf(month);
  const theirs = month.rows.some((r) => r.theirs !== null);
  const cell = (rowId: string, kind: OutcomeKind) => {
    const key = month.sources[kind]!.measure as keyof MonthNumbers;
    const v = month.rows.find((r) => r.id === rowId)?.m[key];
    const move = moveFor(month, before, rowId, kind);
    return (
      <>
        {typeof v === "number" ? n(v) : ""}
        {move ? <span className={`ml-1 text-[11px] ${move.arrow === "up" ? "text-green-700 dark:text-green-400" : move.arrow === "down" ? "text-amber-700 dark:text-amber-400" : "text-neutral-500"}`}>{`${ARROW[move.arrow]}${move.arrow === "same" ? "" : ` ${n(move.by)}`}`}</span> : null}
      </>
    );
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[32rem] text-left text-sm">
        <thead className="text-[11px] text-neutral-500">
          <tr>
            <th className="py-1 pr-3 font-medium">{W.columns.situation}</th>
            <th className="py-1 pr-3 font-medium">{W.columns.live}</th>
            <th className="py-1 pr-3 font-medium">{W.columns.answered}</th>
            {kinds.map((k) => (
              <th key={k} className="py-1 pr-3 font-medium">
                {OUTCOMES[k].column}
              </th>
            ))}
            {theirs ? <th className="py-1 font-medium">{W.columns.theirs}</th> : null}
          </tr>
        </thead>
        <tbody>
          {month.rows.map((r) => (
            <tr key={r.id} className="border-t border-neutral-100 dark:border-neutral-800">
              <td className="py-1 pr-3">{r.text}</td>
              <td className="py-1 pr-3">
                {n(r.live)} <span className="text-[11px] text-neutral-500">(+{n(r.newLive)})</span>
              </td>
              <td className="py-1 pr-3" title={r.id === "rest" ? W.restQuestions : undefined}>
                {r.questions > 0 ? W.answered(r.answered, r.questions) : <span className="text-neutral-500">{W.noQuestions}</span>}
                {r.id === "rest" && r.questions > 0 ? <span className="text-neutral-500">*</span> : null}
              </td>
              {kinds.map((k) => (
                <td key={k} className="py-1 pr-3">
                  {cell(r.id, k)}
                </td>
              ))}
              {theirs ? <td className="py-1">{r.theirs === null ? "" : n(r.theirs)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BrandMapHowItWent() {
  const [view, setView] = useState<StrategyMonthsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api<{ howItWent?: StrategyMonthsView }>(PATH).then((r) => {
      if (cancelled) return;
      if (r.ok && r.data.howItWent) setView(r.data.howItWent);
      else setError(r.ok ? W.failed : strategyErrorText(r.data));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!view) return error ? <p className="text-xs text-neutral-500">{error}</p> : null;
  const month = view.months.find((m) => m.month === picked) ?? view.months[0] ?? null;
  const before = month ? (monthBefore(view.months, month.month) as ShownMonth | null) : null;
  const more = month ? month.more.map((k) => OUTCOMES[k].label) : [];
  const site = month?.sources.visits?.siteOnly && typeof month.site.cfVisits === "number" ? { visits: month.site.cfVisits, connector: month.sources.visits.connector } : null;

  return (
    <section className={CARD} aria-label={W.title}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{W.title}</h2>
        {!view.tooEarly && view.months.length ? (
          <select aria-label="Month" className="rounded border border-neutral-300 bg-transparent px-2 py-0.5 text-xs dark:border-neutral-700" value={month?.month ?? ""} onChange={(e) => setPicked(e.target.value)}>
            {view.months.map((m) => (
              <option key={m.month} value={m.month}>
                {monthWords(m.month)}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      {!view.approvedAt ? (
        <p className="text-xs text-neutral-500">{W.noStrategy}</p>
      ) : view.tooEarly ? (
        <p className="text-xs text-neutral-500">
          <span className="font-medium">{W.tooEarly}</span> {W.tooEarlyWhen(dayWords(view.firstApprovedAt ?? view.approvedAt), dayWords(view.nextLookOn))}
        </p>
      ) : !month ? (
        <p className="text-xs text-neutral-500">{W.noMonthYet(dayWords(view.nextLookOn))}</p>
      ) : (
        <>
          {month.partway && month.strategyAt ? <p className="text-[11px] text-neutral-500">{W.partway(dayWords(month.strategyAt))}</p> : null}
          <MonthTable month={month} before={before} />
          <div className="space-y-0.5 text-xs text-neutral-600 dark:text-neutral-300">
            {month.rows.some((r) => r.id === "rest" && r.questions > 0) ? <p className="text-[11px] text-neutral-500">* {W.restQuestions}</p> : null}
            {month.resultsFor ? <p className="text-[11px] text-neutral-500">{W.resultsFor(dayWords(month.resultsFor.from), dayWords(month.resultsFor.to))}</p> : null}
            {site ? <p>{W.site(site.visits, site.connector)}</p> : null}
            {month.roadmap && month.roadmap.due ? <p>{W.roadmap(month.roadmap.done, month.roadmap.due)}</p> : null}
            <p>{W.did(month.did)}</p>
            {view.working && month.month === view.months[0]?.month ? <p className="text-green-700 dark:text-green-400">{view.working}</p> : null}
            {more.length ? <p className="text-amber-700 dark:text-amber-400">{W.more(more)}</p> : null}
          </div>
        </>
      )}
      <Measuring list={view.measuring} />
    </section>
  );
}
