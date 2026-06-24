"use client";

import { useEffect, useRef } from "react";
import { useLiveConversation } from "@/lib/hooks/useLiveConversation";
import { translate, type MessageCatalog } from "@/lib/i18n/messages";

/**
 * Post-signup Gemini Live VOICE conversation, shown as a modal launched from the
 * signup success state. Keeps the waitlist page clean (it's opt-in) while driving
 * the high-value interaction that captures golden data and boosts the user's spot.
 */
export function ConversationModal({
  campaignId,
  referralToken,
  introLine,
  buttonColor,
  onClose,
  messages,
}: {
  campaignId: string;
  referralToken: string;
  introLine?: string;
  buttonColor: string;
  onClose: () => void;
  messages: MessageCatalog;
}) {
  const { status, error, isModelSpeaking, transcript, result, start, end } =
    useLiveConversation({ campaignId, referralToken });
  const captionsRef = useRef<HTMLDivElement | null>(null);
  const t = (key: string, vars?: Record<string, string | number>) =>
    translate(messages, key, vars);

  // Keep the latest caption in view.
  useEffect(() => {
    captionsRef.current?.scrollTo({ top: captionsRef.current.scrollHeight });
  }, [transcript]);

  const live = status === "live";
  const busy = status === "connecting" || status === "saving";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t("widget.voice.dialogLabel")}
    >
      <div className="w-full max-w-md space-y-5 rounded-2xl bg-white p-6 shadow-xl dark:bg-neutral-900">
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-lg font-semibold">
            {status === "saved" ? t("widget.voice.boostedTitle") : t("widget.voice.title")}
          </h2>
          <button
            type="button"
            onClick={() => {
              if (live) void end();
              onClose();
            }}
            aria-label={t("widget.common.close")}
            className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
          >
            ✕
          </button>
        </div>

        {status === "idle" ? (
          <>
            <p className="text-sm text-neutral-500">
              {introLine || t("widget.voice.intro")}
            </p>
            <p className="text-xs text-neutral-400">{t("widget.voice.micNotice")}</p>
            <button
              type="button"
              onClick={() => void start()}
              className="w-full rounded-md px-4 py-2.5 text-sm font-semibold text-white"
              style={{ backgroundColor: buttonColor }}
            >
              {t("widget.voice.start")}
            </button>
          </>
        ) : null}

        {status === "connecting" ? (
          <p className="py-6 text-center text-sm text-neutral-500">{t("widget.voice.connecting")}</p>
        ) : null}

        {live ? (
          <>
            <div className="flex items-center justify-center gap-2 text-sm font-medium">
              <span
                className={`inline-block h-2.5 w-2.5 rounded-full ${
                  isModelSpeaking ? "bg-emerald-500" : "animate-pulse bg-red-500"
                }`}
              />
              {isModelSpeaking ? t("widget.voice.speaking") : t("widget.voice.listening")}
            </div>
            <div
              ref={captionsRef}
              className="max-h-56 space-y-2 overflow-y-auto rounded-lg border border-neutral-200 p-3 text-sm dark:border-neutral-800"
            >
              {transcript.length === 0 ? (
                <p className="text-center text-neutral-400">{t("widget.voice.sayHello")}</p>
              ) : (
                transcript.map((turn, i) => (
                  <p key={i} className={turn.role === "user" ? "text-right" : ""}>
                    <span className="text-xs uppercase tracking-wide text-neutral-400">
                      {turn.role === "user" ? t("widget.voice.you") : t("widget.voice.ai")}
                    </span>
                    <br />
                    {turn.text}
                  </p>
                ))
              )}
            </div>
            <button
              type="button"
              onClick={() => void end()}
              className="w-full rounded-md border border-neutral-300 px-4 py-2.5 text-sm font-semibold hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
            >
              {t("widget.voice.endSave")}
            </button>
          </>
        ) : null}

        {status === "saving" ? (
          <p className="py-6 text-center text-sm text-neutral-500">{t("widget.voice.saving")}</p>
        ) : null}

        {status === "saved" ? (
          <>
            <p className="text-sm text-neutral-500">
              {t("widget.voice.thanks")}
              {result?.bonus
                ? result.rank
                  ? t("widget.voice.bumpedWithRank", { rank: result.rank })
                  : t("widget.voice.bumped")
                : ""}
            </p>
            <button
              type="button"
              onClick={onClose}
              className="w-full rounded-md px-4 py-2.5 text-sm font-semibold text-white"
              style={{ backgroundColor: buttonColor }}
            >
              {t("widget.voice.done")}
            </button>
          </>
        ) : null}

        {status === "error" ? (
          <>
            <p className="text-sm text-red-600">{error ?? t("widget.common.error")}</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void start()}
                disabled={busy}
                className="flex-1 rounded-md px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
                style={{ backgroundColor: buttonColor }}
              >
                {t("widget.voice.tryAgain")}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="flex-1 rounded-md border border-neutral-300 px-4 py-2.5 text-sm font-semibold hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
              >
                {t("widget.common.close")}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
