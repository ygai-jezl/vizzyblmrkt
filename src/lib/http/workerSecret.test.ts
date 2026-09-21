import { describe, it, expect } from "vitest";
import { workerSecretMatches } from "./workerSecret";

describe("workerSecretMatches", () => {
  it("accepts the exact secret", () => {
    expect(workerSecretMatches("s3cret-value", "s3cret-value")).toBe(true);
  });

  it("rejects a wrong secret, including one of a different length", () => {
    expect(workerSecretMatches("s3cret-valuf", "s3cret-value")).toBe(false);
    expect(workerSecretMatches("s3cret", "s3cret-value")).toBe(false);
    expect(workerSecretMatches("s3cret-value-and-more", "s3cret-value")).toBe(false);
  });

  it("never authenticates when either side is empty or missing", () => {
    expect(workerSecretMatches("", "")).toBe(false);
    expect(workerSecretMatches(null, "s3cret-value")).toBe(false);
    expect(workerSecretMatches("s3cret-value", undefined)).toBe(false);
    expect(workerSecretMatches(undefined, undefined)).toBe(false);
  });
});
