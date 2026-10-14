import { describe, expect, it } from "vitest";
import { articleAddressProblem, isAddressProblem } from "./address";

describe("an article's address", () => {
  it("is a full https address of a page that is not the home page", () => {
    expect(articleAddressProblem("https://acme.example/blog/share-of-voice")).toBeNull();
    expect(articleAddressProblem("  https://acme.example/blog/x  ")).toBeNull();
    // Some sites address every post with a query.
    expect(articleAddressProblem("https://acme.example/?p=12")).toBeNull();
  });

  it("is never the home page, a plain-http page, or something that is not a link", () => {
    expect(articleAddressProblem("https://acme.example")).toBe("home_page");
    expect(articleAddressProblem("https://acme.example/")).toBe("home_page");
    expect(articleAddressProblem("https://acme.example/#blog")).toBe("home_page");
    expect(articleAddressProblem("http://acme.example/blog/x")).toBe("not_https");
    expect(articleAddressProblem("acme.example/blog/x")).toBe("not_https");
    expect(articleAddressProblem("javascript:alert(1)")).toBe("not_https");
    expect(articleAddressProblem(`https://acme.example/${"x".repeat(2000)}`)).toBe("not_https");
  });

  it("knows its own reasons", () => {
    expect(isAddressProblem("home_page")).toBe(true);
    expect(isAddressProblem("rate_limited")).toBe(false);
  });
});
