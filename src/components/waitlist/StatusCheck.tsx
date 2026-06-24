"use client";

import { useState } from "react";
import { getRecaptchaToken } from "@/lib/security/recaptchaClient";
import { appendTenantParam } from "@/lib/http/tenantParam";
import { parseEnabledPlatforms } from "@/lib/waitlist/socialPlatforms";
import { translate, type MessageCatalog } from "@/lib/i18n/messages";
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
  messages,
  locale,
}: {
  campaignId: string;
  buttonColor: string;
  defaultOpen?: boolean;
  messages: MessageCatalog;
  locale: string;
}) {
  const t = (key: string, vars?: Record<string, string | number>) =>
    translate(messages, key, vars);
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
      const res = await fetch(
        appendTenantParam(`/api/waitlist/${campaignId}/status`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: email.trim(),
            ...(recaptchaToken ? { recaptchaToken } : {}),
          }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (res.status === 404) {
        setError(t("widget.status.notFound"));
        setStatus("error");
        return;
      }
      if (!res.ok) {
        setError(
          data.error === "captcha_failed"
            ? t("widget.status.captchaFailed")
            : t("widget.common.error"),
        );
        setStatus("error");
        return;
      }
      setResult(data as StatusResult);
      setStatus("done");
    } catch {
      setError(t("widget.common.networkError"));
      setStatus("error");
    }
  }

  // Collapsed entry point (hosted page).
  if (!open) {
    return (
      <p className="text-center text-sm text-neutral-500">
        {t("widget.status.signedUpBefore")}{" "}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="font-medium text-neutral-900 underline underline-offset-2 dark:text-neutral-100"
        >
          {t("widget.status.checkStatus")}
        </button>
      </p>
    );
  }

  if (status === "done" && result?.status === "verified_active") {
    return (
      <section className="space-y-4 rounded-xl border border-neutral-200 p-5 text-center dark:border-neutral-800">
        <h2 className="text-lg font-semibold">{t("widget.status.onWaitlist")}</h2>
        <ShareSection
          referralLink={result.referralLink ?? ""}
          shareMessage={result.shareMessage ?? ""}
          enabledPlatforms={parseEnabledPlatforms(result.enabledSharePlatforms)}
          rank={result.rank ?? null}
          amountReferred={result.amountReferred ?? 0}
          hideCounts={!!result.hideCounts}
          buttonColor={buttonColor}
          messages={messages}
          locale={locale}
        />
        <button
          type="button"
          onClick={reset}
          className="text-xs text-neutral-500 underline underline-offset-2"
        >
          {t("widget.status.checkAnother")}
        </button>
      </section>
    );
  }

  if (status === "done" && result) {
    // unverified / offboarded — no position to show, just the status message.
    return (
      <section className="space-y-3 rounded-xl border border-neutral-200 p-5 text-center dark:border-neutral-800">
        <h2 className="text-lg font-semibold">
          {result.status === "unverified"
            ? t("widget.status.almostThere")
            : t("widget.status.statusUpdate")}
        </h2>
        <p className="text-sm text-neutral-500">{result.message}</p>
        <button
          type="button"
          onClick={reset}
          className="text-xs text-neutral-500 underline underline-offset-2"
        >
          {t("widget.status.checkAnother")}
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
        <h2 className="text-base font-semibold">{t("widget.status.checkStatus")}</h2>
        <p className="text-xs text-neutral-500">{t("widget.status.enterEmail")}</p>
      </div>
      <div className="flex gap-2">
        <input
          type="email"
          required
          value={email}
          placeholder={t("widget.signup.emailPlaceholder")}
          onChange={(e) => setEmail(e.target.value)}
          className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button
          type="submit"
          disabled={status === "submitting"}
          className="shrink-0 rounded-md px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
          style={{ backgroundColor: buttonColor }}
        >
          {status === "submitting" ? t("widget.status.checking") : t("widget.status.check")}
        </button>
      </div>
      {error ? (
        <p className="text-center text-sm text-red-600">{error}</p>
      ) : null}
    </form>
  );
}
