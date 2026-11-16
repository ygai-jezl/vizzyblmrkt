"use client";

import type { PostResultView, ResultNumber, ResultTag } from "@/lib/distribute/postResults";

/**
 * A published post's results on its Distribute card (DISTRIBUTE_POST_RESULTS_ENABLED). The
 * words come from the server's view (src/lib/distribute/postResults.ts); this only lays them out.
 */

const TAG_STYLE: Record<ResultTag, string> = {
  example: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  small: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  stopped: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
};

const TAG_TEXT: Record<ResultTag, string> = {
  example: "Example for new drafts",
  small: "Too few views to learn from",
  stopped: "Stopped",
};

const fmt = new Intl.NumberFormat("en-GB");

function Numbers({ numbers }: { numbers: ResultNumber[] }) {
  if (!numbers.length) return null;
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1 tabular-nums">
      {numbers.map((n) => (
        <div key={n.label} className="flex flex-col">
          <dd className="text-[15px] font-semibold leading-5 text-neutral-900 dark:text-neutral-100">{fmt.format(n.value)}</dd>
          <dt className="text-[11px] text-neutral-500">{n.label}</dt>
        </div>
      ))}
    </dl>
  );
}

function Header({ title, right }: { title: string; right?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
      <span className="font-semibold text-neutral-800 dark:text-neutral-200">{title}</span>
      {right}
    </div>
  );
}

function Tag({ tag }: { tag: ResultTag }) {
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${TAG_STYLE[tag]}`}>{TAG_TEXT[tag]}</span>;
}

/** One bar per daily read (2 to 7 days after posting); grey for reads still to come. */
function Bars({ series }: { series: (number | null)[] }) {
  const max = Math.max(1, ...series.map((v) => v ?? 0));
  const read = series.filter((v): v is number => v !== null);
  return (
    <div
      className="flex h-6 items-end gap-[3px]"
      role="img"
      aria-label={`Impressions by day: ${read.map((v) => fmt.format(v)).join(", ")}`}
    >
      {series.map((v, i) =>
        v === null ? (
          <span key={i} className="block h-[3px] w-3.5 rounded-sm bg-neutral-200 dark:bg-neutral-700" />
        ) : (
          <span
            key={i}
            className="block w-3.5 rounded-t-sm bg-blue-600/80 dark:bg-blue-400/80"
            style={{ height: `${Math.max(8, Math.round((v / max) * 100))}%` }}
          />
        ),
      )}
    </div>
  );
}

export function PostResults({ result }: { result: PostResultView }) {
  const note = "text-xs text-neutral-500";
  return (
    <div className="space-y-1.5 border-t border-dashed border-neutral-200 pt-2 dark:border-neutral-800">
      {result.kind === "waiting" ? (
        <>
          <Header title="Results" right={<span className="text-neutral-500">First numbers on {result.firstDay}</span>} />
          <p className={note}>YouGrow reads this post&apos;s numbers 2 days after posting, then once a day until it is a week old.</p>
        </>
      ) : null}
      {result.kind === "collecting" ? (
        <>
          <Header
            title={`Results · day ${result.day} of 7`}
            right={<span className="text-neutral-500">Final numbers on {result.finalDay}</span>}
          />
          <Numbers numbers={result.numbers} />
          <Bars series={result.series} />
        </>
      ) : null}
      {result.kind === "settled" ? (
        <>
          <Header title="Results after 7 days" right={result.tag ? <Tag tag={result.tag} /> : null} />
          <Numbers numbers={result.numbers} />
          {result.verdict ? <p className={note}>{result.verdict}</p> : null}
        </>
      ) : null}
      {result.kind === "stopped" ? (
        <>
          <Header title="Results" right={<Tag tag="stopped" />} />
          <Numbers numbers={result.numbers} />
          <p className="text-xs text-red-700 dark:text-red-400">{result.message}</p>
        </>
      ) : null}
      {result.kind === "personal" ? (
        <p className={note}>
          No results for posts from a personal profile. Choose a company page in <strong>Post as</strong> to see them.
        </p>
      ) : null}
    </div>
  );
}
