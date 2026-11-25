import { afterEach, describe, expect, it, vi } from "vitest";
import { isLoopsOperator, isLoopsSourceRepo, loopsSourceRepo } from "./operators";

const signedIn = (email: string | undefined, emailVerified: boolean | undefined = true) => ({ email, emailVerified });

describe("loops operators (LOOPS_OPERATOR_EMAILS)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is no one while the setting is empty or unset", () => {
    vi.stubEnv("LOOPS_OPERATOR_EMAILS", "");
    expect(isLoopsOperator(signedIn("owner@example.com"))).toBe(false);
    vi.stubEnv("LOOPS_OPERATOR_EMAILS", " , ");
    expect(isLoopsOperator(signedIn("owner@example.com"))).toBe(false);
  });

  it("names an address that equals one in the list, ignoring case and spaces", () => {
    vi.stubEnv("LOOPS_OPERATOR_EMAILS", "Owner@Example.com, ops@example.test");
    expect(isLoopsOperator(signedIn("owner@example.com"))).toBe(true);
    expect(isLoopsOperator(signedIn("OPS@EXAMPLE.TEST"))).toBe(true);
    expect(isLoopsOperator(signedIn("nina@example.com"))).toBe(false);
    expect(isLoopsOperator(signedIn("owner@example.com.evil.test"))).toBe(false);
    expect(isLoopsOperator(signedIn("wner@example.com"))).toBe(false);
  });

  it("never names an unverified address, or a context with none (an agent's)", () => {
    vi.stubEnv("LOOPS_OPERATOR_EMAILS", "owner@example.com");
    expect(isLoopsOperator(signedIn("owner@example.com", false))).toBe(false);
    expect(isLoopsOperator({ email: "owner@example.com" })).toBe(false);
    expect(isLoopsOperator(signedIn(undefined))).toBe(false);
    expect(isLoopsOperator({})).toBe(false);
  });
});

describe("this copy's own repo (LOOPS_SOURCE_REPO)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is none while unset, and matches a pull request's repo ignoring case", () => {
    vi.stubEnv("LOOPS_SOURCE_REPO", "");
    expect(loopsSourceRepo()).toBeNull();
    expect(isLoopsSourceRepo("acme/app")).toBe(false);
    vi.stubEnv("LOOPS_SOURCE_REPO", " Acme/App ");
    expect(loopsSourceRepo()).toBe("acme/app");
    expect(isLoopsSourceRepo("ACME/app")).toBe(true);
    expect(isLoopsSourceRepo("acme/app-fork")).toBe(false);
  });
});
