import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  senderDnsRecords,
  applyRecordValidity,
  addSendingDomain,
  checkSendingDomain,
  checkPublishedRecords,
  type TxtLookup,
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

  it("without a DNS lookup, gives the same records as before (no DMARC tick, no inheritedFrom)", () => {
    const records = senderDnsRecords("mail.acme.com", "KEY");
    const status = { dkimValid: true, spfValid: true, ownershipValid: true };
    const out = applyRecordValidity(records, status);
    const dmarc = out.find((r) => r.host.startsWith("_dmarc."))!;
    expect(dmarc).toEqual({ type: "TXT", host: "_dmarc.mail.acme.com", value: "v=DMARC1; p=none;", valid: false });
  });

  it("with a DNS lookup, ticks SPF found in DNS even when Mandrill says no, and ticks DMARC", () => {
    const records = senderDnsRecords("mail.acme.com", "KEY");
    const out = applyRecordValidity(
      records,
      { dkimValid: true, spfValid: false, ownershipValid: true },
      { spfFound: true, dmarcFound: true },
    );
    expect(out.every((r) => r.valid)).toBe(true);
    expect(out.some((r) => "inheritedFrom" in r)).toBe(false);
  });

  it("keeps Mandrill's SPF tick when DNS doesn't show it, and marks a DMARC covered by the parent", () => {
    const records = senderDnsRecords("mail.acme.com", "KEY");
    const out = applyRecordValidity(
      records,
      { dkimValid: true, spfValid: true, ownershipValid: true },
      { spfFound: false, dmarcFound: true, dmarcFrom: "acme.com" },
    );
    expect(out.find((r) => r.value.startsWith("v=spf1"))!.valid).toBe(true);
    expect(out.find((r) => r.host.startsWith("_dmarc."))).toMatchObject({ valid: true, inheritedFrom: "acme.com" });
  });

  it("leaves SPF and DMARC unticked when neither Mandrill nor DNS finds them", () => {
    const records = senderDnsRecords("mail.acme.com", "KEY");
    const out = applyRecordValidity(
      records,
      { dkimValid: true, spfValid: false, ownershipValid: true },
      { spfFound: false, dmarcFound: false },
    );
    expect(out.filter((r) => !r.valid).map((r) => r.host)).toEqual(["mail.acme.com", "_dmarc.mail.acme.com"]);
  });
});

describe("checkPublishedRecords", () => {
  /** A fake DNS: name → TXT records (each an array of chunks). Unknown names fail like real DNS. */
  function fakeDns(zone: Record<string, string[][]>): TxtLookup & { asked: string[] } {
    const asked: string[] = [];
    const lookup = (async (name: string) => {
      asked.push(name);
      const found = zone[name];
      if (!found) throw Object.assign(new Error(`queryTxt ENODATA ${name}`), { code: "ENODATA" });
      return found;
    }) as TxtLookup & { asked: string[] };
    lookup.asked = asked;
    return lookup;
  }

  it("finds SPF with Mandrill and the subdomain's own DMARC", async () => {
    const dns = fakeDns({
      "mail.acme.com": [["mandrill_verify.KEY"], ["v=spf1 include:spf.mandrillapp.com ~all"]],
      "_dmarc.mail.acme.com": [["v=DMARC1; p=none;"]],
    });
    expect(await checkPublishedRecords("mail.acme.com", dns)).toEqual({ spfFound: true, dmarcFound: true });
    expect(dns.asked).not.toContain("_dmarc.acme.com"); // own record found: no need to ask the parent
  });

  it("joins TXT values DNS split into chunks", async () => {
    const dns = fakeDns({
      "mail.acme.com": [["v=spf1 include:_spf.google.com ", "include:spf.mandrillapp.com ~all"]],
      "_dmarc.mail.acme.com": [["v=DMARC1; ", "p=quarantine; rua=mailto:dmarc@acme.example"]],
    });
    expect(await checkPublishedRecords("mail.acme.com", dns)).toEqual({ spfFound: true, dmarcFound: true });
  });

  it("doesn't count an SPF record that leaves Mandrill out, or a lookalike include", async () => {
    const dns = fakeDns({
      "mail.acme.com": [["v=spf1 include:_spf.google.com ~all"], ["v=spf1 include:spf.mandrillapp.com.evil.test ~all"]],
      "_dmarc.mail.acme.com": [["v=DMARC1; p=none;"]],
    });
    expect((await checkPublishedRecords("mail.acme.com", dns)).spfFound).toBe(false);
  });

  it("counts the parent domain's DMARC for a subdomain without its own, and says where it came from", async () => {
    const dns = fakeDns({
      "mail.acme.com": [["v=spf1 include:spf.mandrillapp.com ~all"]],
      "acme.com": [["v=spf1 include:spf.mandrillapp.com ~all"]],
      "_dmarc.acme.com": [["v=DMARC1; p=none;"]],
    });
    expect(await checkPublishedRecords("mail.acme.com", dns)).toEqual({
      spfFound: true,
      dmarcFound: true,
      dmarcFrom: "acme.com",
    });
  });

  it("uses the registrable domain as the parent for multi-part suffixes", async () => {
    const dns = fakeDns({ "_dmarc.acme.co.uk": [["v=DMARC1; p=reject;"]] });
    expect(await checkPublishedRecords("mail.acme.co.uk", dns)).toEqual({
      spfFound: false,
      dmarcFound: true,
      dmarcFrom: "acme.co.uk",
    });
    expect(dns.asked).not.toContain("_dmarc.co.uk");
  });

  it("finds nothing when neither record is published", async () => {
    const dns = fakeDns({ "mail.acme.com": [["mandrill_verify.KEY"]] });
    expect(await checkPublishedRecords("mail.acme.com", dns)).toEqual({ spfFound: false, dmarcFound: false });
  });

  it("asks only once for an apex domain's DMARC", async () => {
    const dns = fakeDns({});
    expect(await checkPublishedRecords("acme.com", dns)).toEqual({ spfFound: false, dmarcFound: false });
    expect(dns.asked.filter((n) => n.startsWith("_dmarc."))).toEqual(["_dmarc.acme.com"]);
  });

  it("ignores a TXT at _dmarc that isn't a DMARC record", async () => {
    const dns = fakeDns({ "_dmarc.mail.acme.com": [["some-other-verification=abc"]] });
    expect((await checkPublishedRecords("mail.acme.com", dns)).dmarcFound).toBe(false);
  });

  it("reads a DNS failure (timeout, server error) as not found, never throws", async () => {
    const failing: TxtLookup = async () => {
      throw Object.assign(new Error("queryTxt ETIMEOUT"), { code: "ETIMEOUT" });
    };
    expect(await checkPublishedRecords("mail.acme.com", failing)).toEqual({ spfFound: false, dmarcFound: false });
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

  it("does NOT mark verified on DKIM+SPF alone when ownership is unconfirmed", async () => {
    // Intermediate state: DKIM + SPF resolve before the ownership TXT does. Mandrill
    // still treats this as unsigned (valid_signing=false), so it must stay pending —
    // marking it verified would authorize a From address that can't actually send.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          domain: "acme.com",
          dkim: { valid: true },
          spf: { valid: true },
          verified_at: null,
          valid_signing: false,
        }),
      })) as unknown as typeof fetch,
    );
    const r = await checkSendingDomain("acme.com");
    expect(r).toMatchObject({
      dkimValid: true,
      spfValid: true,
      ownershipValid: false,
      status: "pending",
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
