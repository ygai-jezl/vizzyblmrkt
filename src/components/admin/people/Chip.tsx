import type { ReactNode } from "react";

export type ChipTone = "neutral" | "blue" | "green" | "amber" | "red";

const TONES: Record<ChipTone, string> = {
  neutral: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  blue: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  green: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  red: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

/** A small pill for a person's state: their stage, whether they can be emailed, what an email did. */
export function Chip({ tone = "neutral", title, children }: { tone?: ChipTone; title?: string; children: ReactNode }) {
  return (
    <span title={title} className={`whitespace-nowrap rounded-full px-1.5 text-[11px] font-medium leading-5 ${TONES[tone]}`}>
      {children}
    </span>
  );
}
