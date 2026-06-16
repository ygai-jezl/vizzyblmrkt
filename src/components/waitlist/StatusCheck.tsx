"use client";

import { useState } from "react";
import { getRecaptchaToken } from "@/lib/security/recaptchaClient";
import { parseEnabledPlatforms } from "@/lib/waitlist/socialPlatforms";
import { ShareSection } from "./ShareSection";

interface StatusResult {
  status: "verified_active" | "unverified" | "offboarded";
  message?: string;
  rank?: number | null;
  amountReferred?: number;
  referralLink?: string;
  hideCounts?: boolean;
  shareMessage?: string;
  enabledSharePlatforms?: string[];
}

/**
 * "Signed up before? Check your status." Collapsed to a link on the hosted page;
 * rendered open as the whole widget in the embed's CHECK mode (`defaultOpen`).
 * Posts the email to /api/waitlist/[id]/status and shows the returning user's
 * position + referral count + share buttons via the shared ShareSection.
 */
export function StatusCheck({
  campaignId,
  buttonColor,
  defaultOpen = false,
}: {
  campaignId: string;
  buttonColor: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "error" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<StatusResult | null>(null);

  function reset() {
    setStatus("idle");
    setResult(null);
    setError(null);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus("submitting");
    setError(null);
    setResult(null);
    try {
      const recaptchaToken = await getRecaptchaToken("status");
      const res = await fetch(`/api/waitlist/${campaignId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          ...(recaptchaToken ? { recaptchaToken } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 404) {
        setError("We couldn't find a signup for that email.");
        setStatus("error");
        return;
      }
      if (!res.ok) {
        setError(
          data.error === "captcha_failed"
            ? "Verification failed — please try again."
            : "Something went wrong.",
        );
        setStatus("error");
        return;
      }
      setResult(data as StatusResult);
      setStatus("done");
    } catch {
      setError("Network error — please try again.");
      setStatus("error");
    }
  }

  // Collapsed entry point (hosted page).
  if (!open) {
    return (
      <p className="text-center text-sm text-neutral-500">
        Signed up before?{" "}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="font-medium text-neutral-900 underline underline-offset-2 dark:text-neutral-100"
        >
          Check your status
        </button>
      </p>
    );
  }

  if (status === "done" && result?.status === "verified_active") {
    return (
      <section className="space-y-4 rounded-xl border border-neutral-200 p-5 text-center dark:border-neutral-800">
        <h2 className="text-lg font-semibold">You&apos;re on the waitlist!</h2>
        <ShareSection
          referralLink={result.referralLink ?? ""}
          shareMessage={result.shareMessage ?? ""}
          enabledPlatforms={parseEnabledPlatforms(result.enabledSharePlatforms)}
          rank={result.rank ?? null}
          amountReferred={result.amountReferred ?? 0}
          hideCounts={!!result.hideCounts}
          buttonColor={buttonColor}
        />
        <button
          type="button"
          onClick={reset}
          className="text-xs text-neutral-500 underline underline-offset-2"
        >
          Check another email
        </button>
      </section>
    );
  }

  if (status === "done" && result) {
    // unverified / offboarded — no position to show, just the status message.
    return (
      <section className="space-y-3 rounded-xl border border-neutral-200 p-5 text-center dark:border-neutral-800">
        <h2 className="text-lg font-semibold">
          {result.status === "unverified" ? "Almost there 📧" : "Status update"}
        </h2>
        <p className="text-sm text-neutral-500">{result.message}</p>
        <button
          type="button"
          onClick={reset}
          className="text-xs text-neutral-500 underline underline-offset-2"
        >
          Check another email
        </button>
      </section>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-3 rounded-xl border border-neutral-200 p-5 dark:border-neutral-800"
    >
      <div className="space-y-1 text-center">
        <h2 className="text-base font-semibold">Check your status</h2>
        <p className="text-xs text-neutral-500">
          Enter the email you signed up with.
        </p>
      </div>
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
          {status === "submitting" ? "Checking…" : "Check"}
        </button>
      </div>
      {error ? (
        <p className="text-center text-sm text-red-600">{error}</p>
      ) : null}
    </form>
  );
}
