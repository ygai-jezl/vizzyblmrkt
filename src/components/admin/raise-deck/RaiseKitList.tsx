import Link from "next/link";
import { raiseDocHref } from "@/lib/raise/docs/paths";
import { dayWords } from "@/lib/raise/docs/text";
import type { RaiseDocSummary } from "@/lib/raise/docs/types";
import { LIST_WORDS, RAISE_MESSAGES } from "@/lib/raise/docs/words";
import { NewDeckForm } from "./NewDeckForm";

export interface RaiseKitListProps {
  docs: RaiseDocSummary[];
  /** The Raise kit is in the brand's plan (brandCanUse raise_kit). */
  granted: boolean;
  isAdmin: boolean;
  /** At most this many decks a brand. */
  limit: number;
  /** Plan and usage exists (NEXT_PUBLIC_PLANS_ENABLED), so the not included notice links to it. */
  plansUi: boolean;
  now?: Date;
}

/** Which notices and whether New deck shows. Pure. */
export function listState(p: Pick<RaiseKitListProps, "docs" | "granted" | "isAdmin" | "limit">) {
  const atLimit = p.docs.length >= p.limit;
  return {
    canMake: p.isAdmin && p.granted && !atLimit,
    notIncluded: !p.granted,
    memberOnly: !p.isAdmin,
    atLimit: p.isAdmin && p.granted && atLimit,
    empty: p.docs.length === 0,
  };
}

/**
 * Content › Raise kit: every deck, newest first, and New deck for admins whose plan includes it. A
 * brand that loses the Raise kit keeps its decks: they still open, present and save as PDF. No hooks
 * here (New deck is its own client form), so the states render in tests.
 */
export function RaiseKitList({ docs, granted, isAdmin, limit, plansUi, now = new Date() }: RaiseKitListProps) {
  const s = listState({ docs, granted, isAdmin, limit });
  const notice = "rounded-md border border-neutral-300 bg-neutral-50 p-3 text-sm text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300";
  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold">{LIST_WORDS.title}</h1>
        <p className="text-sm text-neutral-500">{LIST_WORDS.intro}</p>
      </div>

      {s.notIncluded ? (
        <p className={notice}>
          {RAISE_MESSAGES.notIncluded}{" "}
          {plansUi ? (
            <Link href="/admin/account/billing" className="font-medium text-blue-700 hover:underline dark:text-blue-300">
              {LIST_WORDS.plansLink}
            </Link>
          ) : null}
        </p>
      ) : null}
      {s.memberOnly ? <p className={notice}>{RAISE_MESSAGES.memberOnly}</p> : null}
      {s.atLimit ? <p className={notice}>{RAISE_MESSAGES.deckLimit}</p> : null}

      {s.canMake ? <NewDeckForm /> : null}

      {s.empty ? (
        <div className="rounded-md border border-dashed border-neutral-300 p-8 text-sm text-neutral-500 dark:border-neutral-700">{LIST_WORDS.empty}</div>
      ) : (
        <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-300 dark:divide-neutral-800 dark:border-neutral-700">
          {docs.map((d) => (
            <li key={d.id}>
              <Link href={raiseDocHref(d.id)} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-4 hover:bg-neutral-50 dark:hover:bg-neutral-900">
                <span className="min-w-0 flex-1 truncate font-medium">{d.title}</span>
                <span className="rounded-full border border-neutral-300 px-2 py-0.5 text-xs dark:border-neutral-700">{d.kindLabel}</span>
                <span className="text-xs text-neutral-500">{LIST_WORDS.row.draft(d.version)}</span>
                <span className="text-xs text-neutral-500">{LIST_WORDS.row.slides(d.slideCount)}</span>
                <span className="text-xs text-neutral-500">{LIST_WORDS.row.changed(dayWords(d.updatedAt, now))}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
