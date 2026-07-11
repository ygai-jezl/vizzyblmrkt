import { describe, it, expect } from "vitest";
import { deriveMailchimpWebhookKey, mailchimpWebhookKeyMatches } from "./mailchimpWebhookAuth";

describe("mailchimp webhook per-audience key", () => {
  const master = "master-secret";
  const listA = "aud_111";
  const listB = "aud_222";

  it("is deterministic per audience", () => {
    expect(deriveMailchimpWebhookKey(listA, master)).toBe(deriveMailchimpWebhookKey(listA, master));
  });

  it("differs per audience — a key for one list never authorises another list_id", () => {
    const a = deriveMailchimpWebhookKey(listA, master);
    const b = deriveMailchimpWebhookKey(listB, master);
    expect(a).not.toBe(b);
    // Knowing your own audience's key can't forge a write for a different list_id.
    expect(mailchimpWebhookKeyMatches(a, deriveMailchimpWebhookKey(listB, master))).toBe(false);
    expect(mailchimpWebhookKeyMatches(a, deriveMailchimpWebhookKey(listA, master))).toBe(true);
  });

  it("depends on the master secret", () => {
    expect(deriveMailchimpWebhookKey(listA, master)).not.toBe(deriveMailchimpWebhookKey(listA, "other"));
  });

  it("rejects an empty / mismatched key without throwing", () => {
    expect(mailchimpWebhookKeyMatches("", deriveMailchimpWebhookKey(listA, master))).toBe(false);
  });
});
