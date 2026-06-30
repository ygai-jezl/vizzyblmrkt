import { describe, it, expect } from "vitest";
import { fillTemplate, unfilledTokens, withDynamicTokens } from "./fillTemplate";

describe("fillTemplate", () => {
  it("substitutes known tokens", () => {
    expect(fillTemplate("Hi {{Name}}, welcome to {{Product}}.", { Name: "Sam", Product: "Vizzy" })).toBe(
      "Hi Sam, welcome to Vizzy.",
    );
  });

  it("renders missing/unknown tokens as empty (never leaves braces)", () => {
    expect(fillTemplate("Read {{Missing}} now", {})).toBe("Read  now");
    expect(fillTemplate("{{a}}{{b}}", { a: "x" })).toBe("x");
  });

  it("is whitespace-tolerant in braces", () => {
    expect(fillTemplate("{{  Name  }}", { Name: "Jo" })).toBe("Jo");
  });

  it("repeats a token everywhere it appears", () => {
    expect(fillTemplate("{{X}}-{{X}}-{{X}}", { X: "9" })).toBe("9-9-9");
  });

  it("only escapes the substituted value, never the surrounding skeleton", () => {
    const out = fillTemplate("<p>{{V}}</p>", { V: "<script>" }, (s) =>
      s.replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    );
    expect(out).toBe("<p>&lt;script&gt;</p>");
  });

  it("returns empty string for empty body", () => {
    expect(fillTemplate("", { a: "b" })).toBe("");
  });

  it("ignores over-long tokens (not recognized as variables)", () => {
    const longToken = "a".repeat(61);
    const body = `{{${longToken}}}`;
    expect(fillTemplate(body, { [longToken]: "x" })).toBe(body);
  });
});

describe("unfilledTokens", () => {
  it("flags tokens with no value or a blank value", () => {
    expect(unfilledTokens("{{a}} {{b}} {{c}}", { a: "x", b: "  " })).toEqual(["b", "c"]);
  });
  it("returns [] when all filled", () => {
    expect(unfilledTokens("{{a}}{{b}}", { a: "1", b: "2" })).toEqual([]);
  });
  it("dedupes repeated tokens", () => {
    expect(unfilledTokens("{{a}}{{a}}", {})).toEqual(["a"]);
  });
});

describe("withDynamicTokens", () => {
  it("injects hub_url + subscriber_count and OVERRIDES model values", () => {
    const merged = withDynamicTokens(
      { hub_url: "evil", subscriber_count: "0", Other: "keep" },
      { hubUrl: "https://hub.example", subscriberCount: 1280 },
    );
    expect(merged.hub_url).toBe("https://hub.example");
    expect(merged.subscriber_count).toBe("1280");
    expect(merged.Other).toBe("keep");
  });
  it("skips absent dynamic facts", () => {
    const merged = withDynamicTokens({ a: "1" }, { hubUrl: null, subscriberCount: null });
    expect(merged).toEqual({ a: "1" });
  });
  it("supports both snake_case and PascalCase aliases", () => {
    const merged = withDynamicTokens({}, { hubUrl: "u", subscriberCount: 5 });
    expect(fillTemplate("{{hub_url}}|{{HubUrl}}|{{subscriber_count}}|{{SubscriberCount}}", merged)).toBe(
      "u|u|5|5",
    );
  });
});
