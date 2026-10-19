import { describe, it, expect, afterEach } from "vitest";
import { isAllowedAdmin } from "./allowlist";

afterEach(() => {
  delete process.env.ADMIN_ALLOWED_DOMAINS;
  delete process.env.ADMIN_ALLOWED_EMAILS;
});

describe("isAllowedAdmin", () => {
  it("allows nobody when neither list is set (no built-in domain)", () => {
    expect(isAllowedAdmin("founder@example.com")).toBe(false);
    expect(isAllowedAdmin("founder@example.com", "example.com")).toBe(false);
  });

  it("allows a configured Workspace domain, case-insensitively", () => {
    process.env.ADMIN_ALLOWED_DOMAINS = "example.com";
    expect(isAllowedAdmin("founder@example.com")).toBe(true);
    expect(isAllowedAdmin("Founder@Example.com", "example.com")).toBe(true);
  });

  it("rejects other domains", () => {
    process.env.ADMIN_ALLOWED_DOMAINS = "example.com";
    expect(isAllowedAdmin("someone@gmail.com")).toBe(false);
    expect(isAllowedAdmin("x@evil.com", "evil.com")).toBe(false);
  });

  it("treats the verified hosted-domain (hd) as authoritative over the email", () => {
    process.env.ADMIN_ALLOWED_DOMAINS = "example.com";
    // hd claims a disallowed domain → rejected even if the email looks allowed.
    expect(isAllowedAdmin("x@example.com", "evil.com")).toBe(false);
  });

  it("honors an explicit email allowlist for external accounts", () => {
    process.env.ADMIN_ALLOWED_EMAILS = "contractor@gmail.com";
    expect(isAllowedAdmin("contractor@gmail.com")).toBe(true);
    expect(isAllowedAdmin("other@gmail.com")).toBe(false);
  });

  it("respects a custom allowed-domains list", () => {
    process.env.ADMIN_ALLOWED_DOMAINS = "acme.com, example.org";
    expect(isAllowedAdmin("a@example.org")).toBe(true);
    expect(isAllowedAdmin("a@example.com")).toBe(false);
  });

  it("rejects a missing email", () => {
    expect(isAllowedAdmin(undefined)).toBe(false);
    expect(isAllowedAdmin("")).toBe(false);
  });
});
