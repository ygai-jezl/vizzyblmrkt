import { describe, expect, it } from "vitest";
import { pageRecordId, pageRecords } from "./pages";

const env = { tenantId: "ten_A", ownerKind: "workspace" as const, ownerId: "ws1", ticketId: "tkt_1", source: "website" as const };
const page = (url: string, links: string[], title = "A page") => ({ url, title, markdown: "Text.", links });

describe("page records", () => {
  it("keeps each page once, with its address, title, path and links to its own site", () => {
    const links = Array.from({ length: 120 }, (_, i) => `https://acme.example/p/${i}`);
    const records = pageRecords(
      [
        page("https://acme.example/pricing", ["https://acme.example/", "https://acme.example/", "https://acme.example/pricing"], "  Pricing \n| Acme "),
        page("https://acme.example/pricing", [], "Again"),
        page("https://acme.example/docs", links),
      ],
      env,
      "2026-10-15T10:00:00.000Z",
    );
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({
      id: pageRecordId("tkt_1", "https://acme.example/pricing"),
      tenantId: "ten_A",
      ownerKind: "workspace",
      ownerId: "ws1",
      ticketId: "tkt_1",
      source: "website",
      url: "https://acme.example/pricing",
      title: "Pricing | Acme",
      path: "/pricing",
      // Once each, and never itself.
      links: ["https://acme.example/"],
      pageIndex: 0,
      createdAt: "2026-10-15T10:00:00.000Z",
    });
    expect(records[1]).toMatchObject({ pageIndex: 1 });
    expect(records[1]!.links).toHaveLength(100);
  });

  it("gives the same page of the same source the same id, and another source's its own", () => {
    expect(pageRecordId("tkt_1", "https://acme.example/a")).toBe(pageRecordId("tkt_1", "https://acme.example/a"));
    expect(pageRecordId("tkt_1", "https://acme.example/a")).not.toBe(pageRecordId("tkt_2", "https://acme.example/a"));
    expect(pageRecordId("tkt_1", "https://acme.example/a")).toMatch(/^tkt_1__[0-9a-f]{24}$/);
  });
});
