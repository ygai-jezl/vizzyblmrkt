import { isBlogDatesEnabled } from "@/lib/brandMap/flags";
import { isValidTimezone } from "@/lib/lifecycle/sendWindow";
import { getTenantById } from "@/lib/tenant";
import { setTenantTimeZone } from "@/lib/tenant/control";
import type { TenantContext } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";

/**
 * Settings › General › Time zone (BLOG_DATES_ENABLED): the zone a brand's article dates are
 * written in. Everyone on the brand reads it; admins change it.
 */

export type ApiResult = { status: number; body: unknown };

export interface TimeZoneDeps {
  loadTenant?: (id: string) => Promise<Tenant | null>;
  save?: typeof setTenantTimeZone;
}

/** The brand's zone ("UTC" until one is set), and whether one is set. */
export async function readTimeZone(ctx: TenantContext, deps: TimeZoneDeps = {}): Promise<ApiResult> {
  if (!isBlogDatesEnabled()) return { status: 503, body: { error: "unavailable" } };
  const tenant = await (deps.loadTenant ?? getTenantById)(ctx.tenantId).catch(() => null);
  const stored = tenant?.timeZone;
  const zone = isValidTimezone(stored) ? stored : null;
  return { status: 200, body: { timeZone: zone ?? "UTC", chosen: zone !== null } };
}

/** Admins set the zone: `{ timeZone: "Europe/London" }`, or `{ timeZone: null }` for UTC. */
export async function saveTimeZone(ctx: TenantContext, raw: unknown, deps: TimeZoneDeps = {}): Promise<ApiResult> {
  if (!isBlogDatesEnabled()) return { status: 503, body: { error: "unavailable" } };
  if (ctx.role !== "admin") return { status: 403, body: { error: "forbidden" } };
  const body = raw as { timeZone?: unknown } | null;
  const save = deps.save ?? setTenantTimeZone;
  if (body && body.timeZone === null) {
    return (await save(ctx.tenantId, null)) ? { status: 200, body: { timeZone: "UTC", chosen: false } } : { status: 404, body: { error: "not_found" } };
  }
  const zone = typeof body?.timeZone === "string" ? body.timeZone.trim() : "";
  if (!zone || zone.length > 64 || !isValidTimezone(zone)) return { status: 400, body: { error: "invalid_time_zone" } };
  return (await save(ctx.tenantId, zone)) ? { status: 200, body: { timeZone: zone, chosen: true } } : { status: 404, body: { error: "not_found" } };
}
