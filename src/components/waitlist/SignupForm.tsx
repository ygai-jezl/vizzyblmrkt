"use client";

import { useState } from "react";
import { getRecaptchaToken } from "@/lib/security/recaptchaClient";
import {
  parseEnabledPlatforms,
  type SharePlatformId,
} from "@/lib/waitlist/socialPlatforms";
import dynamic from "next/dynamic";
import { ShareSection } from "./ShareSection";

// Lazy-loaded so the Gemini Live SDK (@google/genai) is only fetched when a user
// actually opens the conversation — keeping the waitlist + embed bundles lean.
const ConversationModal = dynamic(
  () => import("@/components/waitlist/ConversationModal").then((m) => m.ConversationModal),
  { ssr: false },
);

interface Question {
  question_value: string;
  optional: boolean;
  answer_value: string[] | null;
}

/** Layout shapes — see src/lib/widget/types.ts. "full" is the hosted-page form. */
export type SignupVariant = "full" | "mini" | "docked";

interface Props {
  campaignId: string;
  requiredContactDetail: "EMAIL" | "PHONE" | "BOTH" | "EITHER";
  usesFirstnameLastname: boolean;
  questions: Question[];
  referredBySignupToken?: string;
  buttonColor: string;
  successMessage: string;
  /** Label for the primary CTA on the full form. Compact variants show "Join". */
  joinButtonLabel: string;
  /** "full" (default) collects everything; "mini"/"docked" are email-only. */
  variant?: SignupVariant;
  /** When embedded in an iframe, emit a `vizzybl:signup` DOM event on success. */
  embedded?: boolean;
  /** Post-signup AI voice conversation config (the CTA shown on success). */
  aiConversation?: { enabled: boolean; introLine?: string };
}

interface SuccessState {
  alreadyJoined: boolean;
  referralToken: string;
  referralLink: string;
  totalSignups: number;
  needsVerification: boolean;
  /** 1-based waitlist position; null until verified (verification campaigns). */
  rank: number | null;
  amountReferred: number;
  /** Share-message template rendered server-side (merge vars resolved, no link). */
  shareMessage: string;
  enabledPlatforms: SharePlatformId[];
  hideCounts: boolean;
}

/** Read the 5 standard UTM params from the current URL (undefined if none). */
function readUtm(): Record<string, string> | undefined {
  if (typeof window === "undefined") return undefined;
  const p = new URLSearchParams(window.location.search);
  const utm: Record<string, string> = {};
  for (const k of ["source", "medium", "campaign", "content", "term"] as const) {
    const v = p.get(`utm_${k}`);
    if (v) utm[k] = v;
  }
  return Object.keys(utm).length ? utm : undefined;
}

export function SignupForm({
  campaignId,
  requiredContactDetail,
  usesFirstnameLastname,
  questions,
  referredBySignupToken,
  buttonColor,
  successMessage,
  joinButtonLabel,
  variant = "full",
  embedded = false,
  aiConversation,
}: Props) {
  const [convoOpen, setConvoOpen] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<"idle" | "submitting" | "error" | "success">("idle");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<SuccessState | null>(null);

  // Compact variants collect email only — names, phone, and questions are
  // suppressed regardless of campaign config (the API still validates).
  const compact = variant !== "full";
  const showName = !compact && usesFirstnameLastname;
  const showEmail = compact || requiredContactDetail !== "PHONE";
  const showPhone =
    !compact &&
    (requiredContactDetail === "PHONE" ||
      requiredContactDetail === "BOTH" ||
      requiredContactDetail === "EITHER");
  const shownQuestions = compact ? [] : questions;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("submitting");
    setError(null);

    const body: Record<string, unknown> = {};
    if (showName) {
      body.firstName = firstName.trim();
      body.lastName = lastName.trim();
    }
    if (showEmail && email.trim()) body.email = email.trim();
    if (showPhone && phone.trim()) body.phone = phone.trim();
    if (referredBySignupToken) body.referredBySignupToken = referredBySignupToken;
    const answerList = shownQuestions
      .filter((q) => (answers[q.question_value] ?? "").length > 0)
      .map((q) => ({ question_value: q.question_value, answer_value: answers[q.question_value]! }));
    if (answerList.length) body.answers = answerList;

    const utm = readUtm();
    if (utm) body.utm = utm;
    if (typeof document !== "undefined" && document.referrer) {
      body.referrerUrl = document.referrer;
    }

    try {
      const recaptchaToken = await getRecaptchaToken("signup");
      if (recaptchaToken) body.recaptchaToken = recaptchaToken;

      const res = await fetch(`/api/waitlist/${campaignId}/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        const issues = Array.isArray(data.issues)
          ? data.issues.map((i: unknown) => (typeof i === "string" ? i : (i as { message?: string }).message)).join(", ")
          : null;
        setError(issues || data.error || "Something went wrong.");
        setStatus("error");
        return;
      }
      setSuccess({
        alreadyJoined: !!data.alreadyJoined,
        referralToken: data.referralToken,
        referralLink: data.referralLink,
        totalSignups: data.totalSignups,
        needsVerification: !!data.needsVerification,
        rank: typeof data.rank === "number" ? data.rank : null,
        amountReferred: typeof data.amountReferred === "number" ? data.amountReferred : 0,
        shareMessage: typeof data.shareMessage === "string" ? data.shareMessage : "",
        enabledPlatforms: parseEnabledPlatforms(data.enabledSharePlatforms),
        hideCounts: !!data.hideCounts,
      });
      setStatus("success");
      // In an embed, let the host page react (analytics, redirect, etc.). The
      // embed wrapper bridges this DOM event to a postMessage to the parent.
      if (embedded && typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("vizzybl:signup", {
            detail: {
              alreadyJoined: !!data.alreadyJoined,
              needsVerification: !!data.needsVerification,
              totalSignups: data.totalSignups,
            },
          }),
        );
      }
    } catch {
      setError("Network error — please try again.");
      setStatus("error");
    }
  }

  if (status === "success" && success?.needsVerification) {
    return (
      <section className="space-y-2 rounded-xl border border-neutral-200 p-5 text-center dark:border-neutral-800">
        <h2 className="text-lg font-semibold">Almost there — check your email 📧</h2>
        <p className="text-sm text-neutral-500">
          We sent a confirmation link to lock in your spot. Your place is not
          counted until you confirm.
        </p>
      </section>
    );
  }

  if (status === "success" && success) {
    return (
      <section className="space-y-4 rounded-xl border border-neutral-200 p-5 text-center dark:border-neutral-800">
        <h2 className="text-lg font-semibold">
          {success.alreadyJoined ? "You're already on the list 🎉" : successMessage}
        </h2>
        {!success.hideCounts && success.totalSignups > 0 ? (
          <p className="text-sm text-neutral-500">
            {success.totalSignups.toLocaleString()} people have joined.
          </p>
        ) : null}
        <ShareSection
          referralLink={success.referralLink}
          shareMessage={success.shareMessage}
          enabledPlatforms={success.enabledPlatforms}
          rank={success.rank}
          amountReferred={success.amountReferred}
          hideCounts={success.hideCounts}
          buttonColor={buttonColor}
        />

        {aiConversation?.enabled && success.referralToken ? (
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

        {convoOpen && success.referralToken ? (
          <ConversationModal
            campaignId={campaignId}
            referralToken={success.referralToken}
            introLine={aiConversation?.introLine}
            buttonColor={buttonColor}
            onClose={() => setConvoOpen(false)}
          />
        ) : null}
      </section>
    );
  }

  // Docked: a single inline row with the button tucked inside the email field.
  if (variant === "docked") {
    return (
      <form onSubmit={onSubmit} className="space-y-2">
        <div className="relative">
          <input
            type="email"
            required
            value={email}
            placeholder="you@example.com"
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-full border border-neutral-300 py-2.5 pl-4 pr-28 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          <button
            type="submit"
            disabled={status === "submitting"}
            className="absolute right-1 top-1 bottom-1 rounded-full px-4 text-sm font-semibold text-white disabled:opacity-60"
            style={{ backgroundColor: buttonColor }}
          >
            {status === "submitting" ? "…" : "Join"}
          </button>
        </div>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
      </form>
    );
  }

  // Mini: email + button on one inline row.
  if (variant === "mini") {
    return (
      <form onSubmit={onSubmit} className="space-y-2">
        <div className="flex gap-2">
          <input
            type="email"
            required
            value={email}
            placeholder="you@example.com"
            onChange={(e) => setEmail(e.target.value)}
            className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          <button
            type="submit"
            disabled={status === "submitting"}
            className="shrink-0 rounded-md px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            style={{ backgroundColor: buttonColor }}
          >
            {status === "submitting" ? "Joining…" : "Join"}
          </button>
        </div>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
      </form>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {showName ? (
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name" value={firstName} onChange={setFirstName} required />
          <Field label="Last name" value={lastName} onChange={setLastName} required />
        </div>
      ) : null}

      {showEmail ? (
        <Field
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          required={requiredContactDetail !== "EITHER"}
          placeholder="you@example.com"
        />
      ) : null}

      {showPhone ? (
        <Field
          label="Phone"
          type="tel"
          value={phone}
          onChange={setPhone}
          required={requiredContactDetail === "PHONE" || requiredContactDetail === "BOTH"}
        />
      ) : null}

      {shownQuestions.map((q) => (
        <div key={q.question_value} className="space-y-1">
          <label className="block text-sm font-medium">
            {q.question_value}
            {q.optional ? <span className="text-neutral-400"> (optional)</span> : null}
          </label>
          {q.answer_value ? (
            <select
              required={!q.optional}
              value={answers[q.question_value] ?? ""}
              onChange={(e) => setAnswers((a) => ({ ...a, [q.question_value]: e.target.value }))}
              className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            >
              <option value="">Select…</option>
              {q.answer_value.map((opt) => (
                <option key={opt} value={opt}>{opt}</option>
              ))}
            </select>
          ) : (
            <input
              required={!q.optional}
              value={answers[q.question_value] ?? ""}
              onChange={(e) => setAnswers((a) => ({ ...a, [q.question_value]: e.target.value }))}
              className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
          )}
        </div>
      ))}

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <button
        type="submit"
        disabled={status === "submitting"}
        className="w-full rounded-md px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
        style={{ backgroundColor: buttonColor }}
      >
        {status === "submitting" ? "Joining…" : joinButtonLabel}
      </button>
    </form>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  required = false,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-sm font-medium">{label}</label>
      <input
        type={type}
        value={value}
        required={required}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
      />
    </div>
  );
}
