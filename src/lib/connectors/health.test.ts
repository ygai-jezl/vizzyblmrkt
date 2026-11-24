import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { CONNECTOR_ERRORS, connectorMessage, tokenRefusedMessage } from "./messages";
import { FAILURES_BEFORE_PAUSE, healthAfterFailure, healthAfterSuccess, healthyAt, isCallPaused, shownState } from "./health";

const NOW = new Date("2026-11-21T10:00:00.000Z");
const ok = healthyAt(new Date("2026-11-21T09:00:00.000Z"));

describe("connection health", () => {
  it("starts ok and clears failures after a call that works", () => {
    expect(ok).toEqual({ state: "ok", lastOkAt: "2026-11-21T09:00:00.000Z", lastCheckedAt: "2026-11-21T09:00:00.000Z", lastErrorCode: null, failures: 0, pausedUntil: null });
    const failed = healthAfterFailure(ok, "provider_error", NOW)!.health;
    expect(healthAfterSuccess(failed, NOW)).toEqual(healthyAt(NOW));
  });

  it("marks a refused token, an account it can't read and a token that won't open as broken", () => {
    for (const code of ["token_refused", "account_refused", "secret_unopenable"] as const) {
      expect(healthAfterFailure(ok, code, NOW)).toEqual({
        health: { ...ok, state: "broken", lastCheckedAt: NOW.toISOString(), lastErrorCode: code, failures: 1, pausedUntil: null, since: NOW.toISOString() },
        pausedNow: false,
      });
    }
  });

  it("pauses after a provider's rate limit, for its Retry-After within 1 to 60 minutes", () => {
    expect(healthAfterFailure(ok, "rate_limited", NOW)!.health.pausedUntil).toBe("2026-11-21T10:15:00.000Z");
    expect(healthAfterFailure(ok, "rate_limited", NOW, 5)!.health.pausedUntil).toBe("2026-11-21T10:01:00.000Z");
    expect(healthAfterFailure(ok, "rate_limited", NOW, 7200)!.health.pausedUntil).toBe("2026-11-21T11:00:00.000Z");
    expect(healthAfterFailure(ok, "rate_limited", NOW)).toMatchObject({ pausedNow: true, health: { state: "paused" } });
  });

  it("sets check for a failure that may pass, and pauses for an hour after enough in a row", () => {
    let h = ok;
    for (let i = 1; i < FAILURES_BEFORE_PAUSE; i++) {
      const r = healthAfterFailure(h, "timeout", NOW)!;
      expect(r).toMatchObject({ pausedNow: false, health: { state: "check", failures: i } });
      h = r.health;
    }
    expect(healthAfterFailure(h, "provider_error", NOW)).toMatchObject({ pausedNow: true, health: { state: "paused", pausedUntil: "2026-11-21T11:00:00.000Z" } });
  });

  it("dates the failures in a row from the first, and a lost shared address is broken", () => {
    const first = healthAfterFailure(ok, "share_access_lost", NOW)!.health;
    expect(first).toMatchObject({ state: "broken", since: NOW.toISOString() });
    const later = healthAfterFailure(first, "share_access_lost", new Date("2026-11-22T10:00:00.000Z"))!.health;
    expect(later.since).toBe(NOW.toISOString());
    expect(healthAfterSuccess(later, NOW)).not.toHaveProperty("since");
    expect(connectorMessage("share_access_lost", { name: "Google Analytics 4", chat: true, since: "2026-11-19T09:12:00.000Z" })).toBe(
      "YouGrow lost access to this property on 19 Nov. Add the Google address again with the role shown, then press Check access.",
    );
    expect(connectorMessage("share_access_lost")).toBe(CONNECTOR_ERRORS.share_access_lost);
  });

  it("leaves health alone for YouGrow's own refusals", () => {
    for (const code of ["busy", "paused", "host_not_allowed", "vault_unconfigured", "disconnected"] as const) expect(healthAfterFailure(ok, code, NOW)).toBeNull();
  });

  it("says paused while an admin's pause or a timed pause lasts, then shows the last state", () => {
    const base = { pausedAt: null, health: ok, status: "connected" as const };
    expect(isCallPaused(base, NOW)).toBe(false);
    expect(shownState({ ...base, pausedAt: "2026-11-21T09:30:00.000Z" }, NOW)).toBe("paused");
    const timed = { ...base, health: { ...ok, state: "paused" as const, pausedUntil: "2026-11-21T10:30:00.000Z" } };
    expect(shownState(timed, NOW)).toBe("paused");
    expect(shownState(timed, new Date("2026-11-21T10:31:00.000Z"))).toBe("check");
    expect(shownState({ ...base, status: "disconnected" }, NOW)).toBe("disconnected");
  });

  it("has a plain message for every code, in house style", () => {
    for (const text of Object.values(CONNECTOR_ERRORS)) {
      expect(dashesIn(text), text).toEqual([]);
      expect(aiTellsIn(text), text).toEqual([]);
    }
    expect(connectorMessage("token_refused")).toBe(CONNECTOR_ERRORS.token_refused);
    expect(connectorMessage("something_new")).toContain("Something went wrong");
  });

  it("names the tool that turned a token down, and says what to do, as the approved Connected screen", () => {
    expect(connectorMessage("token_refused", { name: "Cloudflare", chat: true })).toBe("Cloudflare turned the token down. Vizzy can't read it until you reconnect.");
    expect(connectorMessage("token_refused", { name: "Cloudflare", chat: false })).toBe("Cloudflare turned the token down. Nobody can read it until you reconnect.");
    expect(tokenRefusedMessage("Cloudflare", "connecting", true)).toBe(
      "Cloudflare turned the token down, so nothing was saved. Paste the whole token again, or make a new one with the permissions listed here.",
    );
    // Only a turned down token names its tool; every other code keeps its words.
    expect(connectorMessage("account_refused", { name: "Cloudflare", chat: true })).toBe(CONNECTOR_ERRORS.account_refused);
    for (const text of [true, false].flatMap((chat) => [tokenRefusedMessage("Cloudflare", "connected", chat), tokenRefusedMessage("Cloudflare", "connecting", chat)])) {
      expect(dashesIn(text), text).toEqual([]);
      expect(aiTellsIn(text), text).toEqual([]);
    }
  });
});
