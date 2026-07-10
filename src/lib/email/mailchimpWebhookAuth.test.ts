import { describe, it, expect } from "vitest";
import { deriveTenantWebhookKey, tenantWebhookKeyMatches } from "./mailchimpWebhookAuth";

describe("mailchimp webhook per-tenant key", () => {
  const master = "master-secret";

  it("is deterministic per tenant", () => {
    expect(deriveTenantWebhookKey("ten_a", master)).toBe(deriveTenantWebhookKey("ten_a", master));
  });

  it("differs per tenant — one tenant's key never authorises another's", () => {
    const a = deriveTenantWebhookKey("ten_a", master);
    const b = deriveTenantWebhookKey("ten_b", master);
    expect(a).not.toBe(b);
    // A BYO tenant admin knows their own key but can't forge the victim's.
    expect(tenantWebhookKeyMatches(a, deriveTenantWebhookKey("ten_b", master))).toBe(false);
    expect(tenantWebhookKeyMatches(a, deriveTenantWebhookKey("ten_a", master))).toBe(true);
  });

  it("depends on the master secret", () => {
    expect(deriveTenantWebhookKey("ten_a", master)).not.toBe(deriveTenantWebhookKey("ten_a", "other"));
  });

  it("rejects an empty / mismatched key without throwing", () => {
    expect(tenantWebhookKeyMatches("", deriveTenantWebhookKey("ten_a", master))).toBe(false);
  });
});
