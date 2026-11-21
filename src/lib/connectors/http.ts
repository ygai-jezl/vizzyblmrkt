import { NextResponse } from "next/server";
import type { ServiceResult } from "./service";

/**
 * Responses for the connector routes. With CONNECTORS_ENABLED off every route answers 404 before
 * it reads the session, so a copy with the switch off looks as if the routes weren't there.
 */

export function connectorsOff(): NextResponse {
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

export function respond<T>(r: ServiceResult<T>): NextResponse {
  if (r.ok) return NextResponse.json(r.value, { status: r.status, headers: { "cache-control": "no-store" } });
  return NextResponse.json({ error: r.error, ...(r.message ? { message: r.message } : {}) }, { status: r.status, headers: { "cache-control": "no-store" } });
}

/** The JSON body, or undefined when there is none or it isn't JSON (the service answers 400). */
export async function jsonBody(req: Request): Promise<unknown> {
  return req.json().catch(() => undefined);
}
