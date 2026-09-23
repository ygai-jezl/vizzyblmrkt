import { describe, it, expect } from "vitest";
import { launchEmails, percent } from "./launchEmails";

const email = (id: string) => ({ id, type: "email", position: { x: 0, y: 0 }, data: {} });

describe("launchEmails", () => {
  it("summarises the journey, broadcasts and weekly newsletters separately", () => {
    const r = launchEmails(
      { status: "active", graph: { nodes: [email("a"), email("b")], edges: [] }, updatedAt: "2026-09-20T00:00:00Z" } as never,
      [
        { name: "Beta update #1", status: "sent", sentAt: "2026-09-01T00:00:00Z", stats: { openRate: 0.5 } },
        { name: "Beta update #2", status: "sent", sentAt: "2026-09-15T00:00:00Z", stats: { openRate: 0.61 } },
        { name: "Launch day", status: "scheduled", sentAt: null },
        { name: "Idea", status: "draft", sentAt: null },
        { name: "Weekly · #6", status: "sent", sentAt: "2026-09-22T00:00:00Z", audienceMode: "weekly", sourceWorkspaceId: "w1" },
      ] as never,
    );
    expect(r.journey).toEqual({ status: "active", emails: 2, updatedAt: "2026-09-20T00:00:00Z" });
    expect(r.broadcasts).toEqual({
      sent: 2,
      scheduled: 1,
      drafts: 1,
      latest: { name: "Beta update #2", sentAt: "2026-09-15T00:00:00Z", openRate: 0.61 },
    });
    expect(r.newsletters.sent).toBe(1);
    expect(r.newsletters.workspaceIds).toEqual(["w1"]);
  });

  it("a launch with nothing yet", () => {
    const r = launchEmails(null, []);
    expect(r.journey.status).toBe("not_started");
    expect(r.broadcasts.latest).toBeNull();
    expect(r.newsletters.workspaceIds).toEqual([]);
  });

  it("percent", () => {
    expect(percent(0.605)).toBe("61%");
    expect(percent(null)).toBeNull();
  });
});
