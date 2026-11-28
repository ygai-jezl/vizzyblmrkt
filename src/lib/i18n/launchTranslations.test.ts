import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_USAGE } from "@/lib/agents/gemini";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { Campaign } from "@/lib/types/campaign";
import type { LaunchWords } from "@/lib/types/translation";
import {
  approvedLaunchLanguages,
  approvedLaunchWords,
  launchLanguages,
  launchTranslationsAction,
  launchTranslationsView,
  launchWordsOf,
  queueLaunchTranslations,
  type LaunchTranslationsView,
} from "./launchTranslations";
import { translateLaunch, type LaunchTranslateInput, type LaunchTranslateResult } from "./translateLaunch";
import { runTranslations } from "./translationsTick";

/** A launch page's own words in other languages (PAGE_LANGUAGES_ENABLED). Made-up launch. */

const A = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" } as TenantContext;
const NOW = Date.parse("2026-11-28T09:00:00.000Z");
const fdb = (db: FakeFirestore) => db as unknown as FirestoreLike;

function on() {
  for (const n of ["PAGE_LANGUAGES_ENABLED", "ASSET_TRANSLATIONS_ENABLED", "LANGUAGE_READERS_ENABLED", "CONTENT_LANGUAGE_ENABLED", "AUDIENCE_PERSON_LINKS_ENABLED"]) vi.stubEnv(n, "true");
}
beforeEach(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllEnvs());

const CAMPAIGN = {
  id: "camp1",
  tenantId: "ten_A",
  waitlistName: "Fernlight",
  productName: "Fernlight",
  configurationStyleJson: { statusDescription: "You're on the list, {{first_name}}.", joinButtonLabel: "Join the waitlist" },
  aiConversation: { enabled: true, introLine: "Tell us what you need." },
  questions: [{ question_value: "What is your role?", optional: false, answer_value: ["Founder", "Marketer"] }],
} as unknown as Campaign;

function world() {
  const db = new FakeFirestore();
  db.seed("tenants", "ten_A", {
    tenantName: "Acme",
    rootDomain: "acme.example",
    status: "active",
    region: "us",
    allowedOrigins: [],
    billingTier: "pro",
    ownerId: "usr_1",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    defaultLocale: "en",
    supportedLocales: ["en", "fr", "it"],
  });
  const { id: _id, ...doc } = CAMPAIGN as Campaign & Record<string, unknown>;
  db.seed("campaigns", "camp1", doc);
  return db;
}

const french = async (input: LaunchTranslateInput): Promise<LaunchTranslateResult> => ({
  ok: true,
  tries: 1,
  fields: { ...input.words, waitlistName: "Fernlight FR", joinButtonLabel: "Rejoindre la liste", questions: [{ question: "Quel est votre rôle ?", answers: ["Fondateur", "Marketeur"] }] },
});

describe("which languages a launch page gets", () => {
  it("offers each of its languages with widget words, other than its own", async () => {
    on();
    const db = world();
    const tenant = (db.raw("tenants", "ten_A") ?? null) as never;
    expect(launchLanguages(CAMPAIGN, tenant)).toEqual(["fr"]);
    expect(launchWordsOf(CAMPAIGN)).toMatchObject({ waitlistName: "Fernlight", joinButtonLabel: "Join the waitlist", questions: [{ question: "What is your role?", answers: ["Founder", "Marketer"] }] });
  });
});

describe("a launch page's words", () => {
  it("are queued on save, made by the lane, approved, and then shown", async () => {
    on();
    const db = world();
    expect(await queueLaunchTranslations(A, { campaign: CAMPAIGN, nowMs: NOW }, fdb(db))).toBe(1);
    expect(await queueLaunchTranslations(A, { campaign: CAMPAIGN, nowMs: NOW }, fdb(db))).toBe(0);
    await runTranslations({ deadlineMs: NOW + 95_000 }, { db: fdb(db), now: () => NOW, translateLaunch: french, log: () => {} });
    const view = (await launchTranslationsView(A, "camp1", fdb(db))).body as LaunchTranslationsView;
    const fr = view.versions[0]!;
    expect(fr).toMatchObject({ lang: "fr", state: "to_check", rev: 1 });
    expect(await approvedLaunchWords(A, CAMPAIGN, null, "fr", fdb(db))).toBeNull();
    expect((await launchTranslationsAction(A, "camp1", { action: "approve", id: fr.id, rev: fr.rev }, fdb(db))).body).toEqual({ approved: 1 });
    expect(await approvedLaunchWords(A, CAMPAIGN, null, "fr", fdb(db))).toMatchObject({ waitlistName: "Fernlight FR" });
    expect(await approvedLaunchLanguages(A, CAMPAIGN, (db.raw("tenants", "ten_A") ?? null) as never, fdb(db))).toEqual(["fr"]);
  });

  it("keeps the page's shape in a person's own words", async () => {
    on();
    const db = world();
    await queueLaunchTranslations(A, { campaign: CAMPAIGN, nowMs: NOW }, fdb(db));
    await runTranslations({ deadlineMs: NOW + 95_000 }, { db: fdb(db), now: () => NOW, translateLaunch: french, log: () => {} });
    const fr = ((await launchTranslationsView(A, "camp1", fdb(db))).body as LaunchTranslationsView).versions[0]!;
    const fields = fr.draft!.fields;
    const lostAnswer = { ...fields, questions: [{ question: "Rôle ?", answers: ["Fondateur"] }] };
    expect((await launchTranslationsAction(A, "camp1", { action: "save", id: fr.id, rev: fr.rev, fields: lostAnswer }, fdb(db))).body).toEqual({ error: "shape_changed" });
    expect((await launchTranslationsAction(A, "camp1", { action: "save", id: fr.id, rev: fr.rev, fields: { ...fields, waitlistName: "Fernlight" } }, fdb(db))).body).toEqual({ saved: true });
  });

  it("needs the brand's feature to make one, and does nothing while the switch is off", async () => {
    on();
    const db = world();
    vi.stubEnv("GRANTED_ONLY_FEATURES", "translations");
    expect((await launchTranslationsAction(A, "camp1", { action: "make", lang: "fr" }, fdb(db))).status).toBe(403);
    vi.unstubAllEnvs();
    expect(await queueLaunchTranslations(A, { campaign: CAMPAIGN, nowMs: NOW }, fdb(db))).toBe(0);
  });
});

describe("translateLaunch", () => {
  const words: LaunchWords = launchWordsOf(CAMPAIGN);
  const answer = (pairs: Record<string, string>) => JSON.stringify({ strings: Object.entries(pairs).map(([key, text]) => ({ key, text })) });
  const good = { waitlistName: "Fernlight", statusDescription: "Vous êtes inscrit, {{first_name}}.", joinButtonLabel: "Rejoindre", introLine: "Dites-nous.", q0: "Votre rôle ?", q0a0: "Fondateur", q0a1: "Marketeur" };
  const input = { words, from: "en", to: "fr", glossary: ["Fernlight"], usage: NO_USAGE };

  it("puts every string back in its place", async () => {
    const generate = vi.fn().mockResolvedValueOnce(answer(good));
    expect(await translateLaunch(input, { generate })).toEqual({
      ok: true,
      tries: 1,
      fields: { waitlistName: "Fernlight", statusDescription: "Vous êtes inscrit, {{first_name}}.", joinButtonLabel: "Rejoindre", introLine: "Dites-nous.", questions: [{ question: "Votre rôle ?", answers: ["Fondateur", "Marketeur"] }] },
    });
  });

  it("fails on a lost token or answers that became the same", async () => {
    const bad = answer({ ...good, statusDescription: "Vous êtes inscrit.", q0a1: "Fondateur" });
    const res = await translateLaunch(input, { generate: vi.fn().mockResolvedValue(bad) });
    expect(res).toMatchObject({ ok: false, tries: 2, reason: 'The string "statusDescription" changed or lost a merge token in double braces.' });
  });
});
