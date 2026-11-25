import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { FUNNEL_STAGES } from "@/lib/invites/funnel";
import type { ComparedIdea } from "@/lib/ideas/compare";
import { IDEA_STATUS_LABEL, IDEA_STATUS_TONE, ideaDay } from "@/lib/ideas/words";
import { ideaWord } from "@/lib/nav/terms";
import { Chip } from "../people/Chip";

/**
 * Launches side by side (LAUNCH_IDEAS_ENABLED): a column each, and a row each for the status (since
 * when, and the hand-off), the hypothesis, the outcome, then loadFunnel's five numbers. Each bar is
 * against that launch's own waitlist, and the line under it is the step from the one before, as
 * LaunchFunnel shows it. Server-safe: the page passes `ideas` (isIdeaWordsEnabled()), and with it
 * the table says ideas.
 */

const pct = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 100)}%` : null);
const num = (n: number) => n.toLocaleString("en-GB");

/** "Since 18 Nov. Handed off to Lumen app." */
export function sinceLine(c: Pick<ComparedIdea, "idea" | "handedOffTo">): string {
  if (!c.idea.status) return "No status yet.";
  const when = ideaDay(c.idea.statusAt);
  return [when ? `Since ${when}.` : "", c.handedOffTo ? `Handed off to ${c.handedOffTo}.` : ""].filter(Boolean).join(" ");
}

export function CompareTable({ columns, ideas = false }: { columns: ComparedIdea[]; ideas?: boolean }) {
  const w = ideaWord(ideas);
  const cell = "border-t border-neutral-100 px-3 py-2.5 align-top dark:border-neutral-900";
  const head = `${cell} w-28 text-left text-xs font-medium text-neutral-500`;
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Link href="/admin/launches" className="inline-flex items-center gap-1 text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100">
          <ChevronLeft size={14} aria-hidden />
          All {w.many}
        </Link>
        <h1 className="text-xl font-semibold">Compare {w.many}</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">Side by side, from the waitlist to people using what you built.</p>
      </div>

      <div className="overflow-x-auto rounded-md border border-neutral-200 dark:border-neutral-800">
        <table aria-label={`${w.Many} side by side`} className="w-full min-w-[560px] table-fixed text-sm">
          <thead>
            <tr>
              <th scope="col" className="w-28 px-3 py-2.5">
                <span className="sr-only">What</span>
              </th>
              {columns.map((c) => (
                <th key={c.id} scope="col" className="px-3 py-2.5 text-left align-top">
                  <Link href={`/admin/launches/${c.id}`} className="font-medium hover:underline">
                    {c.name}
                  </Link>
                  <span className="block text-xs font-normal text-neutral-500">/{c.id}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row" className={head}>
                Status
              </th>
              {columns.map((c) => (
                <td key={c.id} className={cell}>
                  {c.idea.status ? <Chip tone={IDEA_STATUS_TONE[c.idea.status]}>{IDEA_STATUS_LABEL[c.idea.status]}</Chip> : null}
                  <span className="mt-1 block text-xs text-neutral-500">{sinceLine(c)}</span>
                </td>
              ))}
            </tr>
            {(["hypothesis", "outcome"] as const).map((k) => (
              <tr key={k}>
                <th scope="row" className={head}>
                  {k === "hypothesis" ? "Hypothesis" : "Outcome"}
                </th>
                {columns.map((c) => (
                  <td key={c.id} className={`${cell} whitespace-pre-wrap ${c.idea[k] ? "" : "text-neutral-500"}`}>
                    {c.idea[k] || "None yet."}
                  </td>
                ))}
              </tr>
            ))}
            {FUNNEL_STAGES.map((s, i) => {
              const prev = i > 0 ? FUNNEL_STAGES[i - 1]! : null;
              return (
                <tr key={s.key}>
                  <th scope="row" className={head}>
                    {s.label}
                  </th>
                  {columns.map((c) => {
                    const value = c.funnel[s.key];
                    const top = Math.max(c.funnel.waitlisted, 1);
                    const step = prev ? pct(value, c.funnel[prev.key]) : null;
                    return (
                      <td key={c.id} className={cell}>
                        <span className="text-base font-semibold tabular-nums">{num(value)}</span>
                        <div className="mt-1 h-1 rounded-full bg-neutral-100 dark:bg-neutral-800" aria-hidden>
                          <div className="h-1 rounded-full bg-neutral-800 dark:bg-neutral-300" style={{ width: `${Math.min(100, (value / top) * 100)}%` }} />
                        </div>
                        {prev ? (
                          <span className="mt-1 block text-[11px] text-neutral-500">{step ? `${step} of ${prev.label.toLowerCase()}` : "Nobody yet"}</span>
                        ) : null}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-neutral-500">
        Each bar is against that {w.own} own waitlist. {w.Many} marked Just a list are left out.{" "}
        <Link href="/admin/launches" className="underline underline-offset-2">
          Pick other {w.many}
        </Link>
      </p>
    </div>
  );
}
