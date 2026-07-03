import { describe, it, expect } from "vitest";
import { buildXThread, classifyXResult } from "./publishX";
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

describe("classifyXResult", () => {
  it("published on success", () => {
    expect(classifyXResult({ ok: true, remoteId: "1", url: "u" })).toEqual({
      kind: "published",
      remoteId: "1",
      url: "u",
    });
  });

  it("RETRIES a clean failure (nothing posted)", () => {
    expect(classifyXResult({ ok: false, reason: "network_error" }).kind).toBe("retry");
    expect(classifyXResult({ ok: false, reason: "x_api_500" }).kind).toBe("retry");
    expect(classifyXResult({ ok: false, reason: "x_api_403" }).kind).toBe("retry");
  });

  it("PARKS a partial / ambiguous result as posted=true (retry OR re-arm would duplicate)", () => {
    for (const reason of [
      "x_api_429_partial",
      "network_error_partial",
      "created_unconfirmed",
      "created_unconfirmed_partial",
    ]) {
      expect(classifyXResult({ ok: false, reason })).toEqual({ kind: "park", reason, posted: true });
    }
  });

  it("PARKS a permanent nothing-posted result as posted=false (safe to re-arm after a fix)", () => {
    expect(classifyXResult({ ok: false, reason: "empty" })).toEqual({
      kind: "park",
      reason: "empty",
      posted: false,
    });
    expect(classifyXResult({ ok: false, reason: "not_connected" })).toEqual({
      kind: "park",
      reason: "not_connected",
      posted: false,
    });
  });
});
