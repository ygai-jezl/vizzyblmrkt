import { describe, expect, it, vi } from "vitest";
import { asCard, cardListeners } from "./cardData";

const card = (over: Record<string, unknown> = {}) => ({
  card: {
    kind: "email_style",
    id: "email_style",
    title: "Email style suggestion",
    url: "/admin/brand-kit/email-style",
    stats: [{ label: "header", value: "#000080" }],
    warnings: 0,
    ...over,
  },
});

describe("asCard", () => {
  it("keeps a kind's note and link label, trimmed and clipped", () => {
    const r = asCard(card({ note: "  Suggestion — nothing changes until an admin applies it. ", cta: "Review and apply" }));
    expect(r).toMatchObject({ note: "Suggestion — nothing changes until an admin applies it.", cta: "Review and apply" });
    const long = asCard(card({ note: "n".repeat(500), cta: "c".repeat(500) }));
    expect(long?.note).toHaveLength(160);
    expect(long?.cta).toHaveLength(40);
  });

  it("drops a note or label that isn't a string (or is blank), so the card's defaults show", () => {
    const r = asCard(card({ note: { html: "<b>x</b>" }, cta: 42 }));
    expect(r).not.toBeNull();
    expect(r).not.toHaveProperty("note");
    expect(r).not.toHaveProperty("cta");
    expect(asCard(card({ note: "   " }))).not.toHaveProperty("note");
  });

  it("leaves other kinds' cards as they were", () => {
    expect(asCard(card({ kind: "lifecycle", id: "j1", url: "/admin/lifecycle/j1" }))).toEqual({
      kind: "lifecycle",
      id: "j1",
      title: "Email style suggestion",
      subtitle: undefined,
      url: "/admin/lifecycle/j1",
      stats: [{ label: "header", value: "#000080" }],
      warnings: 0,
    });
  });

  it("rejects a link outside the admin app, and anything that isn't a card", () => {
    expect(asCard(card({ url: "https://evil.example.com/admin/" }))).toBeNull();
    expect(asCard(card({ url: "//evil.example.com/admin/" }))).toBeNull();
    expect(asCard(card({ url: "/api/agent/email-style" }))).toBeNull();
    expect(asCard(card({ id: 7 }))).toBeNull();
    expect(asCard({ status: "ok" })).toBeNull();
    expect(asCard(undefined)).toBeNull();
  });
});

describe("cardListeners", () => {
  const saved = asCard(card())!;
  it("tells every listener until it unsubscribes", () => {
    const hub = cardListeners();
    const a: string[] = [];
    const b: string[] = [];
    const offA = hub.add((c) => a.push(c.id));
    hub.add((c) => b.push(c.id));
    hub.emit(saved);
    offA();
    hub.emit(saved);
    expect(a).toEqual(["email_style"]);
    expect(b).toEqual(["email_style", "email_style"]);
  });

  it("a listener that throws doesn't stop the others", () => {
    const hub = cardListeners();
    const heard: string[] = [];
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    hub.add(() => {
      throw new Error("boom");
    });
    hub.add((c) => heard.push(c.id));
    expect(() => hub.emit(saved)).not.toThrow();
    expect(heard).toEqual(["email_style"]);
    quiet.mockRestore();
  });
});
