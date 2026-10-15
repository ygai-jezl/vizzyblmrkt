import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrandMapDecidedSchema } from "@/lib/types/brandMap";
import { proposeBrandMap } from "./research";

/**
 * Pins what the brand map's research asks and files TODAY: its prompt, and the suggestions it
 * makes of an answer with more subjects and questions than it keeps. With the scale switch
 * off, both must stay exactly as they are (see pins.test.ts for the rest of the map).
 */

vi.mock("@/lib/tenant", () => ({
  getTenantById: vi.fn(async () => ({ id: "ten_pin", tenantName: "Acme", rootDomain: "acme.example", allowedOrigins: [], brandVoice: { summary: "Plain and direct." } })),
}));
vi.mock("@/lib/tenant/workspaceContent", () => ({ listContentPlans: vi.fn(async () => []) }));

afterEach(() => vi.clearAllMocks());

const digest = (value: unknown) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex")
    .slice(0, 16);

describe("what the brand map's research asks and files today", () => {
  it("asks the same question and files the same suggestions", async () => {
    const answer = [
      "IS: Acme shows marketing teams how AI assistants describe their brand.",
      "CATEGORY: AI visibility tracking",
      ...["Share of voice", "Citations", "Audits", "Prompts", "Benchmarks", "Reporting"].flatMap((s, i) => [
        `SUBJECT: ${s}`,
        ...Array.from({ length: 7 }, (_, j) => `Q: How does ${s.toLowerCase()} work, part ${i}.${j}? | how_to`),
      ]),
      "NAME: Rivalco | alternative | Rival Co",
      "HOME: Share of voice | 1",
    ].join("\n");
    const grounded = vi.fn(async () => ({ text: answer, model: "m", sources: [], supports: [] }));
    const r = await proposeBrandMap(
      { tenantId: "ten_pin", region: "us", source: "idtoken" },
      { current: BrandMapDecidedSchema.parse({ identity: { name: "Acme", site: "https://acme.example" } }) },
      {
        grounded: grounded as never,
        modelReady: () => true,
        retrieve: (async () => ({ formatted: "[Source: Pulse — https://acme.example/pulse]\nAcme Pulse sends a weekly report.", chunks: [] })) as never,
        sitePages: async () => ({ pages: [{ url: "https://acme.example/share-of-voice", title: "Share of voice" }], repoPaths: [] }),
        fetchHome: async () => ({ html: "", text: "Acme. Marketing teams use it.", baseUrl: "https://acme.example/" }),
        plans: (async () => []) as never,
        workspaces: async () => [{ id: "ws1" }],
        now: () => new Date("2026-10-15T09:00:00.000Z"),
      },
    );
    expect(r.ok && r.items.filter((i) => i.change.type === "add_subject")).toHaveLength(5);
    expect(digest(String((grounded.mock.calls[0] as unknown[])[0]))).toBe("8d371fca6d179035");
    expect(digest(r)).toBe("79715ce6ac6baaa7");
  });
});
