import { describe, it, expect } from "vitest";
import { resolveSender } from "./sender";
import type { EmailSenderConfig, Tenant } from "@/lib/types/tenant";

/** Minimal tenant carrying only the sender config the resolver reads. */
function tenantWith(cfg: EmailSenderConfig | undefined): Tenant {
  return { emailSenderConfig: cfg } as unknown as Tenant;
}

const verifiedDomain = (domain: string) => ({
  domain,
  status: "verified" as const,
  dkimValid: true,
  spfValid: true,
  records: [],
  addedAt: "2026-01-01T00:00:00.000Z",
});

describe("resolveSender", () => {
  it("returns all-undefined with no tenant config", () => {
    expect(resolveSender(null)).toEqual({});
  });

  it("composes From from a VERIFIED tenant domain", () => {
    const t = tenantWith({
      senderName: "Acme Team",
      fromLocalPart: "hello",
      fromDomain: "mail.acme.com",
      replyTo: "replies@mail.acme.com",
      domains: [verifiedDomain("mail.acme.com")],
    });
    expect(resolveSender(t)).toEqual({
      fromName: "Acme Team",
      fromEmail: "hello@mail.acme.com",
      replyTo: "replies@mail.acme.com",
    });
  });

  it("drops the From address when the domain is NOT verified, keeping name + reply-to", () => {
    const t = tenantWith({
      senderName: "Acme Team",
      fromLocalPart: "hello",
      fromDomain: "mail.acme.com",
      replyTo: "replies@mail.acme.com",
      domains: [{ ...verifiedDomain("mail.acme.com"), status: "pending" }],
    });
    expect(resolveSender(t)).toEqual({
      fromName: "Acme Team",
      fromEmail: undefined,
      replyTo: "replies@mail.acme.com",
    });
  });

  it("lets a per-campaign override win over the tenant default", () => {
    const t = tenantWith({
      senderName: "Acme Team",
      fromLocalPart: "hello",
      fromDomain: "mail.acme.com",
      replyTo: "replies@mail.acme.com",
      domains: [verifiedDomain("mail.acme.com"), verifiedDomain("news.acme.com")],
    });
    expect(
      resolveSender(t, {
        emailFromName: "Acme News",
        emailFromAddress: "news@news.acme.com",
        emailReplyTo: "inbox@news.acme.com",
      }),
    ).toEqual({
      fromName: "Acme News",
      fromEmail: "news@news.acme.com",
      replyTo: "inbox@news.acme.com",
    });
  });

  it("drops a campaign From address whose domain is not verified (no custom From)", () => {
    const t = tenantWith({
      fromLocalPart: "hello",
      fromDomain: "mail.acme.com",
      domains: [verifiedDomain("mail.acme.com")],
    });
    // An explicit campaign override is the sole From candidate; when its domain
    // isn't verified we drop it (env/provider default applies) rather than
    // silently substituting the tenant address.
    expect(
      resolveSender(t, { emailFromAddress: "x@unverified.com" }),
    ).toEqual({
      fromName: undefined,
      fromEmail: undefined,
      replyTo: undefined,
    });
  });
});
