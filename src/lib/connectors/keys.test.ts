import { describe, expect, it } from "vitest";
import { queryKey } from "@/lib/signals/store";
import { connectionOfSearchRef, dayKey, pageKey, planningId, rolledId, searchTextRef, snapshotId, topicKey } from "./keys";

describe("the shared keys", () => {
  it("writes a page as its host and cleaned path, the path alone without a host", () => {
    expect(pageKey("Blog.Example.com", "/pricing?utm_source=x#top")).toBe("blog.example.com/pricing");
    expect(pageKey("", "pricing")).toBe("/pricing");
    expect(pageKey("example.com", "https://example.com/a/b?c=d")).toBe("example.com/a/b");
  });

  it("keys a search's words as the brand map does", () => {
    expect(topicKey("Track Brand  in ChatGPT?")).toBe(queryKey("track brand in chatgpt"));
    expect(topicKey("track brand in chatgpt")).toBe(topicKey("TRACK brand in ChatGPT"));
  });

  it("gives the day in the provider's zone, never the server's", () => {
    const at = new Date("2026-11-21T05:00:00.000Z");
    expect(dayKey(at, "UTC")).toBe("2026-11-21");
    expect(dayKey(at, "America/Los_Angeles")).toBe("2026-11-20");
    expect(dayKey(at, "Asia/Tokyo")).toBe("2026-11-21");
  });

  it("fixes every id with its generation, so a new site's numbers never share an old one's", () => {
    expect(snapshotId("dcn_aaaaaaaaaaaaaaaaaaaa", 0, "search_performance", "page", "2026-11-20")).toBe("dcn_aaaaaaaaaaaaaaaaaaaa_0_search_performance_page_2026-11-20");
    expect(snapshotId("dcn_aaaaaaaaaaaaaaaaaaaa", 1, "search_performance", "page", "2026-11-20")).not.toBe(snapshotId("dcn_aaaaaaaaaaaaaaaaaaaa", 0, "search_performance", "page", "2026-11-20"));
    expect(rolledId("dcn_aaaaaaaaaaaaaaaaaaaa", 2, "site_traffic", "landing", "r90")).toBe("dcn_aaaaaaaaaaaaaaaaaaaa_2_site_traffic_landing_r90");
    expect(planningId("dcn_aaaaaaaaaaaaaaaaaaaa", 0, "search_performance", "question")).toBe("dcn_aaaaaaaaaaaaaaaaaaaa_0_search_performance_question_r28");
  });

  it("names a connection's searches in brand search by the connection, and reads it back", () => {
    expect(searchTextRef("dcn_aaaaaaaaaaaaaaaaaaaa")).toBe("gsc:dcn_aaaaaaaaaaaaaaaaaaaa");
    expect(connectionOfSearchRef("gsc:dcn_aaaaaaaaaaaaaaaaaaaa")).toBe("dcn_aaaaaaaaaaaaaaaaaaaa");
    for (const other of ["serp:sig_1", "imp_1", "dcn_aaaaaaaaaaaaaaaaaaaa"]) expect(connectionOfSearchRef(other)).toBeNull();
  });
});
