import Link from "next/link";
import { RAISE_KIT_HREF } from "@/lib/raise/docs/paths";
import { CARD_WORDS } from "@/lib/raise/docs/words";

/** The Raise kit row on Content (RAISE_KIT_ENABLED): what it is, how many decks, and the way in. No hooks. */
export function RaiseKitCard({ count }: { count: number }) {
  return (
    <section
      aria-label={CARD_WORDS.title}
      className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-neutral-300 p-4 dark:border-neutral-700"
    >
      <div className="min-w-0 space-y-1">
        <h2 className="text-sm font-semibold">{CARD_WORDS.title}</h2>
        <p className="text-sm text-neutral-500">{CARD_WORDS.line}</p>
        <p className="text-xs text-neutral-500">{CARD_WORDS.count(count)}</p>
      </div>
      <Link href={RAISE_KIT_HREF} className="text-sm font-medium text-blue-700 hover:underline dark:text-blue-300">
        {CARD_WORDS.link}
      </Link>
    </section>
  );
}
