import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Settings › General › Languages: the list for anyone signed in; with LANGUAGE_READERS_ENABLED
// the readers per language and the threshold, which only an admin changes.
const session = vi.hoisted(() => ({ getAdminContext: vi.fn() }));
vi.mock("@/lib/auth/session", () => session);
const tenants = vi.hoisted(() => ({ getTenantById: vi.fn() }));
vi.mock("@/lib/tenant", async (orig) => ({ ...(await orig<object>()), getTenantById: tenants.getTenantById }));
const control = vi.hoisted(() => ({ updateTenantConfig: vi.fn(async () => undefined) }));
vi.mock("@/lib/tenant/control", async (orig) => ({ ...(await orig<object>()), updateTenantConfig: control.updateTenantConfig }));
const readers = vi.hoisted(() => ({ languageReaders: vi.fn() }));
vi.mock("@/lib/i18n/languageReaders", async (orig) => ({ ...(await orig<object>()), languageReaders: readers.languageReaders }));

const { GET, PUT } = await import("./route");

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };
const member = { ...admin, userId: "usr_member", role: "member" };
const req = (method: string, body?: unknown, path = "/api/admin/account/locale") =>
  new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

function on() {
  vi.stubEnv("LANGUAGE_READERS_ENABLED", "true");
  vi.stubEnv("CONTENT_LANGUAGE_ENABLED", "true");
  vi.stubEnv("AUDIENCE_PERSON_LINKS_ENABLED", "true");
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  session.getAdminContext.mockResolvedValue(admin);
  tenants.getTenantById.mockResolvedValue({ id: "ten_A", defaultLocale: "en", supportedLocales: ["en", "fr"] });
  readers.languageReaders.mockResolvedValue({ list: ["en", "fr"], readers: { en: 40, fr: 12 }, at: "2026-11-27T09:00:00.000Z" });
});
afterEach(() => vi.unstubAllEnvs());

describe("GET /api/admin/account/locale", () => {
  it("401s when signed out", async () => {
    session.getAdminContext.mockResolvedValue(null);
    expect((await GET(req("GET"))).status).toBe(401);
  });

  it("is as before while the switch is off, and counts nothing", async () => {
    const res = await GET(req("GET", undefined, "/api/admin/account/locale?readers=1"));
    expect(await res.json()).toEqual({ defaultLocale: "en", supportedLocales: ["en", "fr"], writesEverything: false });
    expect(readers.languageReaders).not.toHaveBeenCalled();
  });

  it("gives the readers and the threshold when asked, with the switch on", async () => {
    on();
    const body = await (await GET(req("GET", undefined, "/api/admin/account/locale?readers=1"))).json();
    expect(body).toMatchObject({ oneList: true, minReaders: 10, canSetMinReaders: true, readers: { en: 40, fr: 12 } });
  });

  it("counts nothing unless asked, and tells a member they can't change the number", async () => {
    on();
    session.getAdminContext.mockResolvedValue(member);
    const body = await (await GET(req("GET"))).json();
    expect(body).toMatchObject({ oneList: true, canSetMinReaders: false });
    expect("readers" in body).toBe(false);
    expect(readers.languageReaders).not.toHaveBeenCalled();
  });
});

describe("PUT /api/admin/account/locale", () => {
  it("400s on a threshold out of range", async () => {
    on();
    const res = await PUT(req("PUT", { defaultLocale: "en", supportedLocales: ["en", "fr"], minReaders: 0 }));
    expect(res.status).toBe(400);
    expect(control.updateTenantConfig).not.toHaveBeenCalled();
  });

  it("lets an admin change the threshold", async () => {
    on();
    const res = await PUT(req("PUT", { defaultLocale: "en", supportedLocales: ["en", "fr"], minReaders: 25 }));
    expect(await res.json()).toEqual({ defaultLocale: "en", supportedLocales: ["en", "fr"], minReaders: 25 });
    expect(control.updateTenantConfig).toHaveBeenCalledWith("ten_A", {
      defaultLocale: "en",
      supportedLocales: ["en", "fr"],
      languageSettings: { minReaders: 25 },
    });
  });

  it("403s a member who changes the threshold, but saves their list when the number is unchanged", async () => {
    on();
    session.getAdminContext.mockResolvedValue(member);
    expect((await PUT(req("PUT", { defaultLocale: "en", supportedLocales: ["en", "fr"], minReaders: 3 }))).status).toBe(403);
    expect(control.updateTenantConfig).not.toHaveBeenCalled();

    const res = await PUT(req("PUT", { defaultLocale: "en", supportedLocales: ["en", "fr", "de"], minReaders: 10 }));
    expect(res.status).toBe(200);
    expect(control.updateTenantConfig).toHaveBeenCalledWith("ten_A", { defaultLocale: "en", supportedLocales: ["en", "fr", "de"] });
  });

  it("ignores the threshold while the switch is off", async () => {
    const res = await PUT(req("PUT", { defaultLocale: "en", supportedLocales: ["en", "fr"], minReaders: 25 }));
    expect(await res.json()).toEqual({ defaultLocale: "en", supportedLocales: ["en", "fr"] });
    expect(control.updateTenantConfig).toHaveBeenCalledWith("ten_A", { defaultLocale: "en", supportedLocales: ["en", "fr"] });
  });
});

describe("where each language goes (PAGE_LANGUAGES_ENABLED)", () => {
  function pages() {
    on();
    vi.stubEnv("ASSET_TRANSLATIONS_ENABLED", "true");
    vi.stubEnv("PAGE_LANGUAGES_ENABLED", "true");
  }
  const withSites = (siteAddresses: Record<string, string>, translatedNote = false) =>
    tenants.getTenantById.mockResolvedValue({ id: "ten_A", defaultLocale: "en", supportedLocales: ["en", "fr", "de"], languageSettings: { siteAddresses, translatedNote } });

  it("gives the folders and the note only with the switch on", async () => {
    withSites({ fr: "https://acme.example/fr/blog/" });
    on();
    expect("siteAddresses" in (await (await GET(req("GET"))).json())).toBe(false);
    pages();
    expect(await (await GET(req("GET"))).json()).toMatchObject({ pages: true, siteAddresses: { fr: "https://acme.example/fr/blog/" }, translatedNote: false });
  });

  it("lets an admin set a folder, ending it with a slash, and the note", async () => {
    pages();
    withSites({});
    const res = await PUT(req("PUT", { defaultLocale: "en", supportedLocales: ["en", "fr", "de"], siteAddresses: { fr: "https://acme.example/fr/blog", de: "" }, translatedNote: true }));
    expect(await res.json()).toMatchObject({ siteAddresses: { fr: "https://acme.example/fr/blog/" }, translatedNote: true });
    expect(control.updateTenantConfig).toHaveBeenCalledWith("ten_A", expect.objectContaining({ languageSettings: expect.objectContaining({ siteAddresses: { fr: "https://acme.example/fr/blog/" }, translatedNote: true }) }));
  });

  it("refuses an address that isn't https, and a member who changes one", async () => {
    pages();
    withSites({ fr: "https://acme.example/fr/blog/" });
    expect((await PUT(req("PUT", { defaultLocale: "en", supportedLocales: ["en", "fr"], siteAddresses: { fr: "http://acme.example/fr/" } }))).status).toBe(400);
    session.getAdminContext.mockResolvedValue(member);
    expect((await PUT(req("PUT", { defaultLocale: "en", supportedLocales: ["en", "fr", "de"], siteAddresses: { fr: "https://acme.example/blog/fr/" } }))).status).toBe(403);
    // Sending them back unchanged, as a member's Save does, is fine.
    expect((await PUT(req("PUT", { defaultLocale: "en", supportedLocales: ["en", "fr", "de"], siteAddresses: { fr: "https://acme.example/fr/blog/" } }))).status).toBe(200);
  });

  it("drops a language's folder when the language leaves the list, whoever saves", async () => {
    pages();
    withSites({ fr: "https://acme.example/fr/blog/", de: "https://acme.example/de/blog/" });
    session.getAdminContext.mockResolvedValue(member);
    const res = await PUT(req("PUT", { defaultLocale: "en", supportedLocales: ["en", "fr"], minReaders: 10 }));
    expect(res.status).toBe(200);
    expect(control.updateTenantConfig).toHaveBeenCalledWith("ten_A", expect.objectContaining({ languageSettings: expect.objectContaining({ siteAddresses: { fr: "https://acme.example/fr/blog/" } }) }));
  });
});
