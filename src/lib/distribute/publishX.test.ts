import { describe, it, expect } from "vitest";
import { buildXThread, classifyPublishResult } from "./publishX";
import { tweetLength, X_MAX_CHARS } from "./preview/x";

describe("buildXThread", () => {
  it("uses an operator-set thread when present (trimmed, empties dropped)", () => {
    expect(buildXThread(["one", "  two  ", ""], "ignored")).toEqual(["one", "two"]);
  });

  it("splits the copy into ≤280 parts when there is no thread", () => {
    const parts = buildXThread(null, "word ".repeat(120).trim());
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(tweetLength(p)).toBeLessThanOrEqual(X_MAX_CHARS);
  });

  it("returns one part for short copy", () => {
    expect(buildXThread(undefined, "Short and sweet.")).toEqual(["Short and sweet."]);
  });
});

describe("classifyPublishResult", () => {
  it("published on success", () => {
    expect(classifyPublishResult({ ok: true, remoteId: "1", url: "u" })).toEqual({
      kind: "published",
      remoteId: "1",
      url: "u",
    });
  });

  it("RETRIES a transient failure (network drop / rate-limit / 5xx, nothing posted)", () => {
    expect(classifyPublishResult({ ok: false, reason: "network_error" }).kind).toBe("retry");
    expect(classifyPublishResult({ ok: false, reason: "x_api_500" }).kind).toBe("retry");
    expect(classifyPublishResult({ ok: false, reason: "x_api_429" }).kind).toBe("retry");
  });

  it("PARKS a partial / ambiguous result as posted=true (retry OR re-arm would duplicate)", () => {
    for (const reason of [
      "x_api_429_partial",
      "network_error_partial",
      "created_unconfirmed",
      "created_unconfirmed_partial",
      "timeout", // wall-time abort — the request may have reached X
      "timeout_partial",
    ]) {
      expect(classifyPublishResult({ ok: false, reason })).toEqual({ kind: "park", reason, posted: true });
    }
  });

  it("PARKS a permanent nothing-posted result as posted=false (any 4xx except 429; both prefixes)", () => {
    for (const reason of [
      "empty",
      "not_connected",
      "x_api_401",
      "x_api_402",
      "x_api_403",
      "x_api_400",
      "x_api_404",
      "li_api_401", // LinkedIn auth
      "li_api_422", // LinkedIn duplicate post
    ]) {
      expect(classifyPublishResult({ ok: false, reason })).toEqual({ kind: "park", reason, posted: false });
    }
  });

  it("RETRIES the transient statuses on either platform (408 / 425 / 429 / 5xx)", () => {
    for (const reason of ["li_api_429", "li_api_503", "x_api_408", "x_api_425", "li_api_500"]) {
      expect(classifyPublishResult({ ok: false, reason }).kind).toBe("retry");
    }
  });

  it("classifies off the machine code, ignoring any human ':detail' suffix from X", () => {
    // A 402 access-tier refusal with X's explanation still parks (posted=false)…
    const withDetail = "x_api_402:When authenticating requests you must use a paid access level.";
    expect(classifyPublishResult({ ok: false, reason: withDetail })).toEqual({
      kind: "park",
      reason: withDetail,
      posted: false,
    });
    // …and a mid-thread partial with detail still parks as posted=true.
    const partialDetail = "x_api_500_partial:upstream error";
    expect(classifyPublishResult({ ok: false, reason: partialDetail })).toEqual({
      kind: "park",
      reason: partialDetail,
      posted: true,
    });
  });
});
