import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContentNode, ContentPlan } from "@/lib/types/contentPlan";
import { isReadyNewsletterHub, listReadyHubs } from "./weeklyHubs";

function node(overrides: Partial<ContentNode>): ContentNode {
  return {
    id: "n1",
    type: "hub",
    channel: "newsletter",
    role: "Hub",
    position: { x: 0, y: 0 },
    body: "# Week One\n\nThe body of this week's newsletter.",
    placeholderValues: {},
    status: "generated",
    warnings: [],
    ...overrides,
  } as ContentNode;
}

function plan(nodes: ContentNode[], overrides: Partial<ContentPlan> = {}): ContentPlan {
  return {
    id: "plan1",
    name: "Launch newsletter",
    updatedAt: "2026-07-01T00:00:00Z",
    graph: { nodes, edges: [] },
    ...overrides,
  } as unknown as ContentPlan;
}

describe("isReadyNewsletterHub", () => {
  it("accepts a generated/approved newsletter hub with a body", () => {
    expect(isReadyNewsletterHub(node({}))).toBe(true);
    expect(isReadyNewsletterHub(node({ status: "approved" }))).toBe(true);
  });

  it("rejects blog and ebook hubs (newsletter-only)", () => {
    expect(isReadyNewsletterHub(node({ channel: "blog" }))).toBe(false);
    expect(isReadyNewsletterHub(node({ channel: "ebook" }))).toBe(false);
  });

  it("rejects ungenerated / empty-body / non-hub nodes", () => {
    expect(isReadyNewsletterHub(node({ status: "empty" }))).toBe(false);
    expect(isReadyNewsletterHub(node({ status: "generating" }))).toBe(false);
    expect(isReadyNewsletterHub(node({ body: "   " }))).toBe(false);
    expect(isReadyNewsletterHub(node({ type: "spoke", channel: "linkedin" }))).toBe(false);
    expect(isReadyNewsletterHub(node({ type: "email" }))).toBe(false);
  });
});

describe("listReadyHubs", () => {
  it("aggregates ready newsletter hubs with a derived subject + snippet", () => {
    const hubs = listReadyHubs([
      plan([node({ id: "hub1", body: "# Big News\n\nExciting stuff happened this week." })], {
        id: "planA",
        name: "Plan A",
        updatedAt: "2026-07-02T00:00:00Z",
      }),
    ]);
    expect(hubs).toHaveLength(1);
    expect(hubs[0]).toMatchObject({
      planId: "planA",
      planName: "Plan A",
      planUpdatedAt: "2026-07-02T00:00:00Z",
      nodeId: "hub1",
      channel: "newsletter",
      subject: "Big News", // leading H1 → title
    });
    expect(hubs[0]!.snippet).toContain("Exciting stuff");
    expect(hubs[0]!.body).toContain("Big News");
  });

  it("skips non-ready and non-newsletter hubs across plans", () => {
    const hubs = listReadyHubs([
      plan([node({ id: "ok", channel: "newsletter", status: "generated" })], { id: "p1" }),
      plan([node({ id: "blog", channel: "blog" })], { id: "p2" }),
      plan([node({ id: "empty", body: "" })], { id: "p3" }),
      plan([node({ id: "spoke", type: "spoke", channel: "linkedin" })], { id: "p4" }),
    ]);
    expect(hubs.map((h) => h.nodeId)).toEqual(["ok"]);
  });

  it("falls back to the node role when the body has no leading heading", () => {
    const hubs = listReadyHubs([
      plan([node({ id: "h", body: "Just a plain first line here.", role: "Hub" })]),
    ]);
    expect(hubs[0]!.subject).toBe("Just a plain first line here.");
  });
});

describe("listReadyHubs, formatted (NEWSLETTER_MARKDOWN_EMAIL_ENABLED)", () => {
  const md = "# Big News\n\n## What is new\n\n**Journey links** carry on from another journey.\n\n- One\n- Two";
  afterEach(() => vi.unstubAllEnvs());

  it("keeps the Markdown exactly as it is with the switch off", () => {
    vi.stubEnv("NEWSLETTER_MARKDOWN_EMAIL_ENABLED", "false");
    expect(listReadyHubs([plan([node({ id: "h", body: md })])])[0]!.body).toBe(md);
  });

  it("hands the broadcast email HTML with the switch on", () => {
    vi.stubEnv("NEWSLETTER_MARKDOWN_EMAIL_ENABLED", "true");
    const [hub] = listReadyHubs([plan([node({ id: "h", body: md })])]);
    expect(hub!.body).toContain(">What is new</h2>");
    expect(hub!.body).toContain("<strong>Journey links</strong>");
    expect(hub!.body).toContain("<li");
    expect(hub!.body).not.toContain("**");
    // The subject and snippet still come from the Markdown.
    expect(hub!.subject).toBe("Big News");
    expect(hub!.snippet).not.toContain("<");
  });

  it("sends the Markdown as before when its HTML wouldn't fit a broadcast", () => {
    vi.stubEnv("NEWSLETTER_MARKDOWN_EMAIL_ENABLED", "true");
    let tiny = "";
    while (tiny.length < 19_900) tiny += "| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n\n";
    expect(listReadyHubs([plan([node({ id: "h", body: tiny })])])[0]!.body).toBe(tiny);
  });
});
