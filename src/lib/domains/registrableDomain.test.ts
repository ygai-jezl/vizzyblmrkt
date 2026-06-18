import { describe, it, expect } from "vitest";
import {
  normalizeHost,
  registrableDomain,
  sameRegistrableDomain,
  isPublicEmailProvider,
} from "./registrableDomain";

describe("normalizeHost", () => {
  it("strips scheme, path, port, trailing dot and lowercases", () => {
    expect(normalizeHost("HTTPS://Acme.com/path?x=1")).toBe("acme.com");
    expect(normalizeHost("acme.com:8080")).toBe("acme.com");
    expect(normalizeHost("acme.com.")).toBe("acme.com");
    expect(normalizeHost("  ACME.COM  ")).toBe("acme.com");
  });
  it("returns empty for unusable input", () => {
    expect(normalizeHost("")).toBe("");
  });
});

describe("registrableDomain (eTLD+1)", () => {
  it("collapses subdomains to the registrable domain", () => {
    expect(registrableDomain("a.b.acme.co.uk")).toBe("acme.co.uk");
    expect(registrableDomain("www.acme.com")).toBe("acme.com");
    expect(registrableDomain("yougrow.ai")).toBe("yougrow.ai");
  });
  it("returns null for IPs and localhost", () => {
    expect(registrableDomain("localhost")).toBeNull();
    expect(registrableDomain("127.0.0.1")).toBeNull();
  });
});

describe("sameRegistrableDomain", () => {
  it("is true across subdomains, false across different domains", () => {
    expect(sameRegistrableDomain("mail.acme.com", "acme.com")).toBe(true);
    expect(sameRegistrableDomain("acme.com", "evil.com")).toBe(false);
    expect(sameRegistrableDomain("acme.co.uk", "evil.acme.co.uk.evil.com")).toBe(false);
  });
});

describe("isPublicEmailProvider", () => {
  it("flags free providers and clears brand domains", () => {
    expect(isPublicEmailProvider("gmail.com")).toBe(true);
    expect(isPublicEmailProvider("outlook.com")).toBe(true);
    expect(isPublicEmailProvider("acme.com")).toBe(false);
    expect(isPublicEmailProvider("yougrow.ai")).toBe(false);
  });
});
