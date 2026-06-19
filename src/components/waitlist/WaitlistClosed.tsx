/**
 * Shown in place of the signup form when a launch is archived (closed). The
 * launch's data is preserved and read-only surfaces (e.g. the status check and
 * leaderboard) keep working — but new signups are no longer accepted.
 */
export function WaitlistClosed({
  compact = false,
  message,
}: {
  compact?: boolean;
  message?: string;
}) {
  return (
    <div
      className={`rounded-md border border-neutral-200 bg-neutral-50 text-center text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900/40 dark:text-neutral-300 ${
        compact ? "px-4 py-3 text-xs" : "px-5 py-6 text-sm"
      }`}
    >
      {message ?? "This waitlist is closed and is no longer accepting signups."}
    </div>
  );
}
