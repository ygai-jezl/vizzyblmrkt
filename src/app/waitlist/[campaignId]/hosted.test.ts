import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A launch's hosted page, one address per language (PAGE_LANGUAGES_ENABLED). The brand, the
 * launch and its approved words are stand-ins; the language rules are the real ones.
 */

const h = vi.hoisted(() => ({
  headers: new Map<string, string>(),
  cookies: new Map<string, string>(),
  approved: new Map<string, unknown>(),
}));
vi.mock("next/headers", () => ({
  headers: async () => ({ get: (k: string) => h.headers.get(k.toLowerCase()) ?? null }),
  cookies: async () => ({ get: (k: string) => (h.cookies.has(k) ? { value: h.cookies.get(k) } : undefined) }),
}));
const nav = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
  permanentRedirect: vi.fn((to: string) => {
    throw new Error(`308 ${to}`);
  }),
  redirect: vi.fn((to: string) => {
    throw new Error(`307 ${to}`);
  }),
}));
vi.mock("next/navigation", () => nav);

const CAMPAIGN = {
  id: "camp1",
  tenantId: "ten_A",
  waitlistName: "Fernlight",
  configurationStyleJson: { joinButtonLabel: "Join the waitlist" },
  questions: [{ question_value: "Your role?", optional: true, answer_value: ["Founder", "Marketer"] }],
  requiredContactDetail: "EMAIL",
  usesFirstnameLastname: false,
  hideCounts: true,
};
const TENANT = { id: "ten_A", tenantName: "Acme", defaultLocale: "en", supportedLocales: ["en", "fr", "it"] };
vi.mock("@/lib/tenant", () => ({
  resolveTenantForRequest: vi.fn(async () => ({ tenantId: "ten_A", region: "us", source: "host" })),
  getTenantById: vi.fn(async () => TENANT),
  forTenant: () => ({
    campaigns: { getById: async (id: string) => (id === "camp1" ? CAMPAIGN : null) },
    signups: { count: async () => 0, find: async () => [] },
  }),
}));
vi.mock("@/lib/waitlist/leaderboard", () => ({ getLeaderboard: async () => [] }));
vi.mock("@/lib/i18n/launchTranslations", async (orig) => ({
  ...(await orig<object>()),
  approvedLaunchLanguages: async () => [...h.approved.keys()],
  approvedLaunchWords: async (_c: unknown, _camp: unknown, _t: unknown, lang: string) => h.approved.get(lang) ?? null,
}));

const { hostedMetadata, renderHostedPage } = await import("./hosted");

function on() {
  for (const n of ["PAGE_LANGUAGES_ENABLED", "ASSET_TRANSLATIONS_ENABLED", "LANGUAGE_READERS_ENABLED", "CONTENT_LANGUAGE_ENABLED", "AUDIENCE_PERSON_LINKS_ENABLED"]) vi.stubEnv(n, "true");
}
const FRENCH = { waitlistName: "Fernlight en français", statusDescription: null, joinButtonLabel: "Rejoindre la liste", introLine: null, questions: [{ question: "Votre rôle ?", answers: ["Fondateur", "Marketeur"] }] };
const render = async (sp: Record<string, string>, lang: string | null) => renderToStaticMarkup((await renderHostedPage("camp1", sp, lang)) as ReactElement);

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  h.headers = new Map([["host", "acme.example"], ["x-forwarded-proto", "https"]]);
  h.cookies = new Map();
  h.approved = new Map();
});
afterEach(() => vi.unstubAllEnvs());

describe("one address per language", () => {
  it("lists the default page and each approved language with x-default, each canonical on itself", async () => {
    on();
    h.approved.set("fr", FRENCH);
    const base = await hostedMetadata("camp1", {}, null);
    expect(base.alternates).toEqual({
      canonical: "https://acme.example/waitlist/camp1",
      languages: { en: "https://acme.example/waitlist/camp1", fr: "https://acme.example/waitlist/camp1/fr", "x-default": "https://acme.example/waitlist/camp1" },
    });
    const fr = await hostedMetadata("camp1", {}, "fr");
    expect(fr).toMatchObject({ title: "Fernlight en français", alternates: { canonical: "https://acme.example/waitlist/camp1/fr" } });
    expect(fr).not.toHaveProperty("robots");
  });

  it("shows the approved words on the French page, sending the launch's own answers", async () => {
    on();
    h.approved.set("fr", FRENCH);
    const html = await render({}, "fr");
    expect(html).toContain('lang="fr"');
    expect(html).toContain("Fernlight en français");
    expect(html).toContain("Rejoindre la liste");
    expect(html).toContain('<option value="Founder">Fondateur</option>');
  });

  it("keeps a language with no approved words out of search, with the launch's own words", async () => {
    on();
    expect(await hostedMetadata("camp1", {}, "fr")).toMatchObject({ robots: { index: false, follow: true }, title: "Fernlight" });
    expect(await render({}, "fr")).toContain(">Fernlight<");
  });

  it("has no page for a language the launch doesn't offer, or the widget has no words in", async () => {
    on();
    await expect(render({}, "de")).rejects.toThrow("NOT_FOUND");
    await expect(render({}, "it")).rejects.toThrow("NOT_FOUND");
  });

  it("sends an old ?lng= link on to its page for good, keeping what else it carried", async () => {
    on();
    await expect(render({ lng: "fr", ref: "abc" }, null)).rejects.toThrow("308 /waitlist/camp1/fr?ref=abc");
    await expect(render({ lng: "de" }, null)).rejects.toThrow("308 /waitlist/camp1");
  });

  it("never switches by browser language or cookie, but offers a link to the preferred page", async () => {
    on();
    h.headers.set("accept-language", "fr-FR,fr;q=0.9");
    h.cookies.set("lng", "fr");
    const html = await render({}, null);
    expect(html).toContain('lang="en"');
    expect(html).toContain('<a href="/waitlist/camp1/fr" class="underline">Voir cette page en français</a>');
  });

  it("is today's page while the switch is off: one address, the browser's language, and no French address", async () => {
    h.headers.set("accept-language", "fr");
    expect(await render({}, null)).toContain('lang="fr"');
    expect(await hostedMetadata("camp1", {}, null)).toEqual({});
  });
});
