import { describe, it, expect } from "vitest";
import {
  deterministicContactId,
  deterministicCompanyId,
  deterministicMessageId,
  canonicalDomain,
  domainFromEmail,
} from "./identifiers";

describe("CRM deterministic ids", () => {
  it("are stable for the same (tenant, key)", () => {
    expect(deterministicContactId("ten_a", "jo@acme.com")).toBe(
      deterministicContactId("ten_a", "jo@acme.com"),
    );
    // Case/whitespace-insensitive on the key.
    expect(deterministicContactId("ten_a", " JO@Acme.com ")).toBe(
      deterministicContactId("ten_a", "jo@acme.com"),
    );
  });

  it("incorporate tenantId so two tenants never collide on the same key", () => {
    // SECURITY: doc ids are global within a collection and create() is atomic —
    // a shared id across tenants would make the second write fail.
    expect(deterministicContactId("ten_a", "jo@acme.com")).not.toBe(
      deterministicContactId("ten_b", "jo@acme.com"),
    );
    expect(deterministicCompanyId("ten_a", "acme.com")).not.toBe(
      deterministicCompanyId("ten_b", "acme.com"),
    );
    expect(
      deterministicMessageId("ten_a", "mandrill", "msg1", "jo@acme.com"),
    ).not.toBe(
      deterministicMessageId("ten_b", "mandrill", "msg1", "jo@acme.com"),
    );
  });

  it("prefix ids by kind", () => {
    expect(deterministicContactId("t", "k")).toMatch(/^ct_/);
    expect(deterministicCompanyId("t", "d")).toMatch(/^co_/);
    expect(deterministicMessageId("t", "p", "i", "r")).toMatch(/^em_/);
  });
});

describe("canonicalDomain", () => {
  it("collapses subdomains to the registrable domain", () => {
    expect(canonicalDomain("mail.acme.co.uk")).toBe("acme.co.uk");
    expect(canonicalDomain("https://www.acme.com/path?x=1")).toBe("acme.com");
  });

  it("collapses Unicode and punycode IDN forms to ONE id-stable form", () => {
    // §H6: else an IDN and its xn-- form would spawn two phantom companies.
    const unicode = canonicalDomain("ёлка.рф"); // → punycode ASCII
    expect(unicode).toBe("xn--80atc1g.xn--p1ai");
    // Idempotent: feeding the punycode form back yields the same canonical id.
    const puny = canonicalDomain("xn--80atc1g.xn--p1ai");
    // A subdomain on the Unicode form collapses to the same registrable domain.
    const sub = canonicalDomain("mail.ёлка.рф");
    expect(puny).toBe(unicode);
    expect(sub).toBe(unicode);
    expect(deterministicCompanyId("ten_a", unicode!)).toBe(
      deterministicCompanyId("ten_a", puny!),
    );
  });

  it("returns null for IPs / localhost / junk", () => {
    expect(canonicalDomain("127.0.0.1")).toBeNull();
    expect(canonicalDomain("localhost")).toBeNull();
    expect(canonicalDomain("")).toBeNull();
  });
});

describe("domainFromEmail", () => {
  it("extracts the canonical registrable domain", () => {
    expect(domainFromEmail("Jo@Mail.Acme.com")).toBe("acme.com");
  });
  it("returns null without a usable host part", () => {
    expect(domainFromEmail("not-an-email")).toBeNull();
    expect(domainFromEmail("jo@")).toBeNull();
  });
});
