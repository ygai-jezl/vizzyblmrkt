import Link from "next/link";
import { Lock, Send } from "lucide-react";

/**
 * "Invite waitlist to product" in a launch's header (nav v2 phase 4). Locked
 * until the brand has a live production product with a sign-up link — and when
 * it's locked, the reason is shown as text, not hidden in a tooltip.
 */
export function InviteButton({ campaignId, lockText }: { campaignId: string; lockText: string | null }) {
  if (lockText) {
    return (
      <div className="max-w-xs space-y-1 text-right">
        <span
          aria-disabled="true"
          className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-400 dark:border-neutral-700"
        >
          <Lock className="h-3.5 w-3.5" aria-hidden /> Invite waitlist to product
        </span>
        <p className="text-xs text-neutral-500">{lockText}</p>
      </div>
    );
  }
  return (
    <Link
      href={`/admin/launches/${campaignId}/invites`}
      className="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
    >
      <Send className="h-3.5 w-3.5" aria-hidden /> Invite waitlist to product
    </Link>
  );
}
