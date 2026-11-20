import { describe, expect, it } from "vitest";
import type { GitConnection, SocialConnection } from "@/lib/types/tenant";
import { GITLAB_ACCESS_TTL_MS, gitNeedsReconnect, socialNeedsReconnect } from "./reconnect";

const NOW = Date.parse("2026-11-20T10:00:00.000Z");
const at = (ms: number) => new Date(ms).toISOString();
const SEALED = { ct: "c", iv: "i", tag: "t" };

const gitlab = (over: Partial<GitConnection> = {}): GitConnection => ({
  provider: "gitlab",
  kind: "oauth",
  enc: SEALED,
  connectedAt: at(NOW - 3 * GITLAB_ACCESS_TTL_MS),
  ...over,
});

describe("gitNeedsReconnect", () => {
  it("is false with no connection", () => {
    expect(gitNeedsReconnect(undefined, NOW)).toBe(false);
    expect(gitNeedsReconnect(null, NOW)).toBe(false);
  });

  it("is true for an older GitLab connection with no refresh token, connected over 2 hours ago", () => {
    expect(gitNeedsReconnect(gitlab(), NOW)).toBe(true);
    expect(gitNeedsReconnect(gitlab({ connectedAt: at(NOW - GITLAB_ACCESS_TTL_MS - 1) }), NOW)).toBe(true);
  });

  it("is false for an older GitLab connection still inside its first 2 hours", () => {
    expect(gitNeedsReconnect(gitlab({ connectedAt: at(NOW - GITLAB_ACCESS_TTL_MS) }), NOW)).toBe(false);
    expect(gitNeedsReconnect(gitlab({ connectedAt: at(NOW - 60_000) }), NOW)).toBe(false);
  });

  it("is true when an older GitLab connection's connect time can't be read", () => {
    expect(gitNeedsReconnect(gitlab({ connectedAt: "not a date" }), NOW)).toBe(true);
  });

  it("is false for a GitLab connection with a refresh token, however old", () => {
    expect(gitNeedsReconnect(gitlab({ refreshEnc: SEALED, expiresAt: at(NOW - 1) }), NOW)).toBe(false);
  });

  it("is true whenever the connection is marked", () => {
    const reconnect = { at: at(NOW), reason: "refresh_failed" as const };
    expect(gitNeedsReconnect(gitlab({ refreshEnc: SEALED, connectedAt: at(NOW), reconnect }), NOW)).toBe(true);
    const github: GitConnection = { provider: "github", kind: "oauth", enc: SEALED, connectedAt: at(NOW), reconnect: { ...reconnect, reason: "provider_rejected" } };
    expect(gitNeedsReconnect(github, NOW)).toBe(true);
  });

  it("is false for classic GitHub, however old", () => {
    expect(gitNeedsReconnect({ provider: "github", kind: "oauth", enc: SEALED, connectedAt: at(0) }, NOW)).toBe(false);
  });

  it("is never true for a GitHub App, even marked", () => {
    const app: GitConnection = {
      provider: "github",
      kind: "app",
      installationId: 7,
      connectedAt: at(0),
      reconnect: { at: at(NOW), reason: "provider_rejected" },
    };
    expect(gitNeedsReconnect(app, NOW)).toBe(false);
  });
});

describe("socialNeedsReconnect", () => {
  const linkedin = (over: Partial<SocialConnection> = {}): SocialConnection => ({
    platform: "linkedin",
    enc: SEALED,
    refreshEnc: null,
    connectedAt: at(NOW - 61 * 86_400_000),
    expiresAt: at(NOW - 1),
    ...over,
  });

  it("is true when the token has expired and there is no refresh token", () => {
    expect(socialNeedsReconnect(linkedin(), NOW)).toBe(true);
    expect(socialNeedsReconnect(linkedin({ expiresAt: at(NOW) }), NOW)).toBe(true);
  });

  it("is false before the expiry", () => {
    expect(socialNeedsReconnect(linkedin({ expiresAt: at(NOW + 1) }), NOW)).toBe(false);
  });

  it("is false when a refresh token can renew it", () => {
    expect(socialNeedsReconnect(linkedin({ refreshEnc: SEALED }), NOW)).toBe(false);
  });

  it("is false with no expiry, an unreadable one, or no connection", () => {
    expect(socialNeedsReconnect(linkedin({ expiresAt: null }), NOW)).toBe(false);
    expect(socialNeedsReconnect(linkedin({ expiresAt: undefined }), NOW)).toBe(false);
    expect(socialNeedsReconnect(linkedin({ expiresAt: "not a date" }), NOW)).toBe(false);
    expect(socialNeedsReconnect(undefined, NOW)).toBe(false);
  });
});
