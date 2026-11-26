import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { numberKeys } from "@/lib/metrics/meanings";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import type { TenantContext } from "@/lib/tenant/types";
import { situationKey } from "@/lib/brandMap/keys";
import { forTenant } from "@/lib/tenant";
import { monitorCompetitor } from "@/lib/competitors/store";
import { brandStrategyDocId } from "@/lib/types/brandStrategy";
import { agentBrandStrategy } from "./agentApi";
import { freshCheck } from "./checkRules";
import { approveStrategy, saveFound, saveProposal, saveStrategyDraft } from "./store";

const A: TenantContext = { tenantId: "ten_A", region: "us", source: "agent", userId: "usr_a", role: "admin" };
const T0 = Date.parse("2026-11-25T10:00:00.000Z");
const at = (ms: number) => ({ now: () => new Date(ms) });

beforeEach(() => {
  vi.stubEnv("BRAND_MAP_ENABLED", "true");
  vi.stubEnv("BRAND_STRATEGY_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

async function approved(db: FakeFirestore) {
  const text = "A client asks why a rival is named";
  await brandMapRecords(A, db).create("sit", "sit_aaaaaa01", { status: "decided", from: "person", text, textKey: situationKey(text), rev: 0, order: 0, counts: { questions: 12, answered: 1 }, createdAt: "", updatedAt: "" });
  await saveFound(A, { mode: "quick", found: [{ name: "Rivalco", site: "rivalco.example", foundTimes: 1, evidence: [{ title: "Rivalco", domain: "rivalco.example" }], ticked: false, from: "finder", group: "most" }] }, { db, ...at(T0) });
  const p = await saveProposal(
    A,
    {
      focusSituationIds: ["sit_aaaaaa01"],
      audiences: ["Marketing teams"],
      claims: [
        { id: "cl_aaaaaa01", side: "you", text: "Tracks 8 AI engines", competitor: null, proof: { kind: "product", url: "https://acme.example/docs", title: "Docs" }, proposed: "Tracks 8 AI engines" },
        { id: "cl_aaaaaa02", side: "you", text: "Cheapest for a solo founder", competitor: null, proof: null, proposed: "Cheapest for a solo founder" },
      ],
      isNotProposals: [],
      goal: { text: "200 sign-ups by March", measure: "sign-ups", measureKey: null, from: "onboarding", setAt: "2026-11-25T10:00:00.000Z" },
      watched: [],
      sources: ["identity"],
      made: { promptId: "brand.strategy_propose", version: 1, model: "test-model" },
    },
    { db, ...at(T0 + 1000) },
  );
  return approveStrategy(A, { baseRev: p.ok ? p.value.rev : 0 }, { db, ...at(T0 + 2000) });
}

describe("Vizzy's get_brand_strategy", () => {
  it("gives the approved strategy with a meaning for every number, and says a gap is never a fact", async () => {
    const db = new FakeFirestore();
    await approved(db);
    const r = await agentBrandStrategy(A, { db, ...at(T0 + 3000) });
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown> & { meanings: Record<string, unknown>; claims: Array<{ shownAs: string; proof: unknown }>; focus: unknown[]; askGoal: boolean; note: string };
    const keys = [...numberKeys(body)].filter((k) => k !== "meanings");
    expect(keys.sort()).toEqual(["focusLiveArticles", "focusQuestions", "foundTimes"]);
    for (const k of keys) expect(body.meanings[k], `"${k}" is not explained`).toBeTruthy();
    expect(body.focus).toEqual([{ situation: "A client asks why a rival is named", focusQuestions: 12, focusLiveArticles: 1 }]);
    expect(body.claims.map((c) => c.shownAs)).toEqual(["docs", "gap"]);
    expect(body.askGoal).toBe(false);
    expect(body.note).toContain("never a fact");
    expect(body).not.toHaveProperty("decisions");
  });

  it("asks about the goal once it is a quarter old, and says when a draft waits or nothing is approved", async () => {
    const db = new FakeFirestore();
    expect((await agentBrandStrategy(A, { db })).body).toMatchObject({ approved: null, draftWaiting: false });
    const done = await approved(db);
    expect(((await agentBrandStrategy(A, { db, ...at(T0 + 91 * 86_400_000) })).body as { askGoal: boolean }).askGoal).toBe(true);
    await saveStrategyDraft(A, { baseRev: done.ok ? done.value.rev : 0, audiences: ["Agencies"] }, { db, ...at(T0 + 4000) });
    expect(((await agentBrandStrategy(A, { db })).body as { changedSinceApproved: boolean }).changedSinceApproved).toBe(true);
    // Another brand reads nothing of it.
    expect((await agentBrandStrategy({ ...A, tenantId: "ten_B" }, { db })).body).toMatchObject({ approved: null });
  });
});

describe("Vizzy's get_brand_strategy with the weekly check (STRATEGY_CHECK_ENABLED)", () => {
  const CHECK_SWITCHES = ["COMPETITORS_ENABLED", "COMPETITOR_ARTICLES_ENABLED", "STRATEGY_COMPETITORS_ENABLED", "STRATEGY_CHECK_ENABLED"];

  async function withCheck(db: FakeFirestore) {
    await approved(db);
    // Watched after approving: the live list has it, the approved copy doesn't.
    const peer = await monitorCompetitor(A, { website: "peerly.example", name: "Peerly" }, { db });
    if (!peer.ok) throw new Error(peer.error);
    const check = {
      ...freshCheck(new Date(T0 + 2000).toISOString(), null),
      lookedAt: "2026-11-26T12:00:00.000Z",
      focus: [{ id: "sit_aaaaaa01", text: "A client asks why a rival is named", they: 5, newSince: 3, by: [{ name: "Peerly", count: 5 }], questions: 12, answered: 1, flag: "crowded" as const }],
      named: [{ name: "Bigsuite", count: 4 }],
      open: { key: "chk_abc123", raisedAt: "2026-11-26T12:00:00.000Z", reasons: [{ kind: "new_articles" as const, ref: "sit_aaaaaa01", text: "A client asks why a rival is named", count: 3, by: [{ name: "Peerly", count: 3 }] }], actedAt: null },
    };
    await forTenant(A, db).brandStrategy.claim(brandStrategyDocId(A.tenantId), () => ({ check }));
  }

  it("lists the competitors live and gives what the check saw, with a meaning for every number", async () => {
    const db = new FakeFirestore();
    for (const k of CHECK_SWITCHES) vi.stubEnv(k, "true");
    await withCheck(db);
    const body = (await agentBrandStrategy(A, { db, ...at(Date.parse("2026-11-26T13:00:00.000Z")) })).body as Record<string, unknown> & { meanings: Record<string, unknown>; competitors: Array<{ name: string; group: string; monitored: boolean }> };
    expect(body.competitors.map((c) => [c.name, c.group, c.monitored])).toEqual([
      ["Peerly", "Not grouped yet", true],
      ["Rivalco", "Does most of what you do", false],
    ]);
    expect(body.againstCompetitors).toMatchObject({
      lookedAt: "2026-11-26T12:00:00.000Z",
      countedSince: "2026-11-25",
      focus: [{ situation: "A client asks why a rival is named", theirArticles: 5, theirNewArticles: 3, byCompetitor: [{ name: "Peerly", competitorArticles: 5 }], focusQuestions: 12, focusLiveArticles: 1, label: "crowded: a new angle stands out" }],
      namedNotWatched: [{ name: "Bigsuite", namingArticles: 4 }],
      waitingInReview: ['Peerly wrote 3 new articles on "A client asks why a rival is named" since 25 Nov.'],
    });
    const keys = [...numberKeys(body)].filter((k) => k !== "meanings");
    for (const k of keys) expect(body.meanings[k], `"${k}" is not explained`).toBeTruthy();
    expect(keys.sort()).toEqual(["competitorArticles", "focusLiveArticles", "focusQuestions", "foundTimes", "namingArticles", "theirArticles", "theirNewArticles"]);
  });

  it("says when the check hasn't looked yet, and is as before with the switch off", async () => {
    const db = new FakeFirestore();
    for (const k of CHECK_SWITCHES) vi.stubEnv(k, "true");
    await approved(db);
    expect((await agentBrandStrategy(A, { db })).body).toMatchObject({ againstCompetitors: { lookedAt: null } });
    await withCheck(new FakeFirestore());
    vi.stubEnv("STRATEGY_CHECK_ENABLED", "false");
    const off = (await agentBrandStrategy(A, { db })).body as Record<string, unknown> & { competitors: Array<{ name: string }> };
    expect(off).not.toHaveProperty("againstCompetitors");
    expect(off.competitors.map((c) => c.name)).toEqual(["Rivalco"]);
  });
});
