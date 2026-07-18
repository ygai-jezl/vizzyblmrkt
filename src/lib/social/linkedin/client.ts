/**
 * LinkedIn organic-post adapter — publishes a single post to a member's feed via the
 * official Posts API (POST https://api.linkedin.com/rest/posts). Compliant, sanctioned
 * organic posting (scope `w_member_social`); NOT the ToS-violating DM/connection
 * automation. Author is the connected member's URN (urn:li:person:{id}).
 *
 * Pure over an injectable fetch → fully unit-testable with no network. LinkedIn posts
 * are single (no threads), so there is no `_partial`; but there is no idempotency key
 * either, so an ambiguous 2xx/timeout is signalled distinctly (created_unconfirmed /
 * timeout) so the worker parks rather than blind-retrying (dup risk), mirroring X.
 */

const LINKEDIN_POSTS_ENDPOINT = "https://api.linkedin.com/rest/posts";
/** Posts API is versioned by a YYYYMM header; LinkedIn sunsets versions after ~12
 *  months. Env-overridable (LINKEDIN_API_VERSION) so a future roll is a config flip,
 *  not a redeploy. Keep this at a currently-ACTIVE version. */
const DEFAULT_LINKEDIN_VERSION = process.env.LINKEDIN_API_VERSION ?? "202606";
/** Wall-time budget for the whole publish — MUST stay under the worker lease (5min). */
const PUBLISH_BUDGET_MS = 60_000;

export interface LinkedInPublishInput {
  /** The author URN — `urn:li:person:{id}` (or `urn:li:organization:{id}`). */
  authorUrn: string;
  /** The post body (single post). */
  text: string;
  /** Member OAuth 2.0 access token (w_member_social / w_organization_social). */
  accessToken: string;
  /** Optional image URN from a prior uploadLinkedInImage (see media.ts). When present
   *  it's attached as the post's single-image `content.media`; absent → text-only. */
  imageUrn?: string;
  /** Optional accessibility alt text for the attached image. */
  imageAltText?: string;
}

export type LinkedInPublishResult =
  | { ok: true; remoteId: string; url: string }
  | { ok: false; reason: string };

export interface LinkedInPublishDeps {
  fetch?: typeof fetch;
  endpoint?: string;
  version?: string;
  timeoutMs?: number;
}

export async function postToLinkedIn(
  input: LinkedInPublishInput,
  deps: LinkedInPublishDeps = {},
): Promise<LinkedInPublishResult> {
  if (!input.accessToken) return { ok: false, reason: "not_connected" };
  if (!input.authorUrn) return { ok: false, reason: "no_author" };
  const text = input.text?.trim();
  if (!text) return { ok: false, reason: "empty" };

  const doFetch = deps.fetch ?? fetch;
  const endpoint = deps.endpoint ?? LINKEDIN_POSTS_ENDPOINT;
  const version = deps.version ?? DEFAULT_LINKEDIN_VERSION;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? PUBLISH_BUDGET_MS);

  // A single-image post attaches the pre-uploaded image URN as `content.media`; a
  // text-only post omits `content` entirely (identical to the prior behaviour).
  const body: Record<string, unknown> = {
    author: input.authorUrn,
    commentary: text,
    visibility: "PUBLIC",
    distribution: {
      feedDistribution: "MAIN_FEED",
      targetEntities: [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };
  if (input.imageUrn) {
    body.content = {
      media: {
        id: input.imageUrn,
        ...(input.imageAltText ? { altText: input.imageAltText } : {}),
      },
    };
  }

  try {
    let res: Response;
    try {
      res = await doFetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.accessToken}`,
          "content-type": "application/json",
          "linkedin-version": version,
          "x-restli-protocol-version": "2.0.0",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      // Budget abort is AMBIGUOUS (LinkedIn may have received it) → distinct timeout.
      const reason = controller.signal.aborted ? "timeout" : "network_error";
      return { ok: false, reason };
    }
    if (!res.ok) {
      const detail = await readLinkedInError(res);
      return { ok: false, reason: `li_api_${res.status}${detail ? `:${detail}` : ""}` };
    }
    // The created post's URN comes back in the `x-restli-id` response header (the
    // Posts API leaves the body empty on 201); fall back to a body `id` if present.
    const headerUrn = res.headers?.get?.("x-restli-id") ?? null;
    const bodyUrn = headerUrn
      ? null
      : ((await res.json().catch(() => null)) as { id?: string } | null)?.id ?? null;
    const urn = headerUrn ?? bodyUrn;
    // A 2xx with no readable id means the post was very likely CREATED but its id is
    // unconfirmed → signal distinctly so the caller does NOT blind-retry (no idempotency key).
    if (!urn) return { ok: false, reason: "created_unconfirmed" };

    return { ok: true, remoteId: urn, url: `https://www.linkedin.com/feed/update/${urn}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Short, single-line reason from a LinkedIn error body (never echoes the token). */
async function readLinkedInError(res: Response): Promise<string> {
  const raw = await res.text().catch(() => "");
  if (!raw) return "";
  try {
    const j = JSON.parse(raw) as { message?: unknown; code?: unknown };
    const msg = typeof j.message === "string" ? j.message : typeof j.code === "string" ? j.code : "";
    return msg ? msg.replace(/\s+/g, " ").trim().slice(0, 140) : "";
  } catch {
    return raw.replace(/\s+/g, " ").trim().slice(0, 140);
  }
}
