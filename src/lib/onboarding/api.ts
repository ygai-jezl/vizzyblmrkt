import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import type { AdminGate } from "@/lib/connect/admin";
import { isRateLimited, type RateLimitConfig } from "@/lib/tenant/rateLimit";
import type { TenantContext } from "@/lib/tenant/types";
import { isOnboardingEnabled, isOnboardingVoiceEnabled } from "./flags";

/**
 * The gate for the getting to know you APIs (/api/admin/onboarding/**): the origin, the switch the
 * route needs, sign-in and admin, in that order. Only admins tell Vizzy about the business, so
 * members get 403 everywhere here.
 *
 * `need`: "onboarding" for ONBOARDING_ENABLED, "voice" for ONBOARDING_VOICE_ENABLED (which needs
 * the first), "none" for reads and deletes of what is already kept, so kept words can always be
 * read and deleted.
 */
export type OnboardingNeed = "onboarding" | "voice" | "none";

const json = (status: number, body: unknown) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

export async function onboardingAdmin(req: Request, opts: { need: OnboardingNeed }): Promise<AdminGate> {
  const blocked = sameOriginGuard(req);
  if (blocked) return { ok: false, response: blocked };
  if (opts.need === "onboarding" && !isOnboardingEnabled()) return { ok: false, response: json(503, { error: "onboarding_disabled" }) };
  if (opts.need === "voice" && !isOnboardingVoiceEnabled()) return { ok: false, response: json(503, { error: "voice_disabled" }) };
  const ctx = await getAdminContext();
  if (!ctx) return { ok: false, response: json(401, { error: "unauthorized" }) };
  if (ctx.role !== "admin") return { ok: false, response: json(403, { error: "forbidden" }) };
  return { ok: true, ctx };
}

/** 400 with the first few problems, named by field. */
export function invalidInput(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): Response {
  return json(400, {
    error: "invalid_input",
    issues: issues.slice(0, 5).map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`),
  });
}

/** 429 when this admin is over `limit` in this brand, else null (it counts the request). */
export async function limitPerUser(ctx: TenantContext, limit: RateLimitConfig): Promise<Response | null> {
  return (await isRateLimited(`user:${ctx.tenantId}:${ctx.userId ?? "anon"}`, limit)) ? json(429, { error: "rate_limited" }) : null;
}

/** A store's refusal as a response: its status and error (and the length kept, for out of order). */
export function refused(r: { status: number; error: string; length?: number }): Response {
  return json(r.status, { error: r.error, ...(r.length !== undefined ? { length: r.length } : {}) });
}

/** A success, never cached. */
export function ok(body: unknown): Response {
  return json(200, body);
}

/** An id in the path that can't be one: 400, like any other bad input. */
export function badId(what: string): Response {
  return json(400, { error: "invalid_input", issues: [`${what}: not a valid id`] });
}

/**
 * A call's upload, read whole and measured before it is parsed: 413 past `maxBytes` (a page sends
 * its last words as it closes, under the browser's 64 kB limit), 400 when it isn't JSON. An empty
 * body reads as `{}`.
 */
export async function readJsonBody(req: Request, maxBytes: number): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const text = await req.text().catch(() => null);
  if (text === null) return { ok: false, response: json(400, { error: "invalid_input", issues: ["body: unreadable"] }) };
  if (new TextEncoder().encode(text).length > maxBytes) return { ok: false, response: json(413, { error: "too_large" }) };
  if (!text.trim()) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: json(400, { error: "invalid_input", issues: ["body: not JSON"] }) };
  }
}

/** Any error, never cached. */
export function fail(status: number, error: string): Response {
  return json(status, { error });
}
