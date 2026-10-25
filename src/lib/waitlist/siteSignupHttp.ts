import { isRateLimited, type RateLimitConfig } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { readRequestTextCapped } from "@/lib/http/readBody";
import { fieldErrors } from "@/lib/connect/v2/contract";
import { isSiteSignupsEnabled } from "./siteFlags";
import { authenticateSiteKey } from "./siteKeyAuth";
import { addSiteSignup, type SiteSignupDeps } from "./siteSignup";
import { SITE_SIGNUP_LIMITS, SiteSignupRequestSchema } from "./siteSignupContract";

/**
 * The HTTP side of POST /api/v2/signups. Server to server only (no CORS). The gate
 * runs in this order, like API v2's:
 *
 *  1. the switch (404 while sign-ups from your site are off);
 *  2. a size-capped body read (413);
 *  3. HTTP Basic auth with the launch's site key (401; 503 when the server can't check);
 *  4. THEN the per-key rate limit, so a bad secret never burns a real key's quota (429);
 *  5. JSON + schema (400 naming the field), then the sign-up.
 */

export interface SiteSignupHttpDeps extends Omit<SiteSignupDeps, "nowMs"> {
  db?: FirestoreLike;
  nowMs?: () => number;
  /** Override the durable rate limiter (tests). */
  rateLimit?: (keyId: string) => Promise<boolean>;
}

export const SITE_SIGNUP_RATE_LIMIT: RateLimitConfig = {
  prefix: "site_signups",
  burstLimit: SITE_SIGNUP_LIMITS.perMinute,
  hourlyLimit: SITE_SIGNUP_LIMITS.perHour,
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

export async function handleSiteSignup(req: Request, deps: SiteSignupHttpDeps = {}): Promise<Response> {
  if (!isSiteSignupsEnabled()) {
    return json(404, { error: "site_signups_disabled", message: "Sign-ups from your site aren't turned on for this YouGrow." });
  }
  const nowMs = (deps.nowMs ?? Date.now)();
  const raw = await readRequestTextCapped(req, SITE_SIGNUP_LIMITS.maxBodyBytes);
  if (raw === null) return json(413, { error: "body_too_large", message: `At most ${SITE_SIGNUP_LIMITS.maxBodyBytes / 1024} KB.` });

  const auth = await authenticateSiteKey(req.headers.get("authorization"), nowMs, deps.db);
  if (!auth.ok) {
    return auth.status === 503
      ? json(503, { error: "unavailable" }, { "retry-after": "5" })
      : json(401, { error: "unauthorized", message: "Use HTTP Basic auth: your site key id as the username, its secret as the password." }, {
          "www-authenticate": 'Basic realm="YouGrow sign-ups", charset="UTF-8"',
        });
  }
  const limited = deps.rateLimit ?? ((k: string) => isRateLimited(k, SITE_SIGNUP_RATE_LIMIT, { db: deps.db, now: nowMs }));
  if (await limited(auth.key.keyId)) return json(429, { error: "rate_limited" }, { "retry-after": "60" });

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const parsed = SiteSignupRequestSchema.safeParse(value);
  if (!parsed.success) return json(400, { error: "invalid", fields: fieldErrors(parsed.error) });

  try {
    const out = await addSiteSignup(auth.ctx, auth.key, parsed.data, { db: deps.db, nowMs, send: deps.send });
    if (out.ok) return json(out.reply.status === "confirmation_sent" ? 202 : 200, out.reply);
    if (out.error === "launch_closed") return json(409, { error: "launch_closed", message: "This launch is archived, so it takes no new sign-ups." });
    if (out.error === "unauthorized") return json(401, { error: "unauthorized" });
    return json(503, { error: "email_unavailable", message: "The confirmation email couldn't be sent. Try again shortly." }, { "retry-after": "60" });
  } catch (err) {
    console.error(`[site-signups] sign-up failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`);
    return json(500, { error: "internal" });
  }
}
