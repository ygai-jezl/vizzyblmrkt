import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/lib/tenant/types";
import type { Tenant } from "@/lib/types/tenant";
import { readTimeZone, saveTimeZone } from "./datesAdmin";

const MEMBER: TenantContext = { tenantId: "ten_A", region: "us", source: "idtoken", role: "member" };
const ADMIN: TenantContext = { ...MEMBER, role: "admin" };
const tenant = (timeZone?: string) => ({ id: "ten_A", timeZone }) as unknown as Tenant;

beforeEach(() => vi.stubEnv("BLOG_DATES_ENABLED", "true"));
afterEach(() => vi.unstubAllEnvs());

describe("the brand's time zone", () => {
  it("reads UTC until one is set, and a damaged one as unset", async () => {
    expect(await readTimeZone(MEMBER, { loadTenant: async () => tenant() })).toEqual({ status: 200, body: { timeZone: "UTC", chosen: false } });
    expect(await readTimeZone(MEMBER, { loadTenant: async () => tenant("Mars/Olympus") })).toEqual({ status: 200, body: { timeZone: "UTC", chosen: false } });
    expect(await readTimeZone(MEMBER, { loadTenant: async () => tenant("Europe/London") })).toEqual({ status: 200, body: { timeZone: "Europe/London", chosen: true } });
  });

  it("lets only admins set it, and only to a real zone", async () => {
    const save = vi.fn(async () => true);
    expect(await saveTimeZone(MEMBER, { timeZone: "Europe/London" }, { save })).toEqual({ status: 403, body: { error: "forbidden" } });
    for (const bad of ["Mars/Olympus", "", 42, "x".repeat(65)]) {
      expect(await saveTimeZone(ADMIN, { timeZone: bad }, { save })).toEqual({ status: 400, body: { error: "invalid_time_zone" } });
    }
    expect(save).not.toHaveBeenCalled();
    expect(await saveTimeZone(ADMIN, { timeZone: " America/New_York " }, { save })).toEqual({ status: 200, body: { timeZone: "America/New_York", chosen: true } });
    expect(save).toHaveBeenCalledWith("ten_A", "America/New_York");
    expect(await saveTimeZone(ADMIN, { timeZone: null }, { save })).toEqual({ status: 200, body: { timeZone: "UTC", chosen: false } });
    expect(save).toHaveBeenLastCalledWith("ten_A", null);
    expect(await saveTimeZone(ADMIN, { timeZone: "Europe/Paris" }, { save: async () => false })).toEqual({ status: 404, body: { error: "not_found" } });
  });

  it("is unavailable with its switch off", async () => {
    vi.stubEnv("BLOG_DATES_ENABLED", "");
    expect(await readTimeZone(MEMBER, { loadTenant: async () => tenant("Europe/London") })).toEqual({ status: 503, body: { error: "unavailable" } });
    expect(await saveTimeZone(ADMIN, { timeZone: null })).toEqual({ status: 503, body: { error: "unavailable" } });
  });
});
