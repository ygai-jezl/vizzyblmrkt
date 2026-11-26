import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LearnedCardView, LookRowView } from "@/lib/loops/learnedView";
import * as W from "@/lib/loops/learnedWords";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const { WhatItLearnedCard, ForgetDialog, HistoryList, bindDialogKeys } = await import("./WhatItLearnedCard");
const { VoteWhy, whyShows, opensByItself } = await import("./VoteWhy");
const { HowThisWasMade, ImageDetailModal } = await import("./ImageDetailModal");
const { ImageStyleCard } = await import("./ImageStyleCard");
const { GoBackRowView } = await import("@/components/admin/review/GoBackRow");
const { LearningSettingCard } = await import("@/components/admin/settings/LearningSettingCard");

/**
 * Step 4's screens as they render (the plan for steps 4 and 5, section 6), from views made by hand
 * in the canvas's words: What it learned (screen 1), the why behind a vote (1b and 2), How this was
 * made (2), Review's Go back card (3) and the learning setting (5).
 */

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el).replace(/&#x27;/g, "'").replace(/&quot;/g, '"');

const row = (o: Partial<LookRowView>): LookRowView => ({
  scope: "image_style.natural_photo",
  name: "Natural photo",
  isBrand: false,
  styleId: "natural_photo",
  v: 1,
  hasLook: true,
  words: "Overhead daylight, flour dusted on dark wood, loaves close up, warm and soft, no people.",
  setBy: "learned",
  status: "Learned 14 Jan",
  tag: null,
  pending: null,
  from: "From 3 images you liked and 2 you didn't (Wrong mood or style 2), newest 14 Jan",
  thumbs: [{ id: "e1", url: "/api/admin/workspace/ws_h/asset/e1.png", alt: "A loaf" }],
  lines: ["Made 0 with it so far."],
  check: null,
  checkRead: false,
  goBack: null,
  notice: false,
  history: [],
  holdable: true,
  undo: { wasPerson: false },
  firstLookCheck: null,
  counts: { made: 0, voted: 0, liked: 0, remade: 0 },
  adoptedAt: "2027-01-14T09:00:00.000Z",
  keptAt: null,
  ...o,
});

const card = (o: Partial<LearnedCardView> = {}): LearnedCardView => ({
  role: "admin",
  lead: W.CARD_LEAD,
  chip: { text: "Learning", tone: "green" },
  paused: false,
  canMenu: true,
  notes: [],
  empty: null,
  rows: [
    row({}),
    row({
      scope: "image_style.product_still_life",
      name: "Product still life",
      styleId: "product_still_life",
      v: 0,
      hasLook: false,
      words: null,
      status: "No look of its own yet",
      pending: { have: 1, text: "1 of the 3 likes it needs. Uses your brand's look meanwhile." },
      from: null,
      thumbs: [],
      lines: [],
    }),
  ],
  footer: [
    { text: W.FOOT_HOLDBACK, link: { label: "How this works", href: "/help/what-yougrow-learned#holdback" } },
    { text: W.FOOT_SETTING, link: { label: W.HELP_CHECK, href: "/admin/account/settings#learning" } },
  ],
  member: null,
  brandLook: true,
  usingBrand: ["Product still life"],
  ...o,
});

describe("What it learned (screen 1)", () => {
  it("shows each row's words, where it came from, its counts, and Undo for an admin", () => {
    const out = html(createElement(WhatItLearnedCard, { initial: card() }));
    expect(out).toContain("What it learned");
    expect(out).toContain(">Learning<");
    expect(out).toContain("“Overhead daylight, flour dusted on dark wood, loaves close up, warm and soft, no people.”");
    expect(out).toContain("From 3 images you liked and 2 you didn't (Wrong mood or style 2), newest 14 Jan");
    expect(out).toContain("Made 0 with it so far.");
    expect(out).toContain("1 of the 3 likes it needs. Uses your brand's look meanwhile.");
    expect(out).toContain("> Undo<");
    expect(out).toContain('aria-label="More for What it learned"');
    expect(out).toContain('href="/help/what-yougrow-learned#holdback"');
    expect(out).toContain(">Help check that learning works</a>");
  });

  it("offers no Undo on a row whose look before was forgotten, since it could never act", () => {
    const out = html(createElement(WhatItLearnedCard, { initial: card({ rows: [row({ undo: null })] }) }));
    expect(out).not.toContain("> Undo<");
    expect(out).toContain('aria-label="More for Natural photo"');
  });

  it("gives a member no actions, and says why", () => {
    const out = html(createElement(WhatItLearnedCard, { initial: card({ role: "member", canMenu: false, member: W.MEMBER_LINE, footer: [] }) }));
    expect(out).not.toContain("> Undo<");
    expect(out).not.toContain("More for");
    expect(out).toContain(W.MEMBER_LINE);
  });

  it("shows the notes, the empty card, a waiting Go back card and a worse read's own Go back and Keep", () => {
    const empty = html(createElement(WhatItLearnedCard, { initial: card({ rows: [], empty: W.EMPTY_CARD, notes: [{ id: "paused", text: W.pausedNote("2027-05-03T09:00:00.000Z"), tone: "plain", action: "resume" }] }) }));
    expect(empty).toContain(W.EMPTY_CARD);
    expect(empty).toContain("Paused on 3 May. What it learned is still used; nothing new is learned until you resume.");
    expect(empty).toContain(">Resume<");
    const goBack = html(
      createElement(WhatItLearnedCard, {
        initial: card({
          rows: [row({ tag: W.NOT_LEARNING_WHILE_OPEN, check: { text: "Your images were remade more since 9 Mar: 20 of 40 against 4 of 40 before.", tone: "bad" }, goBack: { text: W.goBackWaiting(3), href: "/admin/approvals#learned" } })],
        }),
      }),
    );
    expect(goBack).toContain("Not learning while this is open");
    expect(goBack).toContain("Go back to version 3? It's waiting in Review.");
    expect(goBack).toContain(">Open in Review</a>");
    const notice = html(createElement(WhatItLearnedCard, { initial: card({ rows: [row({ notice: true, check: { text: "Liked less often since 9 Mar: 12 of 40 against 30 of 40 before. Go back to the earlier look?", tone: "bad" } })] }) }));
    expect(notice).toContain(">Go back<");
    expect(notice).toContain(">Keep this look<");
  });
});

describe("Forget's confirm and History (screen 1, states h and g)", () => {
  it("is a labelled modal dialog with Cancel and Forget", () => {
    const c = W.forgetConfirm({ scope: "image_style.natural_photo", liked: 3, disliked: 1, brandOverlap: 2 });
    const out = html(createElement(ForgetDialog, { ...c, alsoBrand: false, busy: false, returnTo: null, onAlso: () => {}, onCancel: () => {}, onConfirm: () => {} }));
    expect(out).toContain('role="dialog"');
    expect(out).toContain('aria-modal="true"');
    expect(out).toContain('aria-labelledby="forget-h"');
    expect(out).toContain('aria-describedby="forget-body"');
    expect(out).toContain(">Cancel</button>");
    expect(out).toContain(">Forget</button>");
  });

  it("closes on Escape wherever focus is, and lets go of the keys once closed", () => {
    const doc = new EventTarget();
    const close = vi.fn();
    const key = (k: string) => {
      const e = new Event("keydown", { cancelable: true });
      Object.assign(e, { key: k });
      doc.dispatchEvent(e);
      return e;
    };
    const unbind = bindDialogKeys(doc, { close });
    key("Enter");
    expect(close).not.toHaveBeenCalled();
    expect(key("Escape").defaultPrevented).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    unbind();
    key("Escape");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps History's heading and Hide out of its list, which holds only the version lines", () => {
    const out = html(
      createElement(HistoryList, {
        name: "Natural photo",
        history: [
          { v: 2, text: "Version 2, 9 Mar, learned from 20 images you liked and 8 you didn't. In use.", now: true },
          { v: 1, text: "Version 1, 2 Jan, carried over. Can't be checked: nothing came before it.", now: false },
        ],
        onHide: () => {},
      }),
    );
    expect(out).not.toContain('role="list"');
    const list = out.slice(out.indexOf("<ul"), out.indexOf("</ul>"));
    expect(list).toContain('aria-label="History of Natural photo"');
    expect(list.match(/<li/g)).toHaveLength(2);
    expect(list).not.toContain("Hide");
    expect(out.indexOf(">Hide</button>")).toBeLessThan(out.indexOf("<ul"));
  });
});

describe("the why behind a vote (screens 1b and 2)", () => {
  it("opens What's off? by itself only after a thumbs down just given, and never after a thumbs up", () => {
    expect(opensByItself({ vote: "down", justVoted: true, startClosed: false, hadReason: false })).toBe(true);
    expect(opensByItself({ vote: "down", justVoted: true, startClosed: true, hadReason: false })).toBe(false);
    expect(opensByItself({ vote: "down", justVoted: false, startClosed: false, hadReason: false })).toBe(false);
    expect(opensByItself({ vote: "up", justVoted: true, startClosed: false, hadReason: false })).toBe(false);
    // Never twice for one image.
    expect(opensByItself({ vote: "down", justVoted: true, startClosed: false, hadReason: false, asked: true })).toBe(false);
  });

  it("shows the link, the row, the saved reason or the done line, one at a time", () => {
    expect(whyShows({ vote: "up", open: false, reason: null, done: false })).toEqual({ link: true, row: false, saved: false, done: false });
    expect(whyShows({ vote: "down", open: true, reason: "mood", done: false })).toEqual({ link: false, row: true, saved: false, done: false });
    expect(whyShows({ vote: "down", open: false, reason: "mood", done: false })).toEqual({ link: false, row: false, saved: true, done: false });
    expect(whyShows({ vote: "down", open: false, reason: "mood", done: true })).toEqual({ link: false, row: false, saved: false, done: true });
    expect(whyShows({ vote: null, open: true, reason: null, done: false })).toEqual({ link: false, row: false, saved: false, done: false });
  });

  it("renders What's off? with its chips after a thumbs down, and a saved reason with its note", () => {
    const open = html(createElement(VoteWhy, { assetId: "d1", vote: "down", reason: null, note: null, scope: "image_style.natural_photo", startClosed: false, justVoted: true }));
    expect(open).toContain("What's off?");
    for (const label of ["Wrong colours", "Wrong mood or style", "Wrong subject", "Looks fake", "Text or details wrong", "Not us", "Something else"]) expect(open).toContain(`>${label}</button>`);
    const closed = html(createElement(VoteWhy, { assetId: "d1", vote: "down", reason: null, note: null, scope: null, startClosed: true, justVoted: true }));
    expect(closed).toContain(">Say what's off</button>");
    const up = html(createElement(VoteWhy, { assetId: "u1", vote: "up", reason: null, note: null, scope: null, startClosed: false, justVoted: true }));
    expect(up).toContain(">Say what works</button>");
    const saved = html(createElement(VoteWhy, { assetId: "d1", vote: "down", reason: "mood", note: "too dark for a bakery window", scope: null, startClosed: false, justVoted: false }));
    expect(saved).toContain("What's off:");
    expect(saved).toContain("Wrong mood or style");
    expect(saved).toContain("Note: too dark for a bakery window");
  });

  it("shows How this was made after a vote, and keeps it under a closed button before one", () => {
    const after = html(createElement(HowThisWasMade, { line: "Made with the Natural photo look, version 1", voted: true }));
    expect(after).toContain("How this was made");
    expect(after).toContain("Made with the Natural photo look, version 1");
    const before = html(createElement(HowThisWasMade, { line: "Made without what it learned, as about 1 in 20 images are.", voted: false }));
    expect(before).toContain('aria-expanded="false"');
    expect(before).not.toContain("Made without what it learned");
  });

  it("leaves the image details as they were until versions are known to be on", () => {
    const asset = { id: "n1", tenantId: "ten_hearth", workspaceId: "ws_h", filename: "n1.png", mimeType: "image/png", kind: "social", createdAt: "2027-01-16T09:12:00.000Z", brandVote: "up" } as never;
    const out = html(createElement(ImageDetailModal, { asset, onClose: () => {}, onCustomized: () => {}, onFeedback: () => {} }));
    expect(out).not.toContain("How this was made");
    expect(out).not.toContain("Say what works");
  });
});

describe("Review's Go back card (screen 3)", () => {
  const item = {
    id: "aa_1",
    kind: "learned" as const,
    title: "Go back to the earlier Illustration look?",
    detail: "",
    href: "/admin/brand-kit/image-style#learned",
    action: "Review",
    details: ["Your images were remade more since 9 Mar: 20 of 40 against 4 of 40 before.", "Not adjusted for season.", "The newer look came from 20 images you liked and 8 you didn't, newest 8 Mar."],
    goBack: { cardId: "aa_1", scope: "image_style.illustration", to: 3 },
  };
  const view = (o: Partial<Parameters<typeof GoBackRowView>[0]> = {}) => html(createElement(GoBackRowView, { item, busy: null, error: null, done: null, onSend: () => {}, onUndo: () => {}, ...o }));

  it("shows the card's lines with Go back and Keep this look", () => {
    const out = view();
    for (const line of item.details) expect(out).toContain(line);
    expect(out).toContain(">Go back<");
    expect(out).toContain(">Keep this look<");
  });

  it("says what was done, with Undo after Go back", () => {
    const back = view({ done: { text: W.backToLine(3, "2027-02-04T09:00:00.000Z"), undo: true } });
    expect(back).toContain("Back to version 3 from 4 Feb.");
    expect(back).toContain(">Undo<");
    const kept = view({ done: { text: W.KEPT_DONE, undo: false } });
    expect(kept).toContain("Kept. YouGrow only asks again if a later check reads worse.");
    expect(kept).not.toContain(">Undo<");
  });

  it("after Go back and then Undo, says so with a link to What it learned, and never draws the answered card again", () => {
    const undone = view({ done: { text: W.GO_BACK_UNDONE, undo: false, href: item.href } });
    expect(undone).toContain("Undone. The newer look is back in use.");
    expect(undone).toContain('href="/admin/brand-kit/image-style#learned"');
    expect(undone).toContain(">Open What it learned</a>");
    expect(undone).not.toContain(">Go back<");
    expect(undone).not.toContain(">Keep this look<");
  });
});

describe("the learning setting (screen 5) and the Image style card", () => {
  it("is on by default with step 4's words, says since when it is off, and is read only for a member", () => {
    const on = html(createElement(LearningSettingCard, { isAdmin: true, offSince: null }));
    expect(on).toContain("Help check that learning works");
    expect(on).toContain(W.LEARNING_SETTING.words);
    expect(on).toContain("checked");
    const off = html(createElement(LearningSettingCard, { isAdmin: true, offSince: "2027-06-03T09:00:00.000Z" }));
    expect(off).toContain("Off since 3 Jun. Every image is made with what YouGrow learned.");
    const member = html(createElement(LearningSettingCard, { isAdmin: false, offSince: null }));
    expect(member).toContain("Only admins can change it.");
    expect(member).toContain("disabled");
  });

  it("gives the selected tile's small text a darker grey, for contrast on its blue", () => {
    const out = html(createElement(ImageStyleCard, { initial: { defaultStyleId: "natural_photo" }, suggestion: null, palette: [], canEdit: true, versions: true }));
    const selected = out.slice(out.indexOf('aria-pressed="true"'));
    expect(selected.slice(0, 1200)).toContain("text-neutral-600");
    // In dark mode the number reads lighter, as the engine line does, never neutral-600 on the dark blue.
    const number = selected.slice(selected.indexOf("font-mono"), selected.indexOf("font-mono") + 120);
    expect(number).toContain("dark:text-neutral-400");
  });
});
