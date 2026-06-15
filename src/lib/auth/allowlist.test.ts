import { describe, it, expect, afterEach } from "vitest";
import { isAllowedAdmin } from "./allowlist";

afterEach(() => {
  delete process.env.ADMIN_ALLOWED_DOMAINS;
  delete process.env.ADMIN_ALLOWED_EMAILS;
});

describe("isAllowedAdmin", () => {
  it("allows the default Workspace domain (yougrow.ai)", () => {
    expect(isAllowedAdmin("founder@yougrow.ai")).toBe(true);
    expect(isAllowedAdmin("Founder@YouGrow.ai", "yougrow.ai")).toBe(true);
  });

  it("rejects other domains", () => {
    expect(isAllowedAdmin("someone@gmail.com")).toBe(false);
    expect(isAllowedAdmin("x@evil.com", "evil.com")).toBe(false);
  });

  it("treats the verified hosted-domain (hd) as authoritative over the email", () => {
    // hd claims a disallowed domain → rejected even if the email looks allowed.
    expect(isAllowedAdmin("x@yougrow.ai", "evil.com")).toBe(false);
  });

  it("honors an explicit email allowlist for external accounts", () => {
    process.env.ADMIN_ALLOWED_EMAILS = "contractor@gmail.com";
    expect(isAllowedAdmin("contractor@gmail.com")).toBe(true);
    expect(isAllowedAdmin("other@gmail.com")).toBe(false);
  });

  it("respects a custom allowed-domains list", () => {
    process.env.ADMIN_ALLOWED_DOMAINS = "acme.com, vizzybl.ai";
    expect(isAllowedAdmin("a@vizzybl.ai")).toBe(true);
    expect(isAllowedAdmin("a@yougrow.ai")).toBe(false);
  });

  it("rejects a missing email", () => {
    expect(isAllowedAdmin(undefined)).toBe(false);
    expect(isAllowedAdmin("")).toBe(false);
  });
});
