"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { REVIEW_WORDS } from "@/lib/raise/pipeline/words";
import { decideFollowUp, followUpErrorText, type FollowUpOp } from "./investorsApi";

/**
 * Review, Follow-ups from your board (RAISE_FOLLOWUPS_ENABLED), for admins: I followed up today
 * (quiet ones only), which sets Last touch to today, and Dismiss. Either takes the row out of Review.
 */
export function FollowUpButtons({ id, rev, quiet }: { id: string; rev: number; quiet: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<FollowUpOp | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(op: FollowUpOp) {
    setBusy(op);
    setError(null);
    const r = await decideFollowUp(id, op, rev);
    setBusy(null);
    if (!r.ok) return setError(followUpErrorText(r.data));
    router.refresh();
  }

  const button = "rounded-md px-3 py-1.5 text-sm text-shell-muted hover:bg-shell-hover hover:text-shell-ink disabled:opacity-50";
  return (
    <span className="flex shrink-0 flex-col items-end gap-1">
      <span className="flex flex-wrap justify-end gap-1">
        {quiet ? (
          <button type="button" disabled={!!busy} onClick={() => void decide("followed_up")} className={button}>
            {REVIEW_WORDS.followedUp}
          </button>
        ) : null}
        <button type="button" disabled={!!busy} onClick={() => void decide("dismiss")} className={button}>
          {REVIEW_WORDS.dismiss}
        </button>
      </span>
      {error ? <span className="text-xs text-red-600 dark:text-red-400">{error}</span> : null}
    </span>
  );
}
