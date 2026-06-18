import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  senderDnsRecords,
  applyRecordValidity,
  addSendingDomain,
  checkSendingDomain,
} from "./senderDomains";

describe("senderDnsRecords", () => {
  it("emits ownership + SPF + two DKIM CNAMEs + DMARC when a verify key is present", () => {
    const records = senderDnsRecords("Mail.Acme.com", "KEY123");
    expect(records).toEqual([
      { type: "TXT", host: "mail.acme.com", value: "mandrill_verify.KEY123", valid: false },
      { type: "TXT", host: "mail.acme.com", value: "v=spf1 include:spf.mandrillapp.com ~all", valid: false },
      { type: "CNAME", host: "mte1._domainkey.mail.acme.com", value: "dkim1.mandrillapp.com", valid: false },
      { type: "CNAME", host: "mte2._domainkey.mail.acme.com", value: "dkim2.mandrillapp.com", valid: false },
      { type: "TXT", host: "_dmarc.mail.acme.com", value: "v=DMARC1; p=none;", valid: false },
    ]);
  });

  it("omits the ownership TXT when no verify key is known yet", () => {
    const records = senderDnsRecords("acme.com");
    expect(records.some((r) => r.value.startsWith("mandrill_verify."))).toBe(false);
    // Still emits the fixed records: SPF + two CNAMEs + DMARC.
    expect(records.map((r) => r.type)).toEqual(["TXT", "CNAME", "CNAME", "TXT"]);
  });
});

describe("applyRecordValidity", () => {
  it("flips DKIM (both CNAMEs), SPF and ownership independently; leaves DMARC untouched", () => {
    const records = senderDnsRecords("acme.com", "KEY");
    const out = applyRecordValidity(records, {
      dkimValid: true,
      spfValid: false,
      ownershipValid: true,
    });
    const by = (pred: (r: (typeof out)[number]) => boolean) => out.find(pred)!;
    expect(by((r) => r.value.startsWith("mandrill_verify.")).valid).toBe(true);
    expect(by((r) => r.value.startsWith("v=spf1")).valid).toBe(false);
    expect(out.filter((r) => r.host.includes("._domainkey.")).every((r) => r.valid)).toBe(true);
    expect(by((r) => r.host.startsWith("_dmarc.")).valid).toBe(false); // never provider-checked
  });
});

describe("addSendingDomain / checkSendingDomain", () => {
  const saved = process.env.MANDRILL_API_KEY;
  beforeEach(() => {
    process.env.MANDRILL_API_KEY = "md-key";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.MANDRILL_API_KEY;
    else process.env.MANDRILL_API_KEY = saved;
    vi.unstubAllGlobals();
  });

  it("returns provider_not_configured when no API key is set", async () => {
    delete process.env.MANDRILL_API_KEY;
    const r = await checkSendingDomain("acme.com");
    expect(r).toMatchObject({ ok: false, status: "pending", detail: "provider_not_configured" });
  });

  it("extracts verify_txt_key and ownership from add-domain", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          domain: "acme.com",
          verify_txt_key: "Yfe0Juqv",
          dkim: { valid: false },
          spf: { valid: false },
          verified_at: null,
          valid_signing: false,
        }),
      })) as unknown as typeof fetch,
    );
    const r = await addSendingDomain("acme.com");
    expect(r).toMatchObject({
      ok: true,
      verifyTxtKey: "Yfe0Juqv",
      ownershipValid: false,
      status: "pending",
    });
  });

  it("reports verified once Mandrill returns valid_signing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          domain: "acme.com",
          dkim: { valid: true },
          spf: { valid: true },
          verified_at: "2026-06-18 10:00:00",
          valid_signing: true,
        }),
      })) as unknown as typeof fetch,
    );
    const r = await checkSendingDomain("acme.com");
    expect(r).toMatchObject({
      ok: true,
      dkimValid: true,
      spfValid: true,
      ownershipValid: true,
      status: "verified",
    });
  });

  it("surfaces a provider HTTP error reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({ message: "Invalid API key" }),
      })) as unknown as typeof fetch,
    );
    const r = await checkSendingDomain("acme.com");
    expect(r).toMatchObject({ ok: false, status: "pending", detail: "Invalid API key" });
  });
});
