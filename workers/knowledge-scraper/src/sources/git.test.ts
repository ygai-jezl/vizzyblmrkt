import { describe, it, expect } from "vitest";
import { __test } from "./git";

const { assertAllowedHost, authedUrl } = __test;

describe("assertAllowedHost (worker token-exfil guard)", () => {
  it("allows the expected provider hosts over https", () => {
    expect(() => assertAllowedHost("github", "https://github.com/o/r")).not.toThrow();
    expect(() => assertAllowedHost("github", "https://www.github.com/o/r")).not.toThrow();
    expect(() => assertAllowedHost("gitlab", "https://gitlab.com/o/r")).not.toThrow();
  });

  it("rejects a foreign host (would leak the private token)", () => {
    expect(() => assertAllowedHost("github", "https://evil.example/o/r")).toThrow();
    // wrong provider's host for the declared source
    expect(() => assertAllowedHost("github", "https://gitlab.com/o/r")).toThrow();
  });

  it("rejects non-https schemes", () => {
    expect(() => assertAllowedHost("github", "http://github.com/o/r")).toThrow();
    expect(() => assertAllowedHost("github", "ssh://git@github.com/o/r")).toThrow();
    expect(() => assertAllowedHost("github", "not a url")).toThrow();
  });
});

describe("authedUrl", () => {
  it("injects provider-specific basic-auth only when a token is present", () => {
    expect(authedUrl("github", "https://github.com/o/r")).toBe("https://github.com/o/r");
    expect(authedUrl("github", "https://github.com/o/r", "tok")).toBe(
      "https://x-access-token:tok@github.com/o/r",
    );
    expect(authedUrl("gitlab", "https://gitlab.com/o/r", "tok")).toBe(
      "https://oauth2:tok@gitlab.com/o/r",
    );
  });
});
