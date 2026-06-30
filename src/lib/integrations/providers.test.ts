import { describe, it, expect, afterEach } from "vitest";
import {
  isGitProvider,
  isProviderConfigured,
  oauthOrigin,
  grantedScopes,
  PROVIDERS,
} from "./providers";

afterEach(() => {
  delete process.env.GITHUB_OAUTH_CLIENT_ID;
  delete process.env.GITHUB_OAUTH_CLIENT_SECRET;
  delete process.env.GIT_OAUTH_ORIGIN;
});

describe("git providers", () => {
  it("validates provider ids", () => {
    expect(isGitProvider("github")).toBe(true);
    expect(isGitProvider("gitlab")).toBe(true);
    expect(isGitProvider("bitbucket")).toBe(false);
    expect(isGitProvider("")).toBe(false);
  });

  it("is configured only when both client id and secret are present", () => {
    expect(isProviderConfigured("github")).toBe(false);
    process.env.GITHUB_OAUTH_CLIENT_ID = "id";
    expect(isProviderConfigured("github")).toBe(false);
    process.env.GITHUB_OAUTH_CLIENT_SECRET = "secret";
    expect(isProviderConfigured("github")).toBe(true);
  });

  it("points at the real OAuth endpoints", () => {
    expect(PROVIDERS.github.authorizeUrl).toContain("github.com/login/oauth/authorize");
    expect(PROVIDERS.github.scope).toBe("repo");
    expect(PROVIDERS.gitlab.tokenUrl).toContain("gitlab.com/oauth/token");
    expect(PROVIDERS.gitlab.scope).toContain("read_repository");
  });

  it("oauthOrigin prefers the pinned env over a (spoofable) request host", () => {
    process.env.GIT_OAUTH_ORIGIN = "https://canonical.example";
    expect(oauthOrigin(new Headers({ host: "attacker.example" }))).toBe("https://canonical.example");
  });

  it("oauthOrigin falls back to the request origin when unset", () => {
    expect(
      oauthOrigin(new Headers({ "x-forwarded-host": "h.example", "x-forwarded-proto": "https" })),
    ).toBe("https://h.example");
  });

  it("grantedScopes parses space- and comma-separated scope strings", () => {
    expect(grantedScopes("repo,read:user").has("repo")).toBe(true);
    expect(grantedScopes("read_repository read_user").has("read_repository")).toBe(true);
    expect(grantedScopes("").size).toBe(0);
    expect(grantedScopes(undefined).size).toBe(0);
  });
});
