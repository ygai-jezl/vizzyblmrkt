import { describe, it, expect, vi } from "vitest";
import { recordExemplar, scrubExemplarText, MAX_EXEMPLAR_CHARS } from "./recordExemplar";
import type { TenantContext } from "@/lib/tenant/types";
import type { PerformanceExemplar } from "@/lib/types/performanceExemplar";

const ctx: TenantContext = { tenantId: "ten_1", region: "us", source: "system" };

// Typed mocks so mock.calls[i] destructures cleanly.
const mkEmbed = (ret: number[] | null) => vi.fn(async (_text: string) => ret);
const mkWrite = () =>
  vi.fn(async (_ctx: TenantContext, _doc: Omit<PerformanceExemplar, "tenantId">, _vec: number[]) => {});

describe("scrubExemplarText", () => {
  it("redacts emails, @handles, and phone-like numbers", () => {
    const s = scrubExemplarText("hit me at joe@acme.com or @joe_grows, call +1 (415) 555 2671");
    expect(s).not.toContain("joe@acme.com");
    expect(s).not.toContain("@joe_grows");
    expect(s).not.toContain("555");
    expect(s).toContain("[email]");
    expect(s).toContain("[handle]");
    expect(s).toContain("[number]");
  });

  it("redacts obfuscated emails and keeps a year range", () => {
    expect(scrubExemplarText("reach joe [at] acme [dot] com")).toContain("[email]");
    expect(scrubExemplarText("reach joe [at] acme [dot] com")).not.toContain("acme");
    expect(scrubExemplarText("our 2020-2024 results")).toContain("2020-2024"); // not a phone
  });
});

describe("recordExemplar", () => {
  it("scrubs + caps + embeds + writes with a tenant-namespaced id", async () => {
    const embed = mkEmbed([0.1, 0.2, 0.3]);
    const write = mkWrite();
    const r = await recordExemplar(
      ctx,
      {
        channel: "x",
        text: "Great hook, email joe@acme.com",
        tags: ["hook:question", "len:short"],
        metric: { name: "likes", value: 120 },
        sourcePostId: "post:ws:plan:n1",
        sourceRemoteId: "999",
      },
      { embed, write },
    );
    expect(r).toBe("recorded");
    expect(embed).toHaveBeenCalledOnce();
    const [, doc, vector] = write.mock.calls[0]!;
    expect(vector).toEqual([0.1, 0.2, 0.3]);
    expect(doc).toMatchObject({
      id: "pex:ten_1:post:ws:plan:n1", // tenant-namespaced → no cross-tenant overwrite
      channel: "x",
      metric: { name: "likes", value: 120 },
      sourcePostId: "post:ws:plan:n1",
      sourceRemoteId: "999",
    });
    expect(doc.text).not.toContain("joe@acme.com"); // scrubbed before embed + store
    expect(embed.mock.calls[0]![0]).not.toContain("joe@acme.com");
  });

  it("caps text length and tag count", async () => {
    const embed = mkEmbed([0.1]);
    const write = mkWrite();
    await recordExemplar(
      ctx,
      {
        channel: "x",
        text: "a".repeat(MAX_EXEMPLAR_CHARS + 500),
        tags: Array.from({ length: 40 }, (_, i) => `t${i}`),
        metric: { name: "likes", value: 1 },
        sourcePostId: "p1",
      },
      { embed, write },
    );
    const [, doc] = write.mock.calls[0]!;
    expect((doc.text as string).length).toBe(MAX_EXEMPLAR_CHARS);
    expect((doc.tags as string[]).length).toBe(20);
  });

  it("SKIPS (no write) when embedding is unavailable — fail-soft", async () => {
    const embed = mkEmbed(null);
    const write = mkWrite();
    const r = await recordExemplar(
      ctx,
      { channel: "x", text: "hi", metric: { name: "likes", value: 1 }, sourcePostId: "p1" },
      { embed, write },
    );
    expect(r).toBe("skipped");
    expect(write).not.toHaveBeenCalled();
  });

  it("SKIPS when the text scrubs to empty", async () => {
    const embed = mkEmbed([0.1]);
    const write = mkWrite();
    const r = await recordExemplar(
      ctx,
      { channel: "x", text: "   ", metric: { name: "likes", value: 1 }, sourcePostId: "p1" },
      { embed, write },
    );
    expect(r).toBe("skipped");
    expect(embed).not.toHaveBeenCalled();
  });
});
