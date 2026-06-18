import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the Google auth client so we can drive getKey/updateKey responses.
const request = vi.fn();
vi.mock("google-auth-library", () => ({
  GoogleAuth: vi.fn().mockImplementation(() => ({
    getClient: async () => ({ request }),
  })),
}));

import { registerRecaptchaDomain } from "./recaptcha";

const ENABLED = {
  RECAPTCHA_ENABLED: "true",
  RECAPTCHA_PROJECT_ID: "proj",
  NEXT_PUBLIC_RECAPTCHA_SITE_KEY: "6Lkey",
};

beforeEach(() => {
  request.mockReset();
  for (const [k, v] of Object.entries(ENABLED)) vi.stubEnv(k, v);
});
afterEach(() => vi.unstubAllEnvs());

describe("registerRecaptchaDomain", () => {
  it("no-ops (skipped) when reCAPTCHA is disabled", async () => {
    vi.stubEnv("RECAPTCHA_ENABLED", "false");
    const res = await registerRecaptchaDomain("acme.com");
    expect(res).toEqual({ ok: true, skipped: true });
    expect(request).not.toHaveBeenCalled();
  });

  it("appends the eTLD+1 via GET-then-PATCH with a field mask", async () => {
    request.mockImplementation(async (opts: { method?: string; url: string; data?: unknown }) => {
      if (opts.method === "PATCH") return { data: {} };
      return { data: { webSettings: { allowedDomains: ["existing.com"] } } };
    });

    const res = await registerRecaptchaDomain("www.acme.com");
    expect(res).toEqual({ ok: true });

    const patch = request.mock.calls.find((c) => c[0].method === "PATCH")![0];
    expect(patch.url).toContain("updateMask=webSettings.allowedDomains");
    expect((patch.data as { webSettings: { allowedDomains: string[] } }).webSettings.allowedDomains)
      .toEqual(["existing.com", "acme.com"]); // registrable domain, not the subdomain
  });

  it("is idempotent when the registrable domain is already present", async () => {
    request.mockResolvedValue({ data: { webSettings: { allowedDomains: ["acme.com"] } } });
    const res = await registerRecaptchaDomain("mail.acme.com");
    expect(res).toEqual({ ok: true, alreadyPresent: true });
    expect(request.mock.calls.every((c) => c[0].method !== "PATCH")).toBe(true);
  });

  it("refuses past the domain cap", async () => {
    const many = Array.from({ length: 200 }, (_, i) => `d${i}.com`);
    request.mockResolvedValue({ data: { webSettings: { allowedDomains: many } } });
    const res = await registerRecaptchaDomain("acme.com");
    expect(res).toMatchObject({ ok: false, reason: "cap_reached" });
  });
});
