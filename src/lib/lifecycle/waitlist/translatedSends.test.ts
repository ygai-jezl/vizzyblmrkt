import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import { updateTenantConfig } from "@/lib/tenant/control";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { Signup } from "@/lib/types/signup";
import { translationIdOf } from "@/lib/types/translation";
import { sendStub } from "../testing/fixtures";
import { enrolWaitlistSignup } from "./enrol";
import { waitlistEnrolmentId } from "./ids";
import { processWaitlistEnrolment } from "./runner";
import { CAMPAIGN_ID, publishWaitlist, seedLaunch, seedSignup, system, T0, TENANT_ID } from "./testing/fixtures";

/**
 * Launch journey emails in each reader's language (ASSET_TRANSLATIONS_ENABLED): a sign up gets the
 * approved translation in the language they signed up in, else the launch's words.
 */

const iso = (ms: number) => new Date(ms).toISOString();

function on() {
  vi.stubEnv("ASSET_TRANSLATIONS_ENABLED", "true");
  vi.stubEnv("LANGUAGE_READERS_ENABLED", "true");
  vi.stubEnv("CONTENT_LANGUAGE_ENABLED", "true");
  vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
}
beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("WAITLIST_ENGINE_ENABLED", "true");
  vi.stubEnv("EMAIL_LINK_ORIGIN", "https://mk.test");
  vi.stubEnv("LIFECYCLE_MODE_CEILING", "test");
});
afterEach(() => vi.unstubAllEnvs());

async function world(signup: Partial<Omit<Signup, "id" | "tenantId">>, subject: string | null = "Bienvenue sur {{waitlist_name}}") {
  const db = new FakeFirestore();
  seedLaunch(db);
  await updateTenantConfig(TENANT_ID, { defaultLocale: "en", supportedLocales: ["en", "fr"] }, db as unknown as FirestoreLike);
  const ada = seedSignup(db, "ada", signup);
  const { journey, version } = await publishWaitlist(db, { mode: "test", testEmails: ["ada@example.test"] });
  if (subject !== null) {
    const at = iso(T0);
    const fields = { subject, previewText: null, body: "Bonjour {{first_name}}, vous êtes n°{{current_rank}}." };
    db.seed("translations", translationIdOf(journey.id, "p_email1", "control", "fr"), {
      tenantId: TENANT_ID,
      kind: "journey_email",
      journeyId: journey.id,
      poolId: "p_email1",
      itemId: "control",
      lang: "fr",
      from: "en",
      state: "approved",
      rev: 1,
      sourceHash: "h",
      draft: null,
      approved: { fields, sourceHash: "h", by: "ai", at, from: "en", approvedBy: "usr_1", approvedAt: at },
      failReason: null,
      leaseUntil: null,
      createdAt: at,
      updatedAt: at,
    });
  }
  const campaign = (await forTenant(system, db).campaigns.getById(CAMPAIGN_ID))!;
  await enrolWaitlistSignup(system, { journey, version, campaign, signup: ada, source: "trigger" }, { db, nowMs: T0 });
  const sends = sendStub();
  const outcome = await processWaitlistEnrolment(system, waitlistEnrolmentId(journey.id, ada.id), { db, now: () => T0, send: sends.send, syncWeekly: vi.fn(async () => ({ ok: true })) });
  expect(outcome).toBe("sent");
  return sends.sent[0]!;
}

describe("launch journey emails in each reader's language", () => {
  it("sends someone who signed up in French the approved French welcome", async () => {
    on();
    const m = await world({ locale: "fr" });
    expect(m.subject).toBe("Bienvenue sur Fernlight");
    expect(m.html).toContain("Bonjour Ada, vous êtes n°1.");
    expect(m.html).toContain('lang="fr"');
    expect(m.html).toContain("Se désabonner");
  });

  it("sends the launch's words to an English sign up", async () => {
    on();
    const m = await world({ locale: "en" });
    expect(m.subject).toBe("Welcome to Fernlight");
    expect(m.html).not.toContain('lang="fr"');
  });

  it("sends the launch's words when the translation's subject comes out empty", async () => {
    on();
    const m = await world({ locale: "fr" }, "{{no_such_value}}");
    expect(m.subject).toBe("Welcome to Fernlight");
  });

  it("is byte for byte today's email while the switch is off", async () => {
    // The unsubscribe link is signed with the real time: hold it still so both sends match.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    const withTranslation = await world({ locale: "fr" });
    const without = await world({ locale: "fr" }, null);
    vi.useRealTimers();
    expect(withTranslation.html).toBe(without.html);
    expect(withTranslation.subject).toBe("Welcome to Fernlight");
  });
});
