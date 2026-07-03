/**
 * X (Twitter) publish adapter — posts a scheduled post to X via the API v2.
 * Grounded in docs.x.com/x-api: POST https://api.x.com/2/tweets with `{ text }`,
 * threads via `reply.in_reply_to_tweet_id` chaining, USER-context OAuth 2.0 bearer
 * token (app-only bearer can't post), response id at `data.id`. Free tier posts.
 *
 * Pure over an injectable fetch → fully unit-testable with no network. The caller
 * (the Distribute worker) supplies the tenant's decrypted user access token.
 *
 * NOTE: X has NO native idempotency key. A thread that posts PART way then fails
 * returns a `*_partial` reason so the caller does NOT blindly retry the whole
 * thread (which would duplicate). Exactly-once wiring (transactional claim + resume
 * of a partial thread) lands with the worker-integration slice.
 */

const X_TWEETS_ENDPOINT = "https://api.x.com/2/tweets";

/**
 * Hard wall-time budget for the WHOLE publish (all thread parts). MUST stay well
 * under the Distribute worker's claim lease (LEASE_MS = 5 min): the exactly-once
 * guarantee relies on a publish finishing inside its claim, so a slow/hung send is
 * aborted here rather than outliving its lease and being reclaimed + re-posted by
 * the next cron drain.
 */
const PUBLISH_BUDGET_MS = 120_000;

export interface XPublishInput {
  /** Ordered thread parts (each ≤280). A single-element array is one tweet. */
  parts: string[];
  /** User-context OAuth 2.0 access token (tweet.write). */
  accessToken: string;
}

export type XPublishResult =
  | { ok: true; remoteId: string; url: string }
  | { ok: false; reason: string };

export interface XPublishDeps {
  fetch?: typeof fetch;
  endpoint?: string;
  /** Override the wall-time budget (tests). Defaults to PUBLISH_BUDGET_MS. */
  timeoutMs?: number;
}

export async function publishToX(
  input: XPublishInput,
  deps: XPublishDeps = {},
): Promise<XPublishResult> {
  if (!input.accessToken) return { ok: false, reason: "not_connected" };
  // Each part is trimmed (leading/trailing whitespace is never wanted on a tweet)
  // and empty parts are dropped; internal newlines are preserved.
  const parts = input.parts.map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return { ok: false, reason: "empty" };

  const doFetch = deps.fetch ?? fetch;
  const endpoint = deps.endpoint ?? X_TWEETS_ENDPOINT;

  // Bound the whole publish so it can't outlive the worker's claim lease. On abort,
  // any in-flight AND every subsequent fetch reject immediately.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? PUBLISH_BUDGET_MS);

  let firstId: string | null = null;
  let prevId: string | null = null;

  try {
    for (const text of parts) {
      const partial = firstId ? "_partial" : ""; // some tweets already posted
      const body: Record<string, unknown> = { text };
      if (prevId) body.reply = { in_reply_to_tweet_id: prevId };

      let res: Response;
      try {
        res = await doFetch(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${input.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch {
        // A budget abort is AMBIGUOUS (X may have received the request) → distinct
        // `timeout` reason so the caller parks instead of blind-retrying (dup risk);
        // a plain fetch failure before send is a clean `network_error` (retryable).
        const reason = controller.signal.aborted ? "timeout" : "network_error";
        return { ok: false, reason: `${reason}${partial}` };
      }
      if (!res.ok) {
        const detail = await readErrorDetail(res);
        return { ok: false, reason: `x_api_${res.status}${partial}${detail ? `:${detail}` : ""}` };
      }
      const data = (await res.json().catch(() => null)) as { data?: { id?: string } } | null;
      const id = data?.data?.id;
      // A 2xx with no readable id means a tweet was very likely CREATED but its id is
      // unconfirmed (unreadable body). Signal that distinctly so the caller does NOT
      // blindly retry (X has no idempotency key → a retry would duplicate).
      if (!id) return { ok: false, reason: `created_unconfirmed${partial}` };

      if (!firstId) firstId = id;
      prevId = id;
    }

    return {
      ok: true,
      remoteId: firstId!,
      url: `https://x.com/i/web/status/${firstId}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract a short, single-line reason from an X error body so the stored
 * `lastError` explains WHY X refused (e.g. "requires a different access level")
 * instead of only a status code. X error bodies never echo the auth header, so
 * this is safe to persist; still whitespace-collapsed + length-capped defensively.
 * Returns "" when the body carries no useful message (e.g. `{}`).
 */
async function readErrorDetail(res: Response): Promise<string> {
  const raw = await res.text().catch(() => "");
  if (!raw) return "";
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const errs = j.errors as Array<{ message?: string }> | undefined;
    const msg = j.detail ?? j.title ?? errs?.[0]?.message;
    return msg ? String(msg).replace(/\s+/g, " ").trim().slice(0, 140) : "";
  } catch {
    // Non-JSON body (e.g. an HTML error page) → a trimmed snippet still helps.
    return raw.replace(/\s+/g, " ").trim().slice(0, 140);
  }
}
