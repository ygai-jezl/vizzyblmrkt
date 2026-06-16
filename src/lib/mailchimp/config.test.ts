import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveMailchimpConfig, deriveServerPrefix } from "./config";
import type { Tenant, MailchimpTenantConfig } from "@/lib/types/tenant";

function tenant(cfg?: MailchimpTenantConfig): Tenant {
  return { mailchimpConfig: cfg } as unknown as Tenant;
}

const ENV_KEYS = [
  "MAILCHIMP_API_KEY",
  "MAILCHIMP_AUDIENCE_ID",
  "MAILCHIMP_SERVER_PREFIX",
];

describe("resolveMailchimpConfig (feature gate)", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("derives the data-center prefix from the key suffix", () => {
    expect(deriveServerPrefix("abc123-us21")).toBe("us21");
    expect(deriveServerPrefix("nodash")).toBeNull();
  });

  it("uses the shared account from env when no tenant config", () => {
    process.env.MAILCHIMP_API_KEY = "key-us5";
    process.env.MAILCHIMP_AUDIENCE_ID = "aud_1";
    const r = resolveMailchimpConfig(tenant());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.source).toBe("shared");
      expect(r.config.serverPrefix).toBe("us5");
      expect(r.config.audienceId).toBe("aud_1");
    }
  });

  it("fails when nothing is configured", () => {
    const r = resolveMailchimpConfig(tenant());
    expect(r).toEqual({ ok: false, reason: "shared_not_configured" });
  });

  it("uses the tenant's own creds when provided", () => {
    const r = resolveMailchimpConfig(
      tenant({ requiresOwnApiKey: false, apiKey: "tk-eu3", audienceId: "ten_aud" }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.source).toBe("tenant");
      expect(r.config.serverPrefix).toBe("eu3");
      expect(r.config.audienceId).toBe("ten_aud");
    }
  });

  it("DENIES the shared account when the BYO gate is on but unconfigured", () => {
    process.env.MAILCHIMP_API_KEY = "key-us5";
    process.env.MAILCHIMP_AUDIENCE_ID = "aud_1";
    const r = resolveMailchimpConfig(tenant({ requiresOwnApiKey: true }));
    expect(r).toEqual({ ok: false, reason: "byo_required_not_configured" });
  });

  it("requires an audience id for a BYO tenant", () => {
    const r = resolveMailchimpConfig(
      tenant({ requiresOwnApiKey: true, apiKey: "tk-us1" }),
    );
    expect(r).toEqual({ ok: false, reason: "byo_required_not_configured" });
  });
});
