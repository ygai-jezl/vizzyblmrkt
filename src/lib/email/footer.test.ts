import { describe, it, expect, afterEach } from "vitest";
import type { Tenant } from "@/lib/types/tenant";
import {
  resolvePrivacyUrl,
  unsubscribeLinks,
  journeyFooterValues,
  broadcastFooterValues,
  DEFAULT_PRIVACY_URL,
} from "./footer";

function tenant(over: Partial<Tenant> = {}): Tenant {
  return {
    tenantName: "Acme",
    emailSenderConfig: { senderName: "Acme Team", domains: [] },
    ...over,
  } as unknown as Tenant;
}

describe("resolvePrivacyUrl", () => {
  it("uses the tenant's configured URL when set", () => {
    const t = tenant({
      emailSenderConfig: { senderName: "Acme Team", privacyPolicyUrl: "https://acme.test/p", domains: [] },
    } as Partial<Tenant>);
    expect(resolvePrivacyUrl(t)).toBe("https://acme.test/p");
  });
  it("falls back to the default when unset", () => {
    expect(resolvePrivacyUrl(tenant())).toBe(DEFAULT_PRIVACY_URL);
    expect(resolvePrivacyUrl(null)).toBe(DEFAULT_PRIVACY_URL);
  });
});

describe("unsubscribeLinks", () => {
  const input = { tenantId: "ten_a", campaignId: "c1", signupId: "s1", email: "jo@acme.com" };

  afterEach(() => {
    delete process.env.UNSUBSCRIBE_SIGNING_KEY;
    delete process.env.NEXT_PUBLIC_PLATFORM_ORIGIN;
  });

  it("builds a page + api URL from a single token when configured", () => {
    process.env.UNSUBSCRIBE_SIGNING_KEY = "k";
    process.env.NEXT_PUBLIC_PLATFORM_ORIGIN = "https://app.test";
    const { pageUrl, apiUrl } = unsubscribeLinks(input);
    expect(pageUrl).toMatch(/^https:\/\/app\.test\/unsubscribe\?u=/);
    expect(apiUrl).toMatch(/^https:\/\/app\.test\/api\/unsubscribe\?u=/);
    // Same token in both.
    expect(pageUrl.split("u=")[1]).toBe(apiUrl.split("u=")[1]);
  });

  it("returns empty strings when the platform origin is unset", () => {
    process.env.UNSUBSCRIBE_SIGNING_KEY = "k";
    const { pageUrl, apiUrl } = unsubscribeLinks(input);
    expect(pageUrl).toBe("");
    expect(apiUrl).toBe("");
  });
});

describe("journeyFooterValues", () => {
  it("uses the page URL for both links when present", () => {
    const v = journeyFooterValues({
      tenant: tenant(),
      campaign: null,
      unsubscribeUrl: "https://app.test/unsubscribe?u=x",
    });
    expect(v.brand).toBe("Acme Team");
    expect(v.unsubscribeUrl).toBe("https://app.test/unsubscribe?u=x");
    expect(v.managePreferencesUrl).toBe("https://app.test/unsubscribe?u=x");
    expect(v.privacyUrl).toBe(DEFAULT_PRIVACY_URL);
  });

  it("falls back to the privacy URL when no unsubscribe URL was minted", () => {
    const v = journeyFooterValues({ tenant: tenant(), campaign: null, unsubscribeUrl: "" });
    expect(v.unsubscribeUrl).toBe(DEFAULT_PRIVACY_URL);
  });
});

describe("broadcastFooterValues", () => {
  it("resolves brand + privacy; leaves link fields empty (MailChimp native tags)", () => {
    const v = broadcastFooterValues(tenant(), null);
    expect(v.brand).toBe("Acme Team");
    expect(v.privacyUrl).toBe(DEFAULT_PRIVACY_URL);
    expect(v.unsubscribeUrl).toBe("");
  });
});
