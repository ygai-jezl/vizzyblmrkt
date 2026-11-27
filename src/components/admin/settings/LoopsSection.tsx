import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { LOOPS_COPY, type Cell, type LoopsData, type LoopsSectionView } from "@/lib/loops/loopsSection";

/**
 * Settings › Loops (learning loops step 5, screen 6): the counts across every brand in this copy,
 * for closed weeks, shown only to the people LOOPS_OPERATOR_EMAILS names. A server component: the
 * week switch is a link with a search parameter and the groups open with <details>, so there is
 * no API route and no script. Every word comes from src/lib/loops/loopsSection.ts.
 */

const box = "overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800";
const head = "bg-neutral-50 text-left text-xs font-medium text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400";
const hint = "text-xs text-neutral-500 dark:text-neutral-400";
const amberText = "font-semibold text-amber-800 dark:text-amber-300";
const tone = (c: Cell) => (c.tone === "amber" ? amberText : c.tone === "faint" ? "text-neutral-500 dark:text-neutral-400" : "");
const num = "px-3 py-2 text-right tabular-nums";
/** A group's summary: its own chevron, turned while open, in place of the marker a flex summary loses. */
const summaryBase = "flex cursor-pointer list-none px-3 py-2 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-900 [&::-webkit-details-marker]:hidden";

function Chevron() {
  return <ChevronRight size={14} aria-hidden className="shrink-0 self-center text-neutral-500 transition-transform group-open:rotate-90 dark:text-neutral-400" />;
}

function SectionHead({ id, title, note }: { id: string; title: string; note?: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h3 id={id} className="text-sm font-semibold">
        {title}
      </h3>
      {note ? <span className={hint}>{note}</span> : null}
    </div>
  );
}

function Chips({ chips }: { chips: Array<{ k: string; v: string; none?: boolean }> }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {chips.map((c) => (
        <span
          key={c.k}
          className={`inline-flex items-baseline gap-1.5 rounded-full border px-2.5 py-0.5 text-xs ${c.none ? "border-dashed border-neutral-400 text-neutral-600 dark:text-neutral-400" : "border-neutral-300 dark:border-neutral-700"}`}
        >
          <span>{c.k}</span>
          <b className="font-semibold tabular-nums">{c.v}</b>
        </span>
      ))}
    </span>
  );
}

function Stages({ data }: { data: LoopsData }) {
  return (
    <section aria-labelledby="loops-stages-h" className="space-y-2">
      <SectionHead id="loops-stages-h" title={LOOPS_COPY.stagesTitle} note={LOOPS_COPY.stagesNote} />
      <div className={box}>
        <table className="w-full min-w-[720px] text-sm" aria-labelledby="loops-stages-h">
          <thead className={head}>
            <tr>
              {LOOPS_COPY.stagesHead.map((h, i) => (
                <th key={h} scope="col" className={i === 0 ? "px-3 py-2" : "px-3 py-2 text-right"}>
                  {h}
                  {i === LOOPS_COPY.stagesHead.length - 1 ? (
                    <span className="ml-1 rounded border border-dashed border-neutral-400 px-1 text-[10px] font-medium">{LOOPS_COPY.notYet}</span>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          {data.stages.map((k) => (
            <tbody key={k.label} className="border-t border-neutral-200 dark:border-neutral-800">
              <tr className="font-semibold">
                <th scope="row" className="px-3 py-2 text-left">
                  {k.label} {k.note ? <span className="ml-1 text-xs font-normal text-neutral-500 dark:text-neutral-400">{k.note}</span> : null}
                </th>
                {k.cells.map((c, i) => (
                  <td key={i} className={`${num} ${tone(c)}`}>
                    {c.v}
                  </td>
                ))}
                <td className={num} />
              </tr>
              {k.plans.map((p) => (
                <tr key={p.label} className="text-neutral-600 dark:text-neutral-400">
                  <th scope="row" className="py-1.5 pl-8 pr-3 text-left font-normal">
                    {p.label} {p.note ? <span className="ml-1 text-xs">{p.note}</span> : null}
                  </th>
                  {p.cells.map((c, i) => (
                    <td key={i} className={`px-3 py-1.5 text-right tabular-nums ${tone(c)}`}>
                      {c.v}
                    </td>
                  ))}
                  <td className="px-3 py-1.5" />
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
      <div className="divide-y divide-neutral-200 rounded-md border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
        {data.groups.map((g) =>
          g.lines.length ? (
            <details key={g.label} className="group">
              <summary className={`${summaryBase} items-center gap-2 font-semibold`}>
                <Chevron />
                <span className="flex-1">{g.label}</span>
                <span className={`${hint} font-normal`}>{g.note}</span>
              </summary>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead className={head}>
                    <tr>
                      {LOOPS_COPY.stagesHead.slice(0, 3).map((h, i) => (
                        <th key={h} scope="col" className={i === 0 ? "px-3 py-1.5" : "px-3 py-1.5 text-right"}>
                          {h}
                        </th>
                      ))}
                      <th scope="col" className="px-3 py-1.5">
                        <span className="sr-only">{LOOPS_COPY.stagesHead.slice(3).join(", ")}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.lines.map((l) => (
                      <tr key={l.label} className="border-t border-neutral-100 text-neutral-600 dark:border-neutral-900 dark:text-neutral-400">
                        <th scope="row" className="py-1.5 pl-8 pr-3 text-left font-normal">
                          {l.label}
                        </th>
                        {l.cells.map((c, i) => (
                          <td key={i} className={`px-3 py-1.5 text-right tabular-nums ${tone(c)}`}>
                            {c.v}
                          </td>
                        ))}
                        <td className="px-3 py-1.5 text-neutral-500 dark:text-neutral-400">{l.span}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ) : (
            <p key={g.label} className="flex items-center justify-between gap-2 px-3 py-2 text-sm font-semibold">
              <span>{g.label}</span>
              <span className={`${hint} font-normal`}>{g.note}</span>
            </p>
          ),
        )}
      </div>
    </section>
  );
}

function Data({ data }: { data: LoopsData }) {
  return (
    <>
      <section aria-labelledby="loops-coverage-h" className="space-y-2">
        <SectionHead id="loops-coverage-h" title={LOOPS_COPY.coverage} />
        {data.behind ? (
          <p role="status" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
            {LOOPS_COPY.behind}
          </p>
        ) : null}
        <dl className="divide-y divide-neutral-100 rounded-md border border-neutral-200 text-sm dark:divide-neutral-900 dark:border-neutral-800">
          {data.coverage.map((c) => (
            <div key={c.k} className="flex gap-4 px-4 py-2.5">
              <dt className="w-44 shrink-0 text-neutral-500 dark:text-neutral-400">{c.k}</dt>
              <dd className={`min-w-0 ${c.amber ? amberText : ""}`}>{c.v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <Stages data={data} />

      <section aria-labelledby="loops-stuck-h" className="space-y-2">
        <SectionHead id="loops-stuck-h" title={LOOPS_COPY.stuckTitle} />
        {data.stalls.length ? (
          <ul className="space-y-2">
            {data.stalls.map((s) => (
              <li
                key={s.text}
                className={`rounded-md border px-3 py-2.5 text-sm ${s.amber ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200" : "border-neutral-200 dark:border-neutral-800"}`}
              >
                {s.text}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm">{LOOPS_COPY.stuckNone}</p>
        )}
        {data.waits.map((w) => (
          <p key={w} className="text-sm">
            {w}
          </p>
        ))}
        <p className={hint}>{LOOPS_COPY.stuckRule}</p>
      </section>

      <section aria-labelledby="loops-why-h" className="space-y-2">
        <SectionHead id="loops-why-h" title={LOOPS_COPY.reasonsTitle} />
        {data.reasons.length ? <Chips chips={data.reasons} /> : <p className="text-sm">{LOOPS_COPY.reasonsNone}</p>}
      </section>

      <section aria-labelledby="loops-downs-h" className="space-y-2">
        <SectionHead id="loops-downs-h" title={LOOPS_COPY.downsTitle} note={LOOPS_COPY.downsNote} />
        {data.downs.length ? (
          <div className={box}>
            <table className="w-full min-w-[640px] text-sm" aria-labelledby="loops-downs-h">
              <thead className={head}>
                <tr>
                  {LOOPS_COPY.downsHead.map((h, i) => (
                    <th key={h} scope="col" className={i === 1 ? "px-3 py-2 text-right" : "px-3 py-2"}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.downs.map((d) => (
                  <tr key={d.kind} className={`border-t border-neutral-200 align-top dark:border-neutral-800 ${d.pool ? "font-semibold" : ""}`}>
                    <th scope="row" className="px-3 py-2 text-left">
                      {d.kind}
                    </th>
                    {d.orgs === null ? (
                      <td colSpan={2} className="px-3 py-2 font-normal text-neutral-500 dark:text-neutral-400">
                        {LOOPS_COPY.fewer}
                      </td>
                    ) : (
                      <>
                        <td className={num}>{d.orgs}</td>
                        <td className="px-3 py-2 font-normal">{d.reasons.length ? <Chips chips={d.reasons} /> : LOOPS_COPY.downsNone}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm">{LOOPS_COPY.downsNone}</p>
        )}
        <p className={hint}>{LOOPS_COPY.downsFoot}</p>
      </section>

      <section aria-labelledby="loops-stamps-h" className="space-y-2">
        <SectionHead id="loops-stamps-h" title={LOOPS_COPY.stampsTitle} note={LOOPS_COPY.stampsNote} />
        <div className={box}>
          <table className="w-full min-w-[720px] text-sm" aria-labelledby="loops-stamps-h">
            <thead className={head}>
              <tr>
                {LOOPS_COPY.stampsHead.map((h, i) => (
                  <th key={h} scope="col" className={i === 0 || i === 4 ? "px-3 py-2" : "px-3 py-2 text-right"}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.stamps.map((s) => (
                <tr key={s.kind} className="border-t border-neutral-200 dark:border-neutral-800">
                  <th scope="row" className="px-3 py-2 text-left font-normal">
                    {s.kind}
                  </th>
                  {s.cells ? (
                    <>
                      <td className={num}>{s.cells.orgs}</td>
                      <td className={num}>{s.cells.made}</td>
                      <td className={num}>{s.cells.pct}</td>
                      <td className="px-3 py-2">{s.cells.not}</td>
                      <td className={num}>{s.cells.lost}</td>
                    </>
                  ) : (
                    <td colSpan={5} className="px-3 py-2 text-neutral-500 dark:text-neutral-400">
                      {LOOPS_COPY.fewer}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <section aria-labelledby="loops-cards-h" className="space-y-2 rounded-md border border-neutral-200 p-4 dark:border-neutral-800">
          <h3 id="loops-cards-h" className="text-sm font-semibold">
            {LOOPS_COPY.cardsTitle}
          </h3>
          {data.cards.map((c) => (
            <p key={c} className="text-sm text-neutral-700 dark:text-neutral-300">
              {c}
            </p>
          ))}
        </section>
        <section aria-labelledby="loops-holdback-h" className="space-y-2 rounded-md border border-neutral-200 p-4 dark:border-neutral-800">
          <h3 id="loops-holdback-h" className="text-sm font-semibold">
            {LOOPS_COPY.holdbackTitle}
          </h3>
          {data.holdback.map((h) => (
            <p key={h} className="text-sm text-neutral-700 dark:text-neutral-300">
              {h}
            </p>
          ))}
        </section>
      </div>

      <section aria-labelledby="loops-industries-h" className="space-y-2">
        <SectionHead id="loops-industries-h" title={LOOPS_COPY.industriesTitle} />
        {data.industries.length ? (
          <div className={box}>
            <table className="w-full text-sm" aria-labelledby="loops-industries-h">
              <thead className={head}>
                <tr>
                  <th scope="col" className="px-3 py-2">
                    {LOOPS_COPY.industriesHead[0]}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right">
                    {LOOPS_COPY.industriesHead[1]}
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.industries.map((i) => (
                  <tr key={i.k} className="border-t border-neutral-200 dark:border-neutral-800">
                    <th scope="row" className="px-3 py-2 text-left font-normal">
                      {i.k}
                    </th>
                    <td className={`${num} ${i.faint ? "text-neutral-500 dark:text-neutral-400" : ""}`}>{i.v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {data.differs.map((d) => (
          <p key={d} className="text-sm">
            {d}
          </p>
        ))}
      </section>

      <section aria-labelledby="loops-not-h" className="space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 id="loops-not-h" className="text-sm font-semibold">
            {LOOPS_COPY.notLearningTitle}
          </h3>
          <a href={data.docsUrl} className="text-xs text-neutral-600 underline underline-offset-2 dark:text-neutral-400" target="_blank" rel="noreferrer">
            {LOOPS_COPY.notLearningLink}
          </a>
        </div>
        <div className="divide-y divide-neutral-200 rounded-md border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {data.notLearning.map((g) =>
            g.lines.length ? (
              <details key={g.label} open={g.open} className="group">
                <summary className={`${summaryBase} flex-wrap items-baseline gap-x-3 gap-y-1`}>
                  <Chevron />
                  <span className="font-semibold">{g.label}</span>
                  <span className="min-w-0 flex-1 text-neutral-600 dark:text-neutral-400">{g.note}</span>
                  {g.over ? <span className={`text-xs ${amberText}`}>{g.over}</span> : null}
                </summary>
                <ul className="divide-y divide-neutral-100 dark:divide-neutral-900">
                  {g.lines.map((l) => (
                    <li key={l.label} className="grid gap-x-3 gap-y-0.5 px-3 py-2 pl-8 text-sm md:grid-cols-[12rem_minmax(0,1fr)_9rem]">
                      <span>{l.label}</span>
                      <span className="text-neutral-600 dark:text-neutral-400">{l.why}</span>
                      <span className={`tabular-nums md:text-right ${l.over ? amberText : "text-neutral-500 dark:text-neutral-400"}`}>{l.when}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : (
              <p key={g.label} className="flex flex-wrap items-baseline gap-x-3 px-3 py-2 text-sm">
                <span className="font-semibold">{g.label}</span>
                <span className="text-neutral-600 dark:text-neutral-400">{g.note}</span>
              </p>
            ),
          )}
        </div>
      </section>

      <section aria-labelledby="loops-cleanup-h" className="space-y-2">
        <SectionHead id="loops-cleanup-h" title={LOOPS_COPY.cleanupTitle} />
        <p className="text-sm">{data.cleanup}</p>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        {LOOPS_COPY.later.map((l) => (
          <div key={l.title} className="space-y-1 rounded-md border border-dashed border-neutral-300 p-4 dark:border-neutral-700">
            <p className="flex items-center gap-2 text-sm font-semibold text-neutral-700 dark:text-neutral-300">
              <span className="rounded border border-neutral-300 px-1.5 text-[11px] font-medium text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">{LOOPS_COPY.laterTag}</span>
              {l.title}
            </p>
            <p className={hint}>{l.text}</p>
          </div>
        ))}
      </div>
    </>
  );
}

export function LoopsSection({ view }: { view: LoopsSectionView }) {
  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="max-w-2xl space-y-1">
          <h2 className="text-base font-semibold">{LOOPS_COPY.title}</h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">{LOOPS_COPY.lead}</p>
        </div>
        <div role="group" aria-label={LOOPS_COPY.weekGroup} className="inline-flex gap-1 rounded-md border border-neutral-300 p-0.5 text-sm dark:border-neutral-700">
          {view.weeks.map((w) =>
            w.off ? (
              <span key={w.week} aria-disabled="true" className="rounded px-3 py-1 text-neutral-400 dark:text-neutral-600">
                {w.label}
              </span>
            ) : (
              <Link
                key={w.week}
                href={w.href}
                aria-current={w.on ? "page" : undefined}
                className={`rounded px-3 py-1 ${w.on ? "bg-neutral-900 font-medium text-white dark:bg-white dark:text-neutral-900" : "text-neutral-600 hover:bg-neutral-50 dark:text-neutral-400 dark:hover:bg-neutral-900"}`}
              >
                {w.label}
              </Link>
            ),
          )}
        </div>
      </div>
      {view.state === "error" ? <p role="alert" className="text-sm text-red-700 dark:text-red-300">{LOOPS_COPY.error}</p> : null}
      {view.state === "empty" ? <p className="text-sm text-neutral-600 dark:text-neutral-400">{LOOPS_COPY.empty}</p> : null}
      {view.state === "data" ? <Data data={view.data} /> : null}
    </div>
  );
}
