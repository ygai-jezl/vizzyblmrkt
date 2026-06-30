import { describe, it, expect } from "vitest";
import { readEnv, embeddingLocation, databaseIdForRegion } from "./config";

const base: Record<string, string> = {
  TICKET_ID: "t",
  TENANT_ID: "ten",
  OWNER_KIND: "workspace",
  OWNER_ID: "ws1",
  REGION: "us",
  INGEST_SOURCE: "github",
  SOURCE_URI: "https://github.com/o/r",
  TOPIC: "systems",
  GOOGLE_CLOUD_PROJECT: "proj",
};

describe("region maps", () => {
  it("maps regions to regional DBs", () => {
    expect(databaseIdForRegion("us")).toBe("(default)");
    expect(databaseIdForRegion("eu")).toBe("signups-eu");
    expect(databaseIdForRegion("asia")).toBe("signups-asia");
  });
  it("maps regions to regional (non-global) embedding locations", () => {
    expect(embeddingLocation("us")).toBe("us-central1");
    expect(embeddingLocation("eu")).toBe("europe-west4");
    expect(embeddingLocation("asia")).toBe("asia-southeast1");
  });
});

describe("readEnv", () => {
  it("parses required fields + owner/topic/tags + JSON arrays", () => {
    const env = readEnv({
      ...base,
      INCLUDE_GLOBS: JSON.stringify(["src/**"]),
      TAGS: JSON.stringify(["pricing", "geo"]),
    });
    expect(env.tenantId).toBe("ten");
    expect(env.region).toBe("us");
    expect(env.ownerKind).toBe("workspace");
    expect(env.ownerId).toBe("ws1");
    expect(env.topic).toBe("systems");
    expect(env.tags).toEqual(["pricing", "geo"]);
    expect(env.includeGlobs).toEqual(["src/**"]);
    expect(env.ref).toBeNull();
    expect(env.maxPages).toBe(20);
  });

  it("defaults tags to [] and tolerates malformed TAGS", () => {
    expect(readEnv(base).tags).toEqual([]);
    expect(readEnv({ ...base, TAGS: "not json" }).tags).toEqual([]);
  });

  it("tolerates missing / malformed / empty INCLUDE_GLOBS (→ null)", () => {
    expect(readEnv(base).includeGlobs).toBeNull();
    expect(readEnv({ ...base, INCLUDE_GLOBS: "not json" }).includeGlobs).toBeNull();
    expect(readEnv({ ...base, INCLUDE_GLOBS: "[]" }).includeGlobs).toBeNull();
    expect(readEnv({ ...base, INCLUDE_GLOBS: JSON.stringify([1, 2]) }).includeGlobs).toBeNull();
  });

  it("throws on a missing required var or an invalid enum", () => {
    expect(() => readEnv({ ...base, TICKET_ID: "" })).toThrow();
    expect(() => readEnv({ ...base, REGION: "mars" })).toThrow();
    expect(() => readEnv({ ...base, INGEST_SOURCE: "ftp" })).toThrow();
    expect(() => readEnv({ ...base, OWNER_KIND: "galaxy" })).toThrow();
    expect(() => readEnv({ ...base, TOPIC: "" })).toThrow();
  });

  it("caps maxPages and defaults it", () => {
    expect(readEnv({ ...base, KNOWLEDGE_MAX_PAGES: "500" }).maxPages).toBe(100);
    expect(readEnv({ ...base, KNOWLEDGE_MAX_PAGES: "5" }).maxPages).toBe(5);
    expect(readEnv({ ...base, KNOWLEDGE_MAX_PAGES: "oops" }).maxPages).toBe(20);
  });
});
