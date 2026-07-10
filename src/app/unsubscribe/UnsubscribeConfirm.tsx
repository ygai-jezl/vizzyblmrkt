"use client";

import { useState } from "react";

/**
 * The confirm control on the hosted preference page. Posts the signed token to
 * /api/unsubscribe (JSON) and swaps to a confirmation on success. The one-click
 * List-Unsubscribe header hits the same endpoint without this page.
 */
export function UnsubscribeConfirm({
  token,
  brand,
  email,
}: {
  token: string;
  brand: string;
  email: string;
}) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");

  async function unsubscribe() {
    setState("busy");
    try {
      const res = await fetch("/api/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ u: token }),
      });
      setState(res.ok ? "done" : "error");
    } catch {
      setState("error");
    }
  }

  if (state === "done") {
    return (
      <p className="text-sm text-neutral-600 dark:text-neutral-300">
        You&rsquo;ve been unsubscribed{email ? ` — ${email}` : ""}. You won&rsquo;t receive any more
        marketing emails from {brand}.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-neutral-600 dark:text-neutral-300">
        {email ? <span className="font-medium">{email}</span> : "This address"} is subscribed to
        marketing emails from {brand}. Unsubscribe to stop receiving them.
      </p>
      <button
        type="button"
        onClick={() => void unsubscribe()}
        disabled={state === "busy"}
        className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
      >
        {state === "busy" ? "Unsubscribing…" : "Unsubscribe"}
      </button>
      {state === "error" ? (
        <p className="text-sm text-red-600 dark:text-red-400">
          Something went wrong — please try again.
        </p>
      ) : null}
    </div>
  );
}
