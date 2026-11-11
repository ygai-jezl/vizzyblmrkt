import { describe, expect, it } from "vitest";
import { FakeFirestore } from "./testing/fakeFirestore";
import { appendBrandVoiceRule } from "./control";

function seeded(brandVoice?: unknown): FakeFirestore {
  const db = new FakeFirestore();
  for (const id of ["ten_A", "ten_B"]) {
    db.seed("tenants", id, {
      tenantName: "Example Co",
      rootDomain: "example.com",
      status: "active",
      region: "us",
      allowedOrigins: ["https://example.com"],
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      ...(brandVoice === undefined ? {} : { brandVoice }),
    });
  }
  return db;
}

describe("adding a rule to the brand voice", () => {
  it("adds it to the Do list, keeps the rest of the voice, and leaves other brands alone", async () => {
    const db = seeded({ summary: "Warm", dos: ["Use plain words"], donts: ["Hype"] });
    expect(await appendBrandVoiceRule("ten_A", " Keeps intros short. ", db)).toBe("added");
    const voice = db.raw("tenants", "ten_A")!.brandVoice as Record<string, unknown>;
    expect(voice).toMatchObject({ summary: "Warm", dos: ["Use plain words", "Keeps intros short."], donts: ["Hype"] });
    expect((db.raw("tenants", "ten_B")!.brandVoice as Record<string, unknown>).dos).toEqual(["Use plain words"]);
  });

  it("starts a voice when there is none, and doesn't add the same rule twice", async () => {
    const db = seeded();
    expect(await appendBrandVoiceRule("ten_A", "Uses UK spelling.", db)).toBe("added");
    expect(await appendBrandVoiceRule("ten_A", "uses uk spelling.", db)).toBe("exists");
  });

  it("stops at 12, and says when there's no such brand", async () => {
    const db = seeded({ dos: Array.from({ length: 12 }, (_, i) => `Rule ${i}`) });
    expect(await appendBrandVoiceRule("ten_A", "One more.", db)).toBe("full");
    expect(await appendBrandVoiceRule("ten_missing", "One more.", db)).toBe("missing");
  });
});
