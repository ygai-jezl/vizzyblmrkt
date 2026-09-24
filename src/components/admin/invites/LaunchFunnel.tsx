import type { Funnel } from "@/lib/invites/funnel";

/**
 * Waitlisted → Verified → Invited → Signed up → Activated, as one row of labelled
 * stages (nav v2 phase 4). One series, so no legend: every stage names itself and
 * carries its number; the thin bar shows its size against the first stage, and
 * the small line under it is the step-to-step conversion. Server-safe.
 */

const STAGES: Array<{ key: keyof Funnel; label: string; hint: string }> = [
  { key: "waitlisted", label: "Waitlisted", hint: "Everyone who joined the waitlist" },
  { key: "verified", label: "Verified", hint: "Confirmed their email" },
  { key: "invited", label: "Invited", hint: "Sent an invite into the product" },
  { key: "signedUp", label: "Signed up", hint: "Signed up in the product after their invite" },
  { key: "activated", label: "Activated", hint: "Finished onboarding in the product" },
];

const pct = (n: number, of: number) => (of > 0 ? `${Math.round((n / of) * 100)}%` : "—");

export function LaunchFunnel({ funnel, caption }: { funnel: Funnel; caption?: string }) {
  const top = Math.max(funnel.waitlisted, 1);
  return (
    <figure className="space-y-2">
      <ol className="grid grid-cols-2 gap-3 sm:grid-cols-5" aria-label="Waitlist to product funnel">
        {STAGES.map((s, i) => {
          const value = funnel[s.key];
          const prev = i > 0 ? funnel[STAGES[i - 1]!.key] : null;
          return (
            <li
              key={s.key}
              title={`${s.label}: ${value.toLocaleString("en-GB")}${prev != null ? ` (${pct(value, prev)} of ${STAGES[i - 1]!.label.toLowerCase()})` : ""} — ${s.hint}`}
              className="rounded-lg border border-neutral-200 px-3 py-2.5 dark:border-neutral-800"
            >
              <p className="text-xs text-neutral-500">{s.label}</p>
              <p className="text-xl font-semibold tabular-nums">{value.toLocaleString("en-GB")}</p>
              <div className="mt-1.5 h-1 rounded-full bg-neutral-100 dark:bg-neutral-800" aria-hidden>
                <div
                  className="h-1 rounded-full bg-neutral-800 dark:bg-neutral-300"
                  style={{ width: `${Math.min(100, (value / top) * 100)}%` }}
                />
              </div>
              <p className="mt-1 text-[11px] text-neutral-500">
                {prev != null ? `${pct(value, prev)} of ${STAGES[i - 1]!.label.toLowerCase()}` : " "}
              </p>
            </li>
          );
        })}
      </ol>
      {caption ? <figcaption className="text-xs text-neutral-500">{caption}</figcaption> : null}
    </figure>
  );
}
