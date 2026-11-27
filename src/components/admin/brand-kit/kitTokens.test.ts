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
async function colourExtract(db: FakeFirestore) {
  const { stamp } = await learnedFor(hearth, "brand_kit", {}, { now: NOW });
  const stampToken = (await handBack(hearth, "brand_kit", stamp, { db, now: NOW }))!;
  expect(stampToken).toEqual(expect.any(String));
  return { source: "website" as const, label: "Website", colors: COLOURS, stampToken };
}

describe("brand kit stamp tokens", () => {
  it("one colour extract, a save, a second → palette from the same tray and a second save count kept once", async () => {
    const db = new FakeFirestore();
    let group: { stampToken?: string; colors: typeof COLOURS } = await colourExtract(db);
    let tokens: KitTokens = NO_KIT_TOKENS;
    // "→ palette" does what addFromTray does: the token goes up and the group drops it.
    const toPalette = () => {
      const token = group.stampToken;
      if (!token) return;
      tokens = withColourToken(tokens, token);
      group = handUpGroupToken(group, token);
    };
    const save = async () => {
      await keptFromTokens(hearth, ["brand_kit"], kitTokensToSend(tokens), { db, now: NOW });
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

  it("a new extract replaces the one before, and drops colour tokens whose colours it replaced", () => {
    let tokens = kitReplaced("tok_extract_1");
    tokens = withColourToken(tokens, "tok_website");
    tokens = withColourToken(tokens, "tok_website");
    expect(kitTokensToSend(tokens)).toEqual(["tok_extract_1", "tok_website"]);
    tokens = kitReplaced("tok_extract_2");
    expect(kitTokensToSend(tokens)).toEqual(["tok_extract_2"]);
    // The stored kit loading replaces everything, an extract's too.
    expect(kitTokensToSend(kitReplaced(null))).toEqual([]);
  });

  it("a group run again since keeps its new token", () => {
    expect(handUpGroupToken({ stampToken: "tok_new" }, "tok_old")).toEqual({ stampToken: "tok_new" });
    expect(handUpGroupToken({ stampToken: "tok_old", label: "Logo" }, "tok_old")).toEqual({ label: "Logo" });
  });
});
