import { describe, it, expect, afterEach } from "vitest";
import type { Tenant } from "@/lib/types/tenant";
import {
  resolvePrivacyUrl,
  unsubscribeLinks,
  journeyFooterValues,
  broadcastFooterValues,
  DEFAULT_PRIVACY_URL,
  emailLinkOrigin,
  lifecycleUnsubscribeLinks,
} from "./footer";
import { verifyUnsubscribeTokenAny } from "./unsubscribeToken";

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

describe("lifecycleUnsubscribeLinks / emailLinkOrigin", () => {
  const input = {
    tenantId: "ten_a",
    email: "alex@acme.test",
    recipientId: "pu_1",
    connectionId: "pcn_1",
    category: "onboarding",
    categoryLabel: "Onboarding tips",
  };

  afterEach(() => {
    delete process.env.UNSUBSCRIBE_SIGNING_KEY;
    delete process.env.NEXT_PUBLIC_PLATFORM_ORIGIN;
    delete process.env.EMAIL_LINK_ORIGIN;
  });

  it("prefers EMAIL_LINK_ORIGIN over the platform origin", () => {
    process.env.NEXT_PUBLIC_PLATFORM_ORIGIN = "https://app.test";
    expect(emailLinkOrigin()).toBe("https://app.test");
    process.env.EMAIL_LINK_ORIGIN = "https://dev.app.test/";
    expect(emailLinkOrigin()).toBe("https://dev.app.test");
  });

  it("builds page + api URLs carrying a v2 token", () => {
    process.env.UNSUBSCRIBE_SIGNING_KEY = "k";
    process.env.EMAIL_LINK_ORIGIN = "https://dev.app.test";
    const { pageUrl, apiUrl } = lifecycleUnsubscribeLinks(input);
    expect(pageUrl).toMatch(/^https:\/\/dev\.app\.test\/unsubscribe\?u=/);
    expect(apiUrl).toMatch(/^https:\/\/dev\.app\.test\/api\/unsubscribe\?u=/);
    const token = decodeURIComponent(pageUrl.split("u=")[1]!);
    const res = verifyUnsubscribeTokenAny(token);
    expect(res.ok && res.version).toBe(2);
  });

  it("returns empty strings when no origin is configured", () => {
    process.env.UNSUBSCRIBE_SIGNING_KEY = "k";
    expect(lifecycleUnsubscribeLinks(input)).toEqual({ pageUrl: "", apiUrl: "" });
  });
});
