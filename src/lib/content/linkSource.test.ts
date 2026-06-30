import { describe, it, expect } from "vitest";
import { classifyLinkSource } from "./linkSource";

describe("classifyLinkSource", () => {
  it("flags flaky social hosts as not auto-fetchable", () => {
    expect(classifyLinkSource("https://x.com/a/status/1").fetchable).toBe(false);
    expect(classifyLinkSource("https://twitter.com/a").fetchable).toBe(false);
    expect(classifyLinkSource("https://www.linkedin.com/posts/x").fetchable).toBe(false);
    expect(classifyLinkSource("https://m.youtube.com/watch?v=1").fetchable).toBe(false);
  });

  it("allows normal article/blog hosts", () => {
    expect(classifyLinkSource("https://example.com/post").fetchable).toBe(true);
    expect(classifyLinkSource("https://blog.dev/x").fetchable).toBe(true);
  });

  it("strips www/mobile to the bare host", () => {
    expect(classifyLinkSource("https://www.example.com/p").host).toBe("example.com");
    expect(classifyLinkSource("https://mobile.twitter.com/a").host).toBe("twitter.com");
  });

  it("rejects non-http(s) and invalid URLs", () => {
    expect(classifyLinkSource("ftp://x.com").host).toBeNull();
    expect(classifyLinkSource("not a url").host).toBeNull();
    expect(classifyLinkSource("not a url").fetchable).toBe(false);
  });
});
