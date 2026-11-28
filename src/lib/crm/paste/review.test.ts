import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { ctx, seedWorld, TENANT_ID } from "@/lib/lifecycle/testing/fixtures";
import { loadReview, REVIEW_ORDER, REVIEW_SECTIONS, resetReviewCountCache } from "@/lib/review/summary";
import { readPaste } from "./batch";
import { pasteBatchItems, pasteHref } from "./review";
import { DONE_WHEN_TSV } from "./testing/samples";

const SWITCHES = [
  "AUDIENCE_PERSON_LINKS_ENABLED",
  "AUDIENCE_ONE_VIEW_ENABLED",
  "ONTOLOGY_PERSON_IDS_ENABLED",
  "AUDIENCE_ADD_PERSON_ENABLED",
  "NEXT_PUBLIC_NAV_V2_ENABLED",
  "NEXT_PUBLIC_NAV_V2_PHASE2_ENABLED",
  "NEXT_PUBLIC_NAV_V2_PHASE3_ENABLED",
  "RAISE_PASTE_ENABLED",
];
const member = { ...ctx, userId: "usr_2", role: "member" as const };

beforeEach(() => {
  for (const s of SWITCHES) vi.stubEnv(s, "true");
  resetReviewCountCache();
});
afterEach(() => vi.unstubAllEnvs());

async function waiting() {
  const db = new FakeFirestore();
  seedWorld(db);
  const r = await readPaste(ctx, { text: DONE_WHEN_TSV, source: "Our advisers' sheet", from: "box" }, { db });
  if (!r.ok || r.outcome !== "ready") throw new Error("not ready");
  return { db, id: r.batch.id };
}

describe("pasted lists in Review", () => {
  it("is one item per waiting list, with counts and the admin's own words only", async () => {
    const { db, id } = await waiting();
    const items = await pasteBatchItems(ctx, db);
    expect(items).toEqual([
      {
        id: `aa:${id}`,
        kind: "paste_batch",
        title: "A pasted list, ready to add",
        detail: "10 people and 3 companies. Where it's from: Our advisers' sheet. It goes after 7 days.",
        href: pasteHref(id),
        action: "Open",
      },
    ]);
    // No name or address from the rows in either.
    const words = `${items[0]!.title} ${items[0]!.detail}`;
    for (const cell of ["Jo", "Example", "@", "northfield", "meadow-seed.test", "Meadow Seed Fund"]) expect(words, cell).not.toContain(cell);
  });

  it("shows for admins with the switch on, never for members, nor with the switch off", async () => {
    const { db, id } = await waiting();
    const admin = (await loadReview(ctx, { lifecycle: false, includeContent: false }, db)).items.filter((i) => i.kind === "paste_batch");
    expect(admin.map((i) => i.id)).toEqual([`aa:${id}`]);
    expect((await loadReview(member, { lifecycle: false, includeContent: false }, db)).items.filter((i) => i.kind === "paste_batch")).toEqual([]);
    vi.stubEnv("RAISE_PASTE_ENABLED", "false");
    expect((await loadReview(ctx, { lifecycle: false, includeContent: false }, db)).items.filter((i) => i.kind === "paste_batch")).toEqual([]);
  });

  it("leaves out another brand's lists", async () => {
    const { db } = await waiting();
    expect(await pasteBatchItems({ ...ctx, tenantId: "ten_other" }, db)).toEqual([]);
    expect(TENANT_ID).not.toBe("ten_other");
  });

  it("has its own section, after suggestions about people and the board's follow-ups, about the pasted columns rule", () => {
    expect(REVIEW_SECTIONS.paste_batch).toEqual({
      title: "Pasted lists",
      description: "Lists your team pasted on People, waiting for an admin to add them. Nobody is added until then.",
      from: ["paste_columns"],
    });
    // After suggestions about people and the board's follow-ups (S2a).
    expect(REVIEW_ORDER.indexOf("paste_batch")).toBe(REVIEW_ORDER.indexOf("raise_followup") + 1);
  });
});
