/**
 * LinkedIn Company-Page post analytics adapter — reads a published org post's organic
 * engagement via the Community Management API:
 *   GET /rest/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity={orgUrn}
 * keyed by the specific post's URN (shares=List(...) or ugcPosts=List(...) by URN type).
 *
 * Approved scope: `rw_organization_admin` ("retrieve reporting data"); the connected
 * member must be a Page ADMINISTRATOR. Doc:
 * learn.microsoft.com/linkedin/marketing/community-management/organizations/share-statistics
 *
 * Constraints baked in from the doc: ORGANIC-ONLY (sponsored activity needs Ad Analytics),
 * cumulative lifetime counts over a rolling 12-month window, and NO pagination. Pure over
 * an injectable fetch → unit-testable with no network. Mirrors fetchXPublicMetrics: the
 * caller (the Distribute harvest worker) supplies the tenant's decrypted org access token.
 *
 * A post with no engagement yet is simply absent from `elements` (the doc: "shares with no
 * actions or impressions are not included … can be assumed to have counts of 0"), so a
 * missing element is reported as an all-zero success, NOT an error.
 */

const LINKEDIN_STATS_ENDPOINT =
  "https://api.linkedin.com/rest/organizationalEntityShareStatistics";
/** Versioned by a YYYYMM header (LinkedIn sunsets versions after ~12 months). Env-overridable
 *  so a version roll is a config flip, matching client.ts / orgs.ts. */
const DEFAULT_LINKEDIN_VERSION = process.env.LINKEDIN_API_VERSION ?? "202606";
const CALL_TIMEOUT_MS = 15_000;

/** Normalized, cross-platform-friendly organic metrics for one company-page post. */
export interface LinkedInShareMetrics {
  impressions: number;
  uniqueImpressions: number;
  clicks: number;
  likes: number;
  comments: number;
  shares: number;
  /** LinkedIn's own engagement ratio (organic actions / impressions). */
  engagement: number;
}

export type LinkedInStatsResult =
  | { ok: true; metrics: LinkedInShareMetrics }
  | { ok: false; reason: string };

export interface FetchShareStatsInput {
  /** The org whose page owns the post — `urn:li:organization:{id}`. */
  orgUrn: string;
  /** The published post URN from publishedRef.remoteId — `urn:li:share:{id}` or `urn:li:ugcPost:{id}`. */
  postUrn: string;
}

export interface FetchShareStatsDeps {
  fetch?: typeof fetch;
  endpoint?: string;
  version?: string;
  timeoutMs?: number;
}

const ZERO: LinkedInShareMetrics = {
  impressions: 0,
  uniqueImpressions: 0,
  clicks: 0,
  likes: 0,
  comments: 0,
  shares: 0,
  engagement: 0,
};

/**
 * Build the per-post query fragment. The stats API keys the post by `shares=List(...)` or
 * `ugcPosts=List(...)` depending on the URN type (restli 2.0 List syntax, matching our
 * `x-restli-protocol-version: 2.0.0` header). Returns null for an unrecognized URN so the
 * caller fails cleanly rather than sending a malformed query.
 */
export function sharesQueryParam(postUrn: string): string | null {
  if (postUrn.startsWith("urn:li:share:")) {
    return `shares=List(${encodeURIComponent(postUrn)})`;
  }
  if (postUrn.startsWith("urn:li:ugcPost:")) {
    return `ugcPosts=List(${encodeURIComponent(postUrn)})`;
  }
  return null;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export async function fetchLinkedInShareStatistics(
  accessToken: string,
  input: FetchShareStatsInput,
  deps: FetchShareStatsDeps = {},
): Promise<LinkedInStatsResult> {
  if (!accessToken) return { ok: false, reason: "not_connected" };
  if (!input.orgUrn) return { ok: false, reason: "no_org" };
  const postParam = input.postUrn ? sharesQueryParam(input.postUrn) : null;
  if (!postParam) return { ok: false, reason: "bad_post_urn" };

  const doFetch = deps.fetch ?? fetch;
  const base = deps.endpoint ?? LINKEDIN_STATS_ENDPOINT;
  const version = deps.version ?? DEFAULT_LINKEDIN_VERSION;
  const url =
    `${base}?q=organizationalEntity` +
    `&organizationalEntity=${encodeURIComponent(input.orgUrn)}` +
    `&${postParam}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? CALL_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await doFetch(url, {
        headers: {
          authorization: `Bearer ${accessToken}`,
          "linkedin-version": version,
          "x-restli-protocol-version": "2.0.0",
          accept: "application/json",
        },
        signal: controller.signal,
      });
    } catch {
      return { ok: false, reason: controller.signal.aborted ? "timeout" : "network_error" };
    }
    if (!res.ok) {
      const detail = await readLinkedInError(res);
      return { ok: false, reason: `li_api_${res.status}${detail ? `:${detail}` : ""}` };
    }
    const data = (await res.json().catch(() => null)) as {
      elements?: Array<{ totalShareStatistics?: Record<string, unknown> }>;
    } | null;
    // Absent element = a post with zero organic actions/impressions (per the doc), NOT a
    // failure — the harvest still records a valid zero snapshot.
    const stats = data?.elements?.[0]?.totalShareStatistics;
    if (!stats) return { ok: true, metrics: { ...ZERO } };
    return {
      ok: true,
      metrics: {
        impressions: num(stats.impressionCount),
        uniqueImpressions: num(stats.uniqueImpressionsCount),
        clicks: num(stats.clickCount),
        likes: num(stats.likeCount),
        comments: num(stats.commentCount),
        shares: num(stats.shareCount),
        engagement: num(stats.engagement),
      },
    };
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
