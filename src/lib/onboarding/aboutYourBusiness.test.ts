import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import type { BusinessFact, ConversationSummary } from "@/lib/types/onboarding";
import { aboutConversations, aboutFacts, conversationRow, factSource, isGone, talkLabel, undoPick } from "./aboutYourBusiness";
import { ABOUT_WORDS, HOME_WORDS } from "./words";

const NOW = Date.parse("2026-11-26T12:00:00.000Z");
const CALL = { id: `oc_${"a".repeat(32)}`, source: "voice" as const, startedAt: "2026-11-25T10:00:00.000Z", lengthSec: 252, turnCount: 9 };
const CHAT = { id: `oc_${"b".repeat(32)}`, source: "chat" as const, startedAt: "2026-11-25T15:00:00.000Z", lengthSec: 0, turnCount: 3 };

describe("About your business, as data", () => {
  it("sends the browser each fact's words and where they came from, and nothing else", () => {
    const fact: BusinessFact = {
      id: "bf_0123456789abcdef",
      tenantId: "ten_A",
      kind: "start",
      text: "No email list yet",
      quote: "We've never had an email list.",
      source: "voice",
      conversationId: CALL.id,
      heardAt: "2026-11-25T10:00:00.000Z",
      confirmedAt: "2026-11-25T10:06:00.000Z",
      createdAt: "2026-11-25T10:06:00.000Z",
    };
    expect(aboutFacts([fact])).toEqual([
      { id: fact.id, kind: "start", text: "No email list yet", quote: "We've never had an email list.", source: "voice", heardAt: fact.heardAt },
    ]);
    const summary: ConversationSummary = { ...CALL, status: "ended", endedAt: "2026-11-25T10:04:12.000Z", waiting: true };
    expect(aboutConversations([summary])).toEqual([CALL]);
  });

  it("says where a fact came from", () => {
    expect(factSource({ source: "voice", heardAt: "2026-11-25T10:00:00.000Z" }, NOW)).toBe("From our call, 25 Nov");
    expect(factSource({ source: "chat", heardAt: "2026-11-25T10:00:00.000Z" }, NOW)).toBe("From a chat, 25 Nov");
    expect(factSource({ source: "voice", heardAt: "2025-11-25T10:00:00.000Z" }, NOW)).toBe("From our call, 25 Nov 2025");
  });

  it("names each conversation, its date and length, and labels its buttons", () => {
    expect(conversationRow(CALL, NOW)).toEqual({
      what: "call",
      name: "Call with Vizzy",
      date: "25 Nov",
      length: "4 min 12 s",
      viewAria: "View the transcript of the call on 25 Nov",
      deleteAria: "Delete the call on 25 Nov",
    });
    expect(conversationRow(CHAT, NOW)).toMatchObject({ what: "chat", name: "Chat with Vizzy", length: "3 messages", deleteAria: "Delete the chat on 25 Nov" });
  });

  it("asks to talk again only once a call is kept", () => {
    expect(talkLabel([CALL, CHAT])).toBe("Talk with Vizzy again");
    expect(talkLabel([CHAT])).toBe("Talk with Vizzy");
    expect(talkLabel([])).toBe("Talk with Vizzy");
  });

  it("puts back a pick that didn't save, unless a later pick changed it", () => {
    expect(undoPick({ who: "team", run: "shop" }, "who", "team", "solo")).toEqual({ who: "solo", run: "shop" });
    expect(undoPick({ who: "team" }, "who", "team", undefined)).toEqual({});
    const later = { who: "agency" as const };
    expect(undoPick(later, "who", "team", "solo")).toBe(later);
  });

  it("counts a remove as done when it worked or the fact was already gone", () => {
    expect(isGone({ ok: true, status: 200 })).toBe(true);
    expect(isGone({ ok: false, status: 404 })).toBe(true);
    expect(isGone({ ok: false, status: 403 })).toBe(false);
    expect(isGone({ ok: false, status: 503 })).toBe(false);
    expect(isGone(null)).toBe(false);
  });

  it("uses no dashes as punctuation and none of the AI tells in any of its words", () => {
    const lines = [
      ...Object.values(ABOUT_WORDS).map((w) => (typeof w === "function" ? w("call", "25 Nov") : w)),
      ...Object.values(HOME_WORDS),
    ];
    for (const line of lines) {
      expect(dashesIn(line), line).toEqual([]);
      expect(aiTellsIn(line), line).toEqual([]);
    }
  });
});
