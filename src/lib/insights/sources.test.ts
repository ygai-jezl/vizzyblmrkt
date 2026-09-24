import { describe, expect, it } from "vitest";
import { bqSourceCaseSql, classifySignupSource, CONTENT_SOURCES } from "./sources";

describe("signup sources", () => {
  it("classifies by referral, UTM tags, then the referring site", () => {
    expect(classifySignupSource({ referredBySignupToken: "abc", utm: { source: "linkedin" } })).toBe("referral");
    expect(classifySignupSource({ utm: { source: "LinkedIn_Company" } })).toBe("linkedin");
    expect(classifySignupSource({ referrerUrl: "https://www.linkedin.com/feed/" })).toBe("linkedin");
    expect(classifySignupSource({ referrerUrl: "https://t.co/abc" })).toBe("x");
    expect(classifySignupSource({ utm: { medium: "email" } })).toBe("newsletter");
    expect(classifySignupSource({ referrerUrl: "https://m.facebook.com/x" })).toBe("other_content");
    expect(classifySignupSource({ referrerUrl: "https://www.google.co.uk/" })).toBe("direct"); // not a listed host
    expect(classifySignupSource({ referrerUrl: "https://www.google.com/search" })).toBe("search");
    expect(classifySignupSource({})).toBe("direct");
    expect(classifySignupSource({ referrerUrl: "not a url" })).toBe("direct");
    // A look-alike host doesn't count.
    expect(classifySignupSource({ referrerUrl: "https://evil-linkedin.com.example.test/" })).toBe("direct");
  });

  it("marks posts, newsletters and other social as content", () => {
    expect([...CONTENT_SOURCES].sort()).toEqual(["linkedin", "newsletter", "other_content", "x"]);
  });

  it("builds the BigQuery CASE from the same rules, constants only", () => {
    const sql = bqSourceCaseSql();
    expect(sql.startsWith("CASE WHEN referred_by_token IS NOT NULL THEN 'referral'")).toBe(true);
    expect(sql).toContain("r'(linkedin|lnkd)'");
    expect(sql).toContain("IN ('email', 'newsletter')");
    expect(sql).toContain(String.raw`r'(^|\.)(linkedin\.com|lnkd\.in)$'`);
    expect(sql.endsWith("ELSE 'direct' END")).toBe(true);
    expect(sql).not.toMatch(/@|;/);
  });
});
