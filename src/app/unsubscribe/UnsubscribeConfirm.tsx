"use client";

import { useState } from "react";

/**
 * The confirm control on the hosted preference page. Posts the signed token to
 * /api/unsubscribe (JSON) and swaps to a confirmation on success. The one-click
 * List-Unsubscribe header hits the same endpoint without this page.
 *
 * For a lifecycle email (a v2 token with a category, e.g. "Onboarding tips") it
 * offers both: stop just that category, or unsubscribe from everything.
 */
export function UnsubscribeConfirm({
  token,
  brand,
  email,
  categoryLabel = null,
  categoryOff = false,
}: {
  token: string;
  brand: string;
  email: string;
  categoryLabel?: string | null;
  categoryOff?: boolean;
}) {
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");
  const [done, setDone] = useState<"category" | "all" | null>(categoryOff ? "category" : null);

  async function unsubscribe(scope: "category" | "all") {
    setState("busy");
    try {
      const res = await fetch("/api/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ u: token, scope }),
      });
      if (res.ok) {
        setDone(scope);
        setState("idle");
      } else {
        setState("error");
      }
    } catch {
      setState("error");
    }
  }

  const button =
    "rounded-md px-4 py-2 text-sm font-semibold disabled:opacity-50";
  const primary = `${button} bg-neutral-900 text-white dark:bg-white dark:text-neutral-900`;
  const secondary = `${button} border border-neutral-300 text-neutral-800 dark:border-neutral-700 dark:text-neutral-200`;

  if (done === "all" || (done && !categoryLabel)) {
    return (
      <p className="text-sm text-neutral-600 dark:text-neutral-300">
        You&rsquo;ve been unsubscribed{email ? ` — ${email}` : ""}. You won&rsquo;t receive any more
        marketing emails from {brand}.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {done === "category" && categoryLabel ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-300">
          You won&rsquo;t get any more {categoryLabel.toLowerCase()} from {brand}
          {email ? ` (${email})` : ""}. Other emails from {brand} may still arrive.
        </p>
      ) : (
        <p className="text-sm text-neutral-600 dark:text-neutral-300">
          {email ? <span className="font-medium">{email}</span> : "This address"} is subscribed to
          {categoryLabel ? ` ${categoryLabel.toLowerCase()} and other` : ""} marketing emails from {brand}.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {categoryLabel && done !== "category" ? (
          <button type="button" onClick={() => void unsubscribe("category")} disabled={state === "busy"} className={primary}>
            {state === "busy" ? "Saving…" : `Stop ${categoryLabel.toLowerCase()}`}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void unsubscribe("all")}
          disabled={state === "busy"}
          className={categoryLabel ? secondary : primary}
        >
          {state === "busy" && !categoryLabel ? "Unsubscribing…" : categoryLabel ? "Unsubscribe from everything" : "Unsubscribe"}
        </button>
      </div>
      {state === "error" ? (
        <p className="text-sm text-red-600 dark:text-red-400">Something went wrong — please try again.</p>
      ) : null}
    </div>
  );
}
