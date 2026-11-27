import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import { forTenant } from "@/lib/tenant";
import { updateTenantConfig } from "@/lib/tenant/control";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { LifecycleVersion, PoolItem } from "@/lib/types/lifecycle";
import type { ProductUser } from "@/lib/types/productUser";
import { translationIdOf, type EmailWords, type TranslationState } from "@/lib/types/translation";
import { enrolUser, enrolmentDocId } from "./enrol";
import { processEnrolment } from "./runner";
import { prepareDueDrafts } from "./prepare";
import { decideApproval } from "./approvals";
import { draftDocId } from "./drafts";
import { T0, TENANT_ID, contextStub, ctx, productContext, publishOnboarding, seedUser, seedWorld, sendStub, system } from "./testing/fixtures";

/**
 * Product journey emails in each reader's language (ASSET_TRANSLATIONS_ENABLED): the runner sends
 * the approved translation to a reader of that language, the brand's words to everyone else, and
 * the base whenever a translation can't be filled. Made-up people at .test addresses.
 */

const MIN = 60_000;
const HOUR = 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const LINE = "Your prompts show where to focus next.";

function on() {
  vi.stubEnv("ASSET_TRANSLATIONS_ENABLED", "true");
  vi.stubEnv("LANGUAGE_READERS_ENABLED", "true");
  vi.stubEnv("CONTENT_LANGUAGE_ENABLED", "true");
  vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
}
beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("EMAIL_LINK_ORIGIN", "https://mk.test");
  vi.stubEnv("LIFECYCLE_MODE_CEILING", "live");
  vi.stubEnv("LIFECYCLE_AI_DRAFTS_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

const frWords = (item: PoolItem): EmailWords => ({
  subject: `FR ${item.subject}`,
  previewText: item.previewText ? `FR ${item.previewText}` : (item.previewText ?? null),
  body: `Bonjour. ${item.body}`,
});

/** A translation of every email in the version, approved or still to check. */
function seedTranslations(
  db: FakeFirestore,
  journeyId: string,
  version: LifecycleVersion,
  opts: { state?: TranslationState; words?: (item: PoolItem) => EmailWords } = {},
) {
  const at = iso(T0);
  for (const pool of version.pools) {
    for (const item of pool.items) {
      const fields = (opts.words ?? frWords)(item);
      const approved = (opts.state ?? "approved") === "approved";
      db.seed("translations", translationIdOf(journeyId, pool.id, item.id, "fr"), {
        tenantId: TENANT_ID,
        kind: "journey_email",
        journeyId,
        poolId: pool.id,
        itemId: item.id,
        lang: "fr",
        from: "en",
        state: opts.state ?? "approved",
        rev: 1,
        sourceHash: "h",
        draft: approved ? null : { fields, sourceHash: "h", by: "ai", at },
        approved: approved ? { fields, sourceHash: "h", by: "ai", at, from: "en", approvedBy: "usr_1", approvedAt: at } : null,
        failReason: null,
        leaseUntil: null,
        createdAt: at,
        updatedAt: at,
      });
    }
  }
}

async function world(user: Partial<Omit<ProductUser, "id" | "tenantId">> = {}, translations: Parameters<typeof seedTranslations>[3] | null = {}) {
  const db = new FakeFirestore();
  seedWorld(db);
  await updateTenantConfig(TENANT_ID, { defaultLocale: "en", supportedLocales: ["en", "fr"] }, db as unknown as FirestoreLike);
  const alex = seedUser(db, "alex", user);
  const { journey, version } = await publishOnboarding(db, { mode: "test", testUserIds: ["alex"] });
  if (translations) seedTranslations(db, journey.id, version, translations);
  await enrolUser(system, { journey, version, user: alex, source: "trigger", anchorAt: iso(T0) }, { db, nowMs: T0 });
  const enrolmentId = enrolmentDocId(journey.id, alex.id);
  let now = T0;
  const sends = sendStub();
  const prompts: string[] = [];
  const generate = async (prompt: string) => {
    prompts.push(prompt);
    return JSON.stringify({ line: LINE, subject: "" });
  };
  const deps = { db, now: () => now, send: sends.send, fetchContext: contextStub(() => productContext()).fetchContext, generate };
  return {
    db,
    sent: sends.sent,
    prompts,
    enrolmentId,
    run: (at: number) => {
      now = at;
      return processEnrolment(system, enrolmentId, deps);
    },
    prepare: (at: number) => {
      now = at;
      return prepareDueDrafts(system, deps);
    },
    nextRunAt: async () => Date.parse((await forTenant(system, db).lifecycleEnrolments.getById(enrolmentId))!.nextRunAt!),
  };
}

/** The welcome, 15 minutes after sign up. */
async function welcome(w: Awaited<ReturnType<typeof world>>) {
  await w.run(T0);
  expect(await w.run(T0 + 15 * MIN)).toBe("sent");
  return w.sent[0]!;
}

describe("product journey emails in each reader's language", () => {
  it("sends a French reader the approved French version, marked as French", async () => {
    on();
    const m = await welcome(await world({ locale: "fr-FR" }));
    expect(m.subject.startsWith("FR ")).toBe(true);
    expect(m.html).toContain("Bonjour.");
    expect(m.html).toContain('lang="fr"');
    expect(m.html).toContain("Se désabonner");
    expect(m.html).not.toContain(">Unsubscribe<");
  });

  it("sends English while the French is still to check", async () => {
    on();
    const m = await welcome(await world({ locale: "fr" }, { state: "to_check" }));
    expect(m.subject.startsWith("FR ")).toBe(false);
    expect(m.html).not.toContain('lang="fr"');
  });

  it("sends English to an English reader and to a language the brand doesn't offer", async () => {
    on();
    for (const locale of ["en", "pt"]) {
      const m = await welcome(await world({ locale }));
      expect(m.subject.startsWith("FR "), locale).toBe(false);
    }
  });

  it("sends the brand's words when a translation can't fill a token the base can", async () => {
    on();
    const m = await welcome(
      await world({ locale: "fr", firstName: null }, { words: (item) => ({ ...frWords(item), subject: `FR {{user.first_name}} ${item.subject}` }) }),
    );
    expect(m.subject.startsWith("FR ")).toBe(false);
    expect(m.html).not.toContain('lang="fr"');
  });

  it("is byte for byte today's email while the switch is off", async () => {
    const withTranslation = await welcome(await world({ locale: "fr" }));
    const without = await welcome(await world({ locale: "fr" }, null));
    expect(withTranslation.subject).toBe(without.subject);
    expect(withTranslation.html).toBe(without.html);
  });
});

describe("the AI line follows the reader's version", () => {
  it("is written in French for a French reader, previewed in French, and sent in the French email", async () => {
    on();
    const w = await world({ locale: "fr" });
    await welcome(w);
    const sendAt = await w.nextRunAt();
    expect(await w.prepare(sendAt - 12 * HOUR)).toEqual({ prepared: 1, fallback: 0, superseded: 0 });
    expect(w.prompts.at(-1)).toContain("WRITE IN French");
    const draftId = (await forTenant(system, w.db).lifecycleDrafts.find())[0]!.id;
    const draft = (await forTenant(system, w.db).lifecycleDrafts.getById(draftId))!;
    expect(draft.language).toBe("fr");
    expect(draft.previewHtml).toContain('lang="fr"');
    expect(draftId).toBe(draftDocId(w.enrolmentId, draft.poolId, draft.itemId));

    const r = await decideApproval(ctx, draftId, { action: "approve", draftVersion: draft.draftVersion }, w.db, sendAt - 11 * HOUR);
    expect(r.status).toBe(200);
    expect(await w.run(sendAt)).toBe("sent");
    const m = w.sent.at(-1)!;
    expect(m.subject.startsWith("FR ")).toBe(true);
    expect(m.html).toContain(LINE);
    expect(m.html).toContain('lang="fr"');
  });

  it("is written in English for an English reader, as before", async () => {
    on();
    const w = await world({ locale: "en" });
    await welcome(w);
    const sendAt = await w.nextRunAt();
    await w.prepare(sendAt - 12 * HOUR);
    expect(w.prompts.at(-1)).not.toContain("WRITE IN French");
    const [draft] = await forTenant(system, w.db).lifecycleDrafts.find();
    expect(draft!.language).toBeUndefined();
  });
});
