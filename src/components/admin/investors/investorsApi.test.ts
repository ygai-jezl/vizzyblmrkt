import { afterEach, describe, expect, it, vi } from "vitest";
import { BOARD_WORDS, REVIEW_WORDS, SETUP_WORDS } from "@/lib/raise/pipeline/words";
import { boardErrorText, decideFollowUp, followUpErrorText, moveCard, pressSetup, setupErrorText, setupPreview } from "./investorsApi";

describe("the board's calls", () => {
  afterEach(() => vi.unstubAllGlobals());

  function capture() {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    return calls;
  }

  it("send only what each route takes, never a brand", async () => {
    const calls = capture();
    await moveCard({ personId: "ct_sam", to: "opt_passed01", from: "opt_contact1", reason: null });
    await setupPreview("funding", "GBP");
    await setupPreview();
    await pressSetup("raising", "EUR");
    await decideFollowUp("aac_0001", "dismiss", 2);
    expect(calls.map((c) => c.url)).toEqual([
      "/api/admin/raise/pipeline/move",
      "/api/admin/raise/pipeline/setup?kit=funding&currency=GBP",
      "/api/admin/raise/pipeline/setup",
      "/api/admin/raise/pipeline/setup",
      "/api/admin/raise/pipeline/follow-ups/aac_0001",
    ]);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ personId: "ct_sam", to: "opt_passed01", from: "opt_contact1", reason: null });
    expect(JSON.parse(String(calls[3]!.init.body))).toEqual({ kit: "raising", currency: "EUR" });
    expect(JSON.parse(String(calls[4]!.init.body))).toEqual({ op: "dismiss", rev: 2 });
  });

  it("turn each error into its words, and anything else into Try again", () => {
    expect(boardErrorText({ error: "stale" })).toBe(BOARD_WORDS.errors.stale);
    expect(boardErrorText({ error: "not_set_up" })).toBe(BOARD_WORDS.errors.not_set_up);
    expect(boardErrorText({ error: "rate_limited" })).toBe(BOARD_WORDS.errors.rate_limited);
    expect(boardErrorText({ error: "network" })).toBe(BOARD_WORDS.errors.other);
    expect(boardErrorText(null)).toBe(BOARD_WORDS.errors.other);
    expect(setupErrorText({ error: "field_list_full" })).toBe(SETUP_WORDS.errors.field_list_full);
    expect(setupErrorText({ error: "fields_changed" })).toBe(SETUP_WORDS.errors.fields_changed);
    expect(setupErrorText({ error: "forbidden" })).toBe(SETUP_WORDS.errors.forbidden);
    expect(setupErrorText({ error: "invalid_field" })).toBe(SETUP_WORDS.errors.other);
    expect(followUpErrorText({ error: "stale" })).toBe(REVIEW_WORDS.errors.stale);
    expect(followUpErrorText({ error: "not_found" })).toBe(REVIEW_WORDS.errors.stale);
    expect(followUpErrorText({ error: "rate_limited" })).toBe(REVIEW_WORDS.errors.other);
  });
});
