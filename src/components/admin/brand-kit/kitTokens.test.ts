import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { TenantContext } from "@/lib/tenant/types";
import { handBack, keptFromTokens } from "@/lib/loops/handBack";
import { learnedFor } from "@/lib/loops/read";
import { sumWeek } from "@/lib/loops/testing/sumWeek";
import { NO_KIT_TOKENS, handUpGroupToken, kitReplaced, kitTokensToSend, withColourToken, type KitTokens } from "./kitTokens";

/**
 * The brand kit pages send each stamp token with at most one save, and only while what it stamps
 * is still in what the save holds (learning loops step 5, decision 20), so a save counts kept once
 * per stamp. The pages' clicks are replayed through the same helpers they call.
 */

const hearth: TenantContext = { tenantId: "ten_hearth", region: "eu", source: "idtoken" };
const NOW = new Date("2027-01-15T10:00:00.000Z");
const COLOURS = [{ hex: "#8a5a2b", name: "Crust" }, { hex: "#f3e6cf", name: "Flour" }];

beforeEach(() => vi.stubEnv("LOOPS_ENABLED", "true"));
afterEach(() => vi.unstubAllEnvs());

/** A colours route run: made counts once and the tray group holds the token it hands back. */
async function colourExtract(db: FakeFirestore, now = NOW) {
  const { stamp } = await learnedFor(hearth, "brand_kit", {}, { now });
  const stampToken = (await handBack(hearth, "brand_kit", stamp, { db, now }))!;
  expect(stampToken).toEqual(expect.any(String));
  return { source: "website" as const, label: "Website", colors: COLOURS, stampToken };
}

describe("brand kit stamp tokens", () => {
  it("one colour extract, a save, a second → palette from the same tray and a second save count kept once", async () => {
    const db = new FakeFirestore();
    let group: { stampToken?: string; colors: typeof COLOURS } = await colourExtract(db);
    let tokens: KitTokens = NO_KIT_TOKENS;
    let palette: Array<{ hex: string; name?: string }> = [];
    // "→ palette" does what addFromTray does: the colours go in, the token goes up and the group drops it.
    const toPalette = () => {
      palette = [...palette, ...group.colors];
      const token = group.stampToken;
      if (!token) return;
      tokens = withColourToken(tokens, token, { hexes: group.colors.map((c) => c.hex) });
      group = handUpGroupToken(group, token);
    };
    const save = async () => {
      await keptFromTokens(hearth, ["brand_kit"], kitTokensToSend(tokens, { palette }), { db, now: NOW });
      tokens = NO_KIT_TOKENS;
    };

    toPalette();
    await save();
    toPalette();
    await save();

    const week = sumWeek(db, hearth.tenantId, "2027-W02") as { c?: { brand_kit?: { brand_kit?: { v0?: { none?: unknown } } } } };
    expect(week.c?.brand_kit?.brand_kit?.v0?.none).toEqual({ made: 1, kept: 1 });
    expect(group.colors).toEqual(COLOURS);
  });

  it("sends a colour token once however often it is kept, and drops it when an extract or the stored kit replaces its colours", () => {
    let tokens = withColourToken(kitReplaced(), "tok_website", { hexes: ["#8A5A2B"] });
    tokens = withColourToken(tokens, "tok_website", { hexes: ["#f3e6cf"] });
    tokens = withColourToken(tokens, "tok_logo", { groupId: "grp_logo" });
    const kit = { palette: COLOURS, palettes: [{ id: "grp_logo", name: "Logo", colors: COLOURS }] };
    expect(kitTokensToSend(tokens, kit)).toEqual(["tok_website", "tok_logo"]);
    // An extract sends no token of its own: its route stores the kit and counts it kept there.
    expect(kitTokensToSend(kitReplaced(), kit)).toEqual([]);
  });

  it("sends a token only while what it stamps is still in the save: a kept palette removed, or its colours taken out, counts kept 0", async () => {
    const db = new FakeFirestore();
    const kept = await colourExtract(db);
    const added = { ...(await colourExtract(db, new Date(NOW.getTime() + 60_000))), source: "logo" as const };
    expect(added.stampToken).not.toBe(kept.stampToken);
    // Keep as palette, then Remove palette; → palette, then each colour's remove.
    let tokens = withColourToken(NO_KIT_TOKENS, kept.stampToken, { groupId: "grp_website" });
    tokens = withColourToken(tokens, added.stampToken, { hexes: added.colors.map((c) => c.hex) });
    const kit = { palette: [{ hex: "#000000", name: "Ink" }], palettes: [] };
    expect(kitTokensToSend(tokens, kit)).toEqual([]);
    await keptFromTokens(hearth, ["brand_kit"], kitTokensToSend(tokens, kit), { db, now: NOW });
    const week = sumWeek(db, hearth.tenantId, "2027-W02") as { c?: { brand_kit?: { brand_kit?: { v0?: { none?: unknown } } } } };
    expect(week.c?.brand_kit?.brand_kit?.v0?.none).toEqual({ made: 2 });
    // A kept palette emptied of colours sends nothing either; one colour still there is enough.
    expect(kitTokensToSend(tokens, { palettes: [{ id: "grp_website", name: "Website", colors: [] }] })).toEqual([]);
    expect(kitTokensToSend(tokens, { palette: [{ hex: "#F3E6CF" }] })).toEqual([added.stampToken]);
  });

  it("a group run again since keeps its new token", () => {
    expect(handUpGroupToken({ stampToken: "tok_new" }, "tok_old")).toEqual({ stampToken: "tok_new" });
    expect(handUpGroupToken({ stampToken: "tok_old", label: "Logo" }, "tok_old")).toEqual({ label: "Logo" });
  });
});
