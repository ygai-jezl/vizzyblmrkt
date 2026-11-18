import { describe, expect, it } from "vitest";
import { applyEngagement, LINKS_MAX, scrubDiag, scrubLink } from "./engagement";
import type { MandrillEvent } from "./mandrillWebhook";

const T = 1_790_000_000;
const open = (ts: number, extra: Record<string, unknown> = {}): MandrillEvent => ({ event: "open", ts, msg: { _id: "m_1", ...extra }, ...extra }) as MandrillEvent;
const click = (ts: number, url: string): MandrillEvent => ({ event: "click", ts, url, msg: { _id: "m_1" } }) as MandrillEvent;

describe("applyEngagement", () => {
  it("counts every open with its first and last time, device and client", () => {
    const a = applyEngagement({}, [
      { ...open(T), user_agent_parsed: { mobile: true, ua_family: "Apple Mail" } } as MandrillEvent,
      { ...open(T + 60), user_agent_parsed: { mobile: false, ua_family: "Gmail" } } as MandrillEvent,
      open(T + 120),
    ])!;
    expect(a.opens).toEqual({
      count: 3,
      firstAt: new Date(T * 1000).toISOString(),
      lastAt: new Date((T + 120) * 1000).toISOString(),
      mobile: 1,
      desktop: 1,
      clients: { "Apple Mail": 1, Gmail: 1 },
    });
    expect(a.mandrillMessageId).toBe("m_1");
  });

  it("counts nothing twice when Mandrill sends a batch again", () => {
    const first = applyEngagement({}, [open(T), click(T + 5, "https://acme.test/pricing")])!;
    expect(applyEngagement(first, [open(T), click(T + 5, "https://acme.test/pricing")])).toBeNull();
    const later = applyEngagement(first, [open(T + 600)])!;
    expect(later.opens?.count).toBe(2);
    expect(later.clicks?.count).toBe(1);
  });

  it("never counts fewer opens than Mandrill lists on the message", () => {
    const a = applyEngagement({}, [{ event: "open", ts: T, msg: { opens: [{}, {}, {}, {}] } } as MandrillEvent])!;
    expect(a.opens?.count).toBe(4);
  });

  it("keeps the links clicked without query strings or tokens, up to a cap", () => {
    const a = applyEngagement({}, [
      click(T, "https://acme.test/pricing?utm_source=mail&email=sam@example.com"),
      click(T + 1, "https://acme.test/pricing"),
      click(T + 2, "https://acme.test/verify/abcdefghijklmnopqrstuvwxyz123456"),
    ])!;
    expect(a.clicks?.links).toEqual([
      { url: "https://acme.test/pricing", count: 2 },
      { url: "https://acme.test/verify/:token", count: 1 },
    ]);
    const many = applyEngagement({}, Array.from({ length: LINKS_MAX + 5 }, (_, i) => click(T + i, `https://acme.test/p${i}`)))!;
    expect(many.clicks?.links).toHaveLength(LINKS_MAX);
    expect(many.clicks?.count).toBe(LINKS_MAX + 5);
  });

  it("keeps bounce detail without addresses, and a soft bounce never replaces a hard one", () => {
    const hard = applyEngagement({}, [{ event: "hard_bounce", ts: T, msg: { bounce_description: "bad_mailbox", diag: "smtp;550 5.1.1 <sam@example.com>: no such user" } } as MandrillEvent])!;
    expect(hard.bounce).toEqual({ kind: "hard", description: "bad_mailbox", diag: "smtp;550 5.1.1 <address>: no such user", at: new Date(T * 1000).toISOString() });
    const soft = applyEngagement(hard, [{ event: "soft_bounce", ts: T + 9, msg: { bounce_description: "mailbox_full" } } as MandrillEvent])!;
    expect(soft.bounce).toBeUndefined();
  });

  it("keeps deferrals, rejections, complaints and unsubscribes", () => {
    const a = applyEngagement({}, [
      { event: "deferral", ts: T, msg: {} },
      { event: "deferral", ts: T + 60, msg: {} },
      { event: "reject", ts: T + 61, msg: { reject: { reason: "hard-bounce" } } } as MandrillEvent,
      { event: "spam", ts: T + 62, msg: {} },
      { event: "unsub", ts: T + 63, msg: {} },
    ])!;
    expect(a.deferrals).toEqual({ count: 2, lastAt: new Date((T + 60) * 1000).toISOString() });
    expect(a.reject?.reason).toBe("hard-bounce");
    expect(a.spamAt).toBe(new Date((T + 62) * 1000).toISOString());
    expect(a.unsubAt).toBe(new Date((T + 63) * 1000).toISOString());
  });
});

describe("scrubbing", () => {
  it("drops everything but origin and path, and replaces tokens", () => {
    expect(scrubLink("https://acme.test/a/0123456789abcdef0123/b?x=1#y")).toBe("https://acme.test/a/:token/b");
    expect(scrubLink("not a url")).toBe("");
    expect(scrubDiag("550 <a.b@c.test> unknown")).toBe("550 <address> unknown");
  });
});
