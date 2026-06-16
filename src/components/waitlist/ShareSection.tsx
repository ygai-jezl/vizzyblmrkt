"use client";

import { useState } from "react";
import {
  buildShareUrl,
  getSharePlatform,
  type SharePlatformId,
} from "@/lib/waitlist/socialPlatforms";
import { SocialIcon } from "./socialIcons";

/**
 * The post-signup "payoff" block, shared by the signup success state and the
 * "check your status" result: the gamified position, how many friends the user
 * has referred, one share button per enabled platform (pre-filled with the
 * referral link + message), and the copyable referral link.
 *
 * `shareMessage` arrives already rendered server-side (merge vars resolved) and
 * WITHOUT the link — every platform appends the referral link itself.
 */
export interface ShareSectionProps {
  referralLink: string;
  shareMessage: string;
  enabledPlatforms: SharePlatformId[];
  /** 1-based waitlist position; null when not applicable (unverified/offboarded). */
  rank: number | null;
  amountReferred: number;
  /** When true, the campaign hides list-size signals, so we suppress the position. */
  hideCounts: boolean;
  /** Brand colour for the copy button. */
  buttonColor: string;
}

export function ShareSection({
  referralLink,
  shareMessage,
  enabledPlatforms,
  rank,
  amountReferred,
  hideCounts,
  buttonColor,
}: ShareSectionProps) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="space-y-4">
      {rank != null && !hideCounts ? (
        <div className="space-y-0.5">
          <p className="text-xs font-medium uppercase tracking-widest text-neutral-500">
            Your position
          </p>
          <p className="text-4xl font-bold tabular-nums">#{rank.toLocaleString()}</p>
        </div>
      ) : null}

      <p className="text-sm text-neutral-500">
        {amountReferred > 0 ? (
          <>
            You have referred{" "}
            <span className="font-semibold text-neutral-900 dark:text-neutral-100">
              {amountReferred.toLocaleString()}
            </span>{" "}
            friend{amountReferred === 1 ? "" : "s"}.
          </>
        ) : (
          "Refer friends to move up the list."
        )}
      </p>

      {enabledPlatforms.length > 0 ? (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {enabledPlatforms.map((id) => {
            const platform = getSharePlatform(id);
            return (
              <a
                key={id}
                href={buildShareUrl(id, { url: referralLink, message: shareMessage })}
                target="_blank"
                rel="noopener noreferrer"
                title={`Share on ${platform.label}`}
                aria-label={`Share on ${platform.label}`}
                className="flex h-9 w-9 items-center justify-center rounded-full border border-neutral-300 text-neutral-700 transition-colors hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
              >
                <SocialIcon id={id} size={18} />
              </a>
            );
          })}
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <input
          readOnly
          value={referralLink}
          className="flex-1 truncate rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          onFocus={(e) => e.currentTarget.select()}
        />
        <button
          type="button"
          className="rounded-md px-4 py-2 text-sm font-medium text-white"
          style={{ backgroundColor: buttonColor }}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(referralLink);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              /* clipboard blocked — the field is selectable as a fallback */
            }
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
