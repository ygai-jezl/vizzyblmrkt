import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import { readLanguageTags } from "./research";
import { checkVersions } from "./versionLive";
import { samplePlan } from "./testing/samplePlan";
import { SAMPLE_ARTICLE } from "./testing/sampleArticle";
import type { PageReader } from "./live";

/** Found live for an article's versions (PAGE_LANGUAGES_ENABLED). Made-up addresses. */

const A = { tenantId: "ten_A", region: "us", source: "system" } as TenantContext;
const NOW = Date.parse("2026-11-28T09:00:00.000Z");
const EN = "https://acme.example/blog/visibility";
const FR = "https://acme.example/fr/blog/visibility";
const DE = "https://acme.example/de/blog/visibility";
const TITLE = "What is AI search visibility monitoring?";
const words = { metaTitle: TITLE, metaDescription: "", heroAlt: "", body: SAMPLE_ARTICLE };
const tags = (...langs: Array<[string, string]>) => langs.map(([hreflang, href]) => ({ hreflang, href }));

function on() {
  for (const n of ["PAGE_LANGUAGES_ENABLED", "ASSET_TRANSLATIONS_ENABLED", "LANGUAGE_READERS_ENABLED", "CONTENT_LANGUAGE_ENABLED", "AUDIENCE_PERSON_LINKS_ENABLED"]) vi.stubEnv(n, "true");
}
beforeEach(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllEnvs());

function version(db: FakeFirestore, lang: string, address: string, state: "approved" | "to_check") {
  const at = new Date(NOW).toISOString();
  const made = { fields: words, sourceHash: "h", by: "ai" as const, at };
  db.seed("translations", `tra_plan_1_hub_${lang}`, {
    tenantId: "ten_A",
    kind: "article",
    workspaceId: "ws1",
    planId: "plan_1",
    nodeId: "hub",
    lang,
    from: "en",
    state,
    rev: 1,
    sourceHash: "h",
    source: words,
    draft: state === "to_check" ? made : null,
    approved: state === "approved" ? { ...made, from: "en", approvedBy: "usr_1", approvedAt: at } : null,
    failReason: null,
    leaseUntil: null,
    address,
    live: null,
    createdAt: at,
    updatedAt: at,
  });
}

function world() {
  const db = new FakeFirestore();
  db.seed("workspaces/ws1/content_plans", "plan_1", samplePlan({ strategy: { objective: "brand_visibility", hubUrl: EN, subscriberCount: null, sequenceType: null } }));
  version(db, "fr", FR, "approved");
  version(db, "de", DE, "to_check");
  const pages: Record<string, Awaited<ReturnType<PageReader>>> = {
    [EN]: { title: TITLE, h1: TITLE, text: SAMPLE_ARTICLE, alternates: tags(["en", EN], ["fr", FR], ["x-default", EN]) },
    [FR]: { title: TITLE, h1: TITLE, text: SAMPLE_ARTICLE, alternates: tags(["en", EN], ["fr", FR], ["x-default", EN]) },
    [DE]: { title: TITLE, h1: TITLE, text: SAMPLE_ARTICLE, alternates: tags(["en", EN], ["fr", FR], ["de", DE]) },
  };
  const read = vi.fn(async (url: string) => pages[url] ?? null);
  let opens = 10;
  const budget = { canOpen: () => opens > 0, open: () => void (opens -= 1) };
  const run = () => checkVersions(A, budget, { db: db as unknown as FirestoreLike, read, nowMs: NOW });
  const stored = (lang: string) => db.raw("translations", `tra_plan_1_hub_${lang}`) as Record<string, unknown>;
  return { db, read, run, stored, setOpens: (n: number) => (opens = n) };
}

describe("a page's language tags", () => {
  it("reads its language, canonical and alternate links, made absolute", () => {
    const html = `<html lang="fr"><head><link rel="canonical" href="/fr/blog/x"><link rel="alternate" hreflang="EN" href="https://acme.example/blog/x"><link hreflang="x-default" rel="alternate" href="../../blog/x"></head></html>`;
    expect(readLanguageTags(html, "https://acme.example/fr/blog/x")).toEqual({
      lang: "fr",
      canonical: "https://acme.example/fr/blog/x",
      alternates: [
        { hreflang: "en", href: "https://acme.example/blog/x" },
        { hreflang: "x-default", href: "https://acme.example/blog/x" },
      ],
    });
  });
});

describe("Found live for versions", () => {
  it("finds an approved version at its address, with its tags complete and the default page listing it", async () => {
    on();
    const w = world();
    const r = await w.run();
    expect(r).toMatchObject({ found: 2, approved: 1, waiting: 0 });
    expect(w.stored("fr").live).toMatchObject({ url: FR, missingTags: [], fromDefault: true });
  });

  it("approves a version a person put live while it was to check, and says which tags its page misses", async () => {
    on();
    const w = world();
    await w.run();
    expect(w.stored("de")).toMatchObject({ state: "approved", approved: { approvedBy: "found_live" }, draft: null });
    expect(w.stored("de").live).toMatchObject({ missingTags: ["x-default"], fromDefault: false });
  });

  it("stops at the page budget, and comes back for the rest", async () => {
    on();
    const w = world();
    w.setOpens(1);
    expect(await w.run()).toMatchObject({ opened: 1, waiting: 1 });
  });

  it("looks for nothing while the switch is off", async () => {
    const w = world();
    expect(await w.run()).toMatchObject({ opened: 0 });
    expect(w.read).not.toHaveBeenCalled();
  });
});
