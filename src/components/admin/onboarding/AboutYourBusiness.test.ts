import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AboutConversation, AboutFact } from "@/lib/onboarding/aboutYourBusiness";
import { AboutYourBusiness, type AboutYourBusinessProps } from "./AboutYourBusiness";

// A made-up plant shop, as the owner-approved mockups draw it (o-canvas About.html).
const year = new Date().getUTCFullYear();
const FACTS: AboutFact[] = [
  { id: "bf_0000000000000001", kind: "channel", text: "Sells at three farmers' markets", quote: "We sell at three farmers' markets most weekends.", source: "voice", heardAt: `${year}-11-25T10:00:00.000Z` },
  { id: "bf_0000000000000002", kind: "goal", text: "A Christmas gift box", quote: "A plant, a pot and a care card.", source: "chat", heardAt: `${year}-11-25T15:00:00.000Z` },
];
const CONVERSATIONS: AboutConversation[] = [
  { id: `oc_${"a".repeat(32)}`, source: "voice", startedAt: `${year}-11-25T10:00:00.000Z`, lengthSec: 252, turnCount: 9 },
  { id: `oc_${"b".repeat(32)}`, source: "chat", startedAt: `${year}-11-25T15:00:00.000Z`, lengthSec: 0, turnCount: 3 },
];

const render = (over: Partial<AboutYourBusinessProps> = {}) =>
  renderToStaticMarkup(
    createElement(AboutYourBusiness, { answers: { who: "solo", run: "shop" }, facts: FACTS, conversations: CONVERSATIONS, voice: true, editable: true, ...over }),
  )
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"');

describe("About your business", () => {
  it("lists what Vizzy learned with its count, each fact's own words, where it came from and Remove", () => {
    const html = render();
    expect(html).toMatch(/What Vizzy learned <span[^>]*>2<\/span>/);
    expect(html).toContain("<q");
    expect(html).toContain("We sell at three farmers' markets most weekends.");
    expect(html).toContain("From our call, 25 Nov");
    expect(html).toContain("From a chat, 25 Nov");
    expect(html).toContain('aria-label="Remove A Christmas gift box"');
    expect(html.split(">Remove<").length - 1).toBe(2);
  });

  it("lists both kinds of conversation with View transcript and Delete", () => {
    const html = render();
    expect(html).toContain("<table");
    for (const header of [">Conversation<", ">Date<", ">Length<", '<span class="sr-only">Actions</span>']) expect(html).toContain(header);
    expect(html).toContain("Call with Vizzy");
    expect(html).toContain("4 min 12 s");
    expect(html).toContain("Chat with Vizzy");
    expect(html).toContain("3 messages");
    expect(html).toContain('aria-label="View the transcript of the chat on 25 Nov"');
    expect(html.split(">View transcript<").length - 1).toBe(2);
    expect(html.split(">Delete<").length - 1).toBe(2);
  });

  it("says so when nothing is kept yet", () => {
    const html = render({ answers: {}, facts: [], conversations: [] });
    expect(html).toContain("Nothing yet. Talk with Vizzy to add more.");
    expect(html).toContain("No conversations kept.");
    expect(html).not.toContain("<table");
    // Every question reads Not picked, and opens its choices.
    expect(html.split(">Not picked<").length - 1).toBe(4);
    expect(html.split('aria-haspopup="menu"').length - 1).toBe(4);
  });

  it("links Talk with Vizzy as a plain link to the welcome, only with voice on", () => {
    expect(render()).toMatch(/<a href="\/admin\/welcome"[^>]*>.*Talk with Vizzy again<\/a>/s);
    expect(render({ conversations: [CONVERSATIONS[1]!] })).toMatch(/<a href="\/admin\/welcome"[^>]*>.*Talk with Vizzy<\/a>/s);
    expect(render({ voice: false })).not.toContain("/admin/welcome");
  });

  it("shows the answers without their menus when they can't be saved", () => {
    const html = render({ editable: false });
    expect(html).toContain("A solo founder");
    expect(html).toContain("A shop or products");
    expect(html.split(">Not picked<").length - 1).toBe(2);
    expect(html).not.toContain('aria-haspopup="menu"');
  });

  it("shows no banner until a conversation is deleted", () => {
    expect(render()).not.toContain("Conversation deleted.");
  });
});
