import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import { updateTenantConfig } from "@/lib/tenant/control";
import type { FirestoreLike } from "@/lib/tenant/types";
import { publishLifecycleJourney, saveLifecycleDraft } from "@/lib/lifecycle/service";
import { T0, TENANT_ID, ctx, publishOnboarding, seedWorld, system } from "@/lib/lifecycle/testing/fixtures";
import type { TranslateInput, TranslateResult } from "./translate";
import { runTranslations } from "./translationsTick";

/**
 * The translations lane (ASSET_TRANSLATIONS_ENABLED): a publish marks the journey and the brand,
 * the lane queues each changed email in each language with enough readers, makes a few a run, and
 * clears the marks when nothing is left. The model is a stand-in.
 */

const fs = (db: FakeFirestore) => db as unknown as FirestoreLike;
const NOW = T0;

function on() {
  vi.stubEnv("ASSET_TRANSLATIONS_ENABLED", "true");
  vi.stubEnv("LANGUAGE_READERS_ENABLED", "true");
  vi.stubEnv("CONTENT_LANGUAGE_ENABLED", "true");
  vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
}
beforeEach(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllEnvs());

const french = vi.fn(
  async (input: TranslateInput): Promise<TranslateResult> => ({
    ok: true,
    tries: 1,
    fields: { subject: `FR ${input.words.subject}`, previewText: input.words.previewText ? `FR ${input.words.previewText}` : input.words.previewText, body: `FR ${input.words.body}` },
  }),
);

/** A brand in English and French, French with `frReaders` of 5 people, a threshold of 2. */
async function world(frReaders = 3) {
  const db = new FakeFirestore();
  seedWorld(db);
  await updateTenantConfig(
    TENANT_ID,
    {
      defaultLocale: "en",
      supportedLocales: ["en", "fr"],
      languageSettings: { minReaders: 2 },
      languageReaders: { at: new Date(NOW).toISOString(), list: ["en", "fr"], everyone: 5, counts: { fr: frReaders } },
    },
    fs(db),
  );
  const { journey, version } = await publishOnboarding(db, { nowMs: NOW - 60_000 });
  const repo = forTenant(system, db);
  const emails = version.pools.flatMap((p) => p.items).length;
  let now = NOW;
  const run = (translate = french) => runTranslations({ deadlineMs: now + 600_000 }, { db: fs(db), now: () => now, translate, log: () => {} });
  /** Runs until nothing is queued (each run makes a few). */
  const drain = async () => {
    for (let i = 0; i < 20; i += 1) {
      await run();
      if ((await repo.translations.find({ where: [["state", "==", "queued"]] })).length === 0) return;
      now += 120_000;
    }
  };
  return {
    db,
    journey,
    version,
    emails,
    repo,
    run,
    drain,
    tenant: async () => db.raw("tenants", TENANT_ID)!,
    setNow: (ms: number) => (now = ms),
    all: () => repo.translations.find({ where: [["journeyId", "==", journey.id]] }),
  };
}

describe("publishing a journey", () => {
  it("marks the journey and the brand while the switch is on, and translates nothing itself", async () => {
    on();
    const w = await world();
    expect((await w.repo.lifecycleJourneys.getById(w.journey.id))?.translationsDue).toBe(true);
    expect((await w.tenant()).translationsQueuedAt).toBeTruthy();
    expect(await w.all()).toEqual([]);
  });

  it("marks nothing while it is off", async () => {
    const w = await world();
    expect((await w.repo.lifecycleJourneys.getById(w.journey.id))?.translationsDue).toBeUndefined();
    expect((await w.tenant()).translationsQueuedAt).toBeUndefined();
  });
});

describe("the translations lane", () => {
  it("makes every email in French, a few a run, then clears both marks", async () => {
    on();
    const w = await world();
    french.mockClear();
    const first = await w.run();
    expect(first).toMatchObject({ brands: 1, planned: 1, queued: w.emails, made: Math.min(4, w.emails) });
    await w.drain();
    const all = await w.all();
    expect(all).toHaveLength(w.emails);
    expect(all.every((t) => t.state === "to_check" && t.lang === "fr" && t.draft?.fields.subject.startsWith("FR ") && t.approved === null)).toBe(true);
    expect(french).toHaveBeenCalledTimes(w.emails);
    expect(french.mock.calls[0]![0]).toMatchObject({ from: "en", to: "fr", glossary: expect.arrayContaining(["Sandbox"]) });
    expect((await w.repo.lifecycleJourneys.getById(w.journey.id))?.translationsDue).toBe(false);
    expect((await w.tenant()).translationsQueuedAt).toBeNull();
  });

  it("makes nothing for a language under the threshold", async () => {
    on();
    const w = await world(1);
    french.mockClear();
    await w.run();
    expect(await w.all()).toEqual([]);
    expect(french).not.toHaveBeenCalled();
    expect((await w.tenant()).translationsQueuedAt).toBeNull();
  });

  it("after an edit is published, translates only that email again, and readers keep the approved one meanwhile", async () => {
    on();
    const w = await world();
    await w.drain();
    // Approve them all, as a person would.
    for (const t of await w.all()) {
      await w.repo.translations.update(t.id, { state: "approved", approved: { ...t.draft!, from: "en", approvedBy: "usr_1", approvedAt: new Date(NOW).toISOString() }, draft: null });
    }
    const journey = (await w.repo.lifecycleJourneys.getById(w.journey.id))!;
    const pools = journey.draft.pools.map((p, i) => (i === 0 ? { ...p, items: p.items.map((it, j) => (j === 0 ? { ...it, subject: `${it.subject} (new)` } : it)) } : p));
    expect((await saveLifecycleDraft(ctx, journey.id, { ...journey.draft, pools }, { db: w.db, nowMs: NOW })).ok).toBe(true);
    expect((await publishLifecycleJourney(ctx, journey.id, { db: w.db, nowMs: NOW })).ok).toBe(true);
    french.mockClear();
    await w.drain();
    expect(french).toHaveBeenCalledTimes(1);
    const changed = (await w.all()).filter((t) => t.state === "to_check");
    expect(changed).toHaveLength(1);
    expect(changed[0]!.draft?.fields.subject).toContain("(new)");
    expect(changed[0]!.approved?.fields.subject).not.toContain("(new)");
  });

  it("keeps a failed translation's reason, and doesn't try it again on its own", async () => {
    on();
    const w = await world();
    const failing = vi.fn(async (): Promise<TranslateResult> => ({ ok: false, tries: 2, reason: "The subject changed or lost a merge token in double braces." }));
    for (let i = 0; i < 20 && (await w.repo.translations.find({ where: [["state", "==", "queued"]] })).length + (i === 0 ? 1 : 0) > 0; i += 1) {
      await w.run(failing);
      w.setNow(NOW + (i + 1) * 120_000);
    }
    const all = await w.all();
    expect(all.every((t) => t.state === "failed" && t.failReason === "The subject changed or lost a merge token in double braces.")).toBe(true);
    // Publishing the same words again queues nothing new.
    expect((await publishLifecycleJourney(ctx, w.journey.id, { db: w.db, nowMs: NOW })).ok).toBe(true);
    failing.mockClear();
    await w.run(failing);
    expect(failing).not.toHaveBeenCalled();
  });

  it("removes the translations of an email that is gone", async () => {
    on();
    const w = await world();
    await w.drain();
    const journey = (await w.repo.lifecycleJourneys.getById(w.journey.id))!;
    const pool = journey.draft.pools.find((p) => p.items.length > 1)!;
    expect(pool).toBeDefined();
    const gone = pool.items.at(-1)!;
    expect((await w.all()).some((t) => t.poolId === pool.id && t.itemId === gone.id)).toBe(true);
    const pools = journey.draft.pools.map((p) => (p.id === pool.id ? { ...p, items: p.items.slice(0, -1) } : p));
    expect((await saveLifecycleDraft(ctx, journey.id, { ...journey.draft, pools }, { db: w.db, nowMs: NOW })).ok).toBe(true);
    expect((await publishLifecycleJourney(ctx, journey.id, { db: w.db, nowMs: NOW })).ok).toBe(true);
    await w.run();
    expect((await w.all()).some((t) => t.poolId === pool.id && t.itemId === gone.id)).toBe(false);
  });

  it("stops at the brand's daily cap and keeps its mark for tomorrow", async () => {
    on();
    const w = await world();
    await updateTenantConfig(TENANT_ID, { translationCalls: { day: new Date(NOW).toISOString().slice(0, 10), count: 200 } }, fs(w.db));
    french.mockClear();
    const r = await w.run();
    expect(r).toMatchObject({ made: 0, capped: 1 });
    expect(french).not.toHaveBeenCalled();
    expect((await w.tenant()).translationsQueuedAt).toBeTruthy();
  });

  it("leaves a brand that may not use translations alone", async () => {
    on();
    vi.stubEnv("GRANTED_ONLY_FEATURES", "translations");
    const w = await world();
    expect(await w.run()).toMatchObject({ brands: 0 });
    expect(await w.all()).toEqual([]);
  });

  it("does nothing while the switch is off", async () => {
    const w = await world();
    on();
    await updateTenantConfig(TENANT_ID, { translationsQueuedAt: new Date(NOW).toISOString() }, fs(w.db));
    vi.unstubAllEnvs();
    expect(await w.run()).toMatchObject({ brands: 0 });
  });
});
