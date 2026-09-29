import type { OnboardingSummary } from "@/lib/connect/onboardingSummary";

/**
 * A person's onboarding in a table cell: a bar and "4 of 8", then what's next
 * and whose steps count (a brand, when steps are per brand). Takes the same
 * room at 2 steps or 20; hover lists every step.
 */
export function OnboardingProgress({ summary }: { summary: OnboardingSummary }) {
  const { done, total, activated, next, about, steps } = summary;
  if (total === 0) return <span className="text-neutral-400">—</span>;
  const pct = Math.round((done / total) * 100);
  const detail = [about ? `Counting ${about}` : null, ...steps.map((s) => `${s.done ? "✓" : "☐"} ${s.label}`)].filter(Boolean).join("\n");
  return (
    <div className="min-w-[9rem] max-w-[18rem] space-y-1" title={detail}>
      <div className="flex items-center gap-2">
        <div
          className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
          aria-label="Onboarding steps done"
        >
          <div className={`h-full rounded-full ${done === total || activated ? "bg-green-600" : "bg-neutral-900 dark:bg-neutral-100"}`} style={{ width: `${pct}%` }} />
        </div>
        <span className="whitespace-nowrap tabular-nums">
          {done} of {total}
        </span>
        {activated ? (
          <span className="rounded bg-green-100 px-1.5 py-0.5 text-[11px] font-medium text-green-800 dark:bg-green-950 dark:text-green-300">Activated</span>
        ) : null}
      </div>
      <div className="truncate text-xs text-neutral-500">
        {next ? `Next: ${next}` : "All steps done"}
        {about ? ` · ${about}` : ""}
      </div>
    </div>
  );
}
