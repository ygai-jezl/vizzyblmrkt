"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { ShareSection } from "./ShareSection";
import type { SharePlatformId } from "@/lib/waitlist/socialPlatforms";

// Lazy-loaded so the Gemini Live SDK (@google/genai) is only fetched when a user
// actually opens the conversation — keeping the waitlist + embed bundles lean.
const ConversationModal = dynamic(
  () => import("./ConversationModal").then((m) => m.ConversationModal),
  { ssr: false },
);

/**
 * The post-signup "payoff" screen — the gamified position, the referral link,
 * social share buttons, and the opt-in live-voice "boost your spot" CTA. The
 * single source of truth shared by:
 *   - the signup form's success state (immediate, no-verification campaigns),
 *   - the double-opt-in post-verification landing (/waitlist/[id]?verified=1&rt=).
 * Both reach the SAME experience; previously only the form did, so a confirmed
 * double-opt-in user landed on a bare "email confirmed" notice.
 */
export interface SignupSuccessProps {
  campaignId: string;
  /** Heading shown above the payoff ("You're on the list!" / "already on the list"). */
  heading: string;
  /** Optional list size; the line is suppressed when absent, zero, or hideCounts. */
  totalSignups?: number;
  hideCounts: boolean;
  /** 1-based waitlist position; null when not applicable. */
  rank: number | null;
  amountReferred: number;
  referralLink: string;
  /** Doubles as the proof-of-signup credential for the voice token route. */
  referralToken: string;
  shareMessage: string;
  enabledPlatforms: SharePlatformId[];
  buttonColor: string;
  /** When enabled (and we have a referralToken), shows the voice conversation CTA. */
  aiConversation?: { enabled: boolean; introLine?: string };
}

export function SignupSuccess({
  campaignId,
  heading,
  totalSignups,
  hideCounts,
  rank,
  amountReferred,
  referralLink,
  referralToken,
  shareMessage,
  enabledPlatforms,
  buttonColor,
  aiConversation,
}: SignupSuccessProps) {
  const [convoOpen, setConvoOpen] = useState(false);

  return (
    <section className="space-y-4 rounded-xl border border-neutral-200 p-5 text-center dark:border-neutral-800">
      <h2 className="text-lg font-semibold">{heading}</h2>
      {!hideCounts && totalSignups != null && totalSignups > 0 ? (
        <p className="text-sm text-neutral-500">
          {totalSignups.toLocaleString()} people have joined.
        </p>
      ) : null}

      <ShareSection
        referralLink={referralLink}
        shareMessage={shareMessage}
        enabledPlatforms={enabledPlatforms}
        rank={rank}
        amountReferred={amountReferred}
        hideCounts={hideCounts}
        buttonColor={buttonColor}
      />

      {aiConversation?.enabled && referralToken ? (
        // Dark callout so the gradient glow reads against the light success card.
        <div className="mt-2 space-y-3 rounded-xl bg-neutral-950 p-4">
          <p className="text-sm font-medium text-white">Want to jump the queue?</p>
          <div className="relative">
            {/* Glow: a blurred premium gradient sitting behind the button. */}
            <div
              aria-hidden
              className="absolute -inset-0.5 rounded-xl bg-gradient-to-r from-fuchsia-500 via-purple-500 to-cyan-400 opacity-70 blur-md"
            />
            <button
              type="button"
              onClick={() => setConvoOpen(true)}
              className="relative w-full rounded-xl bg-neutral-900 px-4 py-3 text-sm font-semibold text-white ring-1 ring-white/15 transition hover:ring-white/30"
            >
              🎙️ Boost your spot — talk to us
            </button>
          </div>
        </div>
      ) : null}

      {convoOpen && referralToken ? (
        <ConversationModal
          campaignId={campaignId}
          referralToken={referralToken}
          introLine={aiConversation?.introLine}
          buttonColor={buttonColor}
          onClose={() => setConvoOpen(false)}
        />
      ) : null}
    </section>
  );
}
