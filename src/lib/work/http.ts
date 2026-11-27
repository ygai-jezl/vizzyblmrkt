import { NextResponse } from "next/server";
import type { ZodError } from "zod";
import { getAdminContext } from "@/lib/auth/session";
import { sameOriginGuard } from "@/lib/http/sameOrigin";
import { readRequestTextCapped } from "@/lib/http/readBody";
import { forgetReviewCount } from "@/lib/review/summary";
import { isWorkEnabled } from "./flags";
import { invalidInput, type WorkResult } from "./result";
import { workScopeFor, type WorkScope } from "./scope";
import { WORK_MESSAGES } from "./words";

/**
 * The one gate for every route under /api/admin/work (ADR-0020), in the order the build-a-feature
 * skill sets: the origin check, then WORK_ENABLED (404 while off, as if the route weren't there),
 * then sign in, then who the person is in Work (src/lib/work/scope.ts), read live. The
 * organisation, a brand's region and a role never come from the request.
 * src/lib/work/routesGate.test.ts holds every route to it.
 */

const NO_STORE = { "cache-control": "no-store" };

export type WorkGate = { ok: true; scope: WorkScope } | { ok: false; response: Response };

function json(status: number, body: unknown): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export async function workAdmin(req: Request): Promise<WorkGate> {
  const blocked = sameOriginGuard(req);
  if (blocked) return { ok: false, response: blocked };
  if (!isWorkEnabled()) return { ok: false, response: json(404, { error: "not_found" }) };
  const ctx = await getAdminContext();
  if (!ctx) return { ok: false, response: json(401, { error: "unauthorized" }) };
  const r = await workScopeFor(ctx);
  if (r.ok) return { ok: true, scope: r.scope };
  if (r.why === "signed_out") return { ok: false, response: json(401, { error: "unauthorized" }) };
  if (r.why === "no_brand") return { ok: false, response: json(403, { error: "forbidden" }) };
  return { ok: false, response: json(409, { error: "no_organisation", message: WORK_MESSAGES.no_organisation }) };
}

/** A service result as a response. */
export function respond<T>(r: WorkResult<T>): NextResponse {
  if (r.ok) return json(r.status, r.value);
  return json(r.status, { error: r.error, message: r.message, ...(r.issues ? { issues: r.issues } : {}) });
}

/**
 * A service result as a response, after a write that can change what Review counts (a check, a
 * task's status, a new or deleted task): a success forgets the brand's cached Review count, so
 * the sidebar shows it on its next poll.
 */
export function respondChanged<T>(scope: WorkScope, r: WorkResult<T>): NextResponse {
  if (r.ok) forgetReviewCount(scope.ctx.tenantId);
  return respond(r);
}

/** A body or query that doesn't parse: 400 with its first issues. */
export function badInput(error: ZodError): NextResponse {
  return respond(invalidInput(error.issues));
}

/** The most a task, log or check body may be: a task's longest text and links fit well inside it. */
export const BODY_MAX_BYTES = 128_000;

/**
 * The JSON body, read up to `maxBytes`: undefined when there is none, it isn't JSON, or it is
 * longer (the shape then refuses it); "too_big" when it is longer, for routes that say so.
 */
export async function jsonBody(req: Request, maxBytes: number = BODY_MAX_BYTES): Promise<unknown> {
  const text = await readRequestTextCapped(req, maxBytes);
  if (text === null) return TOO_BIG;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** What jsonBody answers for a body over its cap. */
export const TOO_BIG = Symbol("too_big");

/** A task's ref from the address: 1 to 6 digits, or null. */
export function refParam(ref: string): number | null {
  return /^\d{1,6}$/.test(ref) && Number(ref) >= 1 ? Number(ref) : null;
}
