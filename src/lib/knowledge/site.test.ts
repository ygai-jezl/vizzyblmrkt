import { describe, expect, it } from "vitest";
import { siteOf, sitesOf, tenantDomains } from "./site";

describe("siteOf", () => {
  it("puts a site's sub-domains on one site", () => {
    expect(siteOf("https://docs.acme.example/guide")).toBe("acme.example");
    expect(siteOf("https://www.acme.example")).toBe("acme.example");
    expect(siteOf("acme.example")).toBe("acme.example");
    expect(siteOf("https://shop.acme-example.co.uk/pricing")).toBe("acme-example.co.uk");
  });

  it("never puts two owners on one site", () => {
    // Two companies under one country suffix.
    expect(siteOf("https://acme-example.co.uk")).not.toBe(siteOf("https://rival-example.co.uk"));
    // Two customers of one hosting platform.
    expect(siteOf("https://acme-example.github.io/docs")).toBe("acme-example.github.io");
    expect(siteOf("https://rival-example.github.io")).toBe("rival-example.github.io");
    // Two authors on a publishing platform the suffix list leaves out.
    expect(siteOf("https://acme-example.substack.com/p/launch")).toBe("acme-example.substack.com");
    expect(siteOf("https://rival-example.substack.com")).toBe("rival-example.substack.com");
  });

  it("is only ever itself for an address with no registrable domain", () => {
    expect(siteOf("https://github.io")).toBe("github.io");
    expect(siteOf("https://203.0.113.7/report")).toBe("203.0.113.7");
  });

  it("is empty for what names no host", () => {
    expect(siteOf("")).toBe("");
    expect(siteOf("not a url")).toBe("");
  });

  it("collects the sites of a list of URLs", () => {
    expect([...sitesOf(["https://acme.example/a", null, "", "https://docs.acme.example/b", "https://research.example.org"])]).toEqual([
      "acme.example",
      "example.org",
    ]);
  });

  it("lists the domains a tenant record vouches for — and not one still being verified", () => {
    expect(
      tenantDomains({
        rootDomain: "acme.example",
        allowedOrigins: ["https://app.acme.example", "http://localhost:3000"],
        emailSenderConfig: { domains: [{ domain: "mail.acme-mail.example", status: "verified" }, { domain: "pending.example", status: "pending" }] },
      }),
    ).toEqual(["acme.example", "https://app.acme.example", "http://localhost:3000", "mail.acme-mail.example"]);
    expect(tenantDomains({ rootDomain: "" })).toEqual([]);
    expect(tenantDomains(null)).toEqual([]);
  });
});

