import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

const flags = vi.hoisted(() => ({ isSelfServeSignupOpen: vi.fn(() => false) }));
vi.mock("./flags", () => flags);

import { isAllowedAdmin, isListedAdminEmail } from "./allowlist";

beforeEach(() => {
  vi.stubEnv("ADMIN_ALLOWED_DOMAINS", "");
  vi.stubEnv("ADMIN_ALLOWED_EMAILS", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  flags.isSelfServeSignupOpen.mockReturnValue(false);
});

describe("isAllowedAdmin, Google sign-in", () => {
  const g = (email?: string, hd?: string) => isAllowedAdmin(email, hd, "google.com");

  it("allows nobody when neither list is set (no built-in domain)", () => {
    vi.stubEnv("ADMIN_ALLOWED_DOMAINS", "");
    vi.stubEnv("ADMIN_ALLOWED_EMAILS", "");
    expect(g("founder@example.com")).toBe("forbidden");
    expect(g("founder@example.com", "example.com")).toBe("forbidden");
  });

  it("allows a configured Workspace domain, case-insensitively", () => {
    vi.stubEnv("ADMIN_ALLOWED_DOMAINS", "example.com");
    expect(g("founder@example.com")).toBe("allowed");
    expect(g("Founder@Example.com", "example.com")).toBe("allowed");
  });

  it("rejects other domains", () => {
    vi.stubEnv("ADMIN_ALLOWED_DOMAINS", "example.com");
    expect(g("someone@example.net")).toBe("forbidden");
    expect(g("x@example.test", "example.test")).toBe("forbidden");
  });

  it("treats the verified hosted-domain (hd) as authoritative over the email", () => {
    vi.stubEnv("ADMIN_ALLOWED_DOMAINS", "example.com");
    // hd claims a disallowed domain: rejected even if the email looks allowed.
    expect(g("x@example.com", "example.test")).toBe("forbidden");
  });

  it("honors an explicit email allowlist for external accounts", () => {
    vi.stubEnv("ADMIN_ALLOWED_EMAILS", "contractor@example.net");
    expect(g("contractor@example.net")).toBe("allowed");
    expect(g("other@example.net")).toBe("forbidden");
  });

  it("respects a custom allowed-domains list", () => {
    vi.stubEnv("ADMIN_ALLOWED_DOMAINS", "acme.test, example.org");
    expect(g("a@example.org")).toBe("allowed");
    expect(g("a@example.com")).toBe("forbidden");
  });

  it("rejects a missing email", () => {
    vi.stubEnv("ADMIN_ALLOWED_DOMAINS", "example.com");
    expect(g(undefined)).toBe("forbidden");
    expect(g("")).toBe("forbidden");
  });
});

describe("isAllowedAdmin, password sign-in (D3)", () => {
  const p = (email?: string) => isAllowedAdmin(email, undefined, "password");

  it("allows an address on the email list, case-insensitively", () => {
    vi.stubEnv("ADMIN_ALLOWED_EMAILS", "alex@example.com, sam@example.net");
    expect(p("alex@example.com")).toBe("allowed");
    expect(p("Sam@Example.NET")).toBe("allowed");
  });

  it("answers google_only for an address allowed only through the domain list", () => {
    vi.stubEnv("ADMIN_ALLOWED_DOMAINS", "example.com");
    vi.stubEnv("ADMIN_ALLOWED_EMAILS", "");
    expect(p("alex@example.com")).toBe("google_only");
  });

  it("prefers the email list when an address is on both", () => {
    vi.stubEnv("ADMIN_ALLOWED_DOMAINS", "example.com");
    vi.stubEnv("ADMIN_ALLOWED_EMAILS", "alex@example.com");
    expect(p("alex@example.com")).toBe("allowed");
    expect(p("sam@example.com")).toBe("google_only");
  });

  it("forbids an address on no list", () => {
    vi.stubEnv("ADMIN_ALLOWED_DOMAINS", "example.com");
    vi.stubEnv("ADMIN_ALLOWED_EMAILS", "alex@example.com");
    expect(p("someone@example.net")).toBe("forbidden");
    expect(p(undefined)).toBe("forbidden");
  });
});

describe("isAllowedAdmin, the self-serve seam", () => {
  it("is unreachable with the real switch: SELF_SERVE_SIGNUP_ENABLED alone opens nothing", async () => {
    const real = await vi.importActual<typeof import("./flags")>("./flags");
    vi.stubEnv("SELF_SERVE_SIGNUP_ENABLED", "true");
    expect(real.isSelfServeSignupOpen()).toBe(false);
  });

  it("answers self_serve for someone on no list only while self-serve sign-up is open", () => {
    vi.stubEnv("ADMIN_ALLOWED_DOMAINS", "example.com");
    vi.stubEnv("ADMIN_ALLOWED_EMAILS", "");
    flags.isSelfServeSignupOpen.mockReturnValue(true);
    expect(isAllowedAdmin("someone@example.net", undefined, "google.com")).toBe("self_serve");
    expect(isAllowedAdmin("someone@example.net", undefined, "password")).toBe("self_serve");
    // A domain admin who signs in with a password still goes to Google, not to a new brand.
    expect(isAllowedAdmin("alex@example.com", undefined, "password")).toBe("google_only");
    expect(isAllowedAdmin(undefined, undefined, "google.com")).toBe("forbidden");
  });
});

describe("isListedAdminEmail", () => {
  it("matches the exact address only, case-insensitively", () => {
    vi.stubEnv("ADMIN_ALLOWED_DOMAINS", "example.com");
    vi.stubEnv("ADMIN_ALLOWED_EMAILS", "alex@example.com");
    expect(isListedAdminEmail(" Alex@Example.com ")).toBe(true);
    expect(isListedAdminEmail("sam@example.com")).toBe(false);
    expect(isListedAdminEmail("")).toBe(false);
    expect(isListedAdminEmail(null)).toBe(false);
  });
});
