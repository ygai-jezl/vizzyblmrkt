import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";

// Settings › Loops (LOOPS_ENABLED, learning loops step 5): only the people LOOPS_OPERATOR_EMAILS
// names see it, with a verified address. Everyone else gets no tab, and the address is not found.
// The operator and Maya are made up, at example.com.
const { requireAdminContext, notFound, pathname } = vi.hoisted(() => ({
  requireAdminContext: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  pathname: { value: "/admin/account/loops" },
}));
vi.mock("@/lib/auth/session", () => ({ requireAdminContext }));
vi.mock("next/navigation", () => ({ notFound, usePathname: () => pathname.value, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never),
}));
vi.mock("@/lib/connectors/organisationPage", () => ({ loadOrganisationPageOwner: vi.fn(async () => null) }));
const store = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: () => store.db,
}));

const { default: LoopsPage } = await import("./page");
const { default: AccountLayout } = await import("../layout");
const { AccountTabs } = await import("@/components/admin/AccountTabs");
const { loopsWeeks } = await import("@/lib/loops/loopsSection");
const { fleetCellId, FLEET_CELLS } = await import("@/lib/tenant/fleetCells");

const OPERATOR = { tenantId: "ten_demo", region: "us" as const, userId: "usr_op", role: "admin" as const, source: "idtoken" as const, email: "operator@example.com", emailVerified: true };
const MAYA = { ...OPERATOR, userId: "usr_maya", email: "maya@example.com" };

const open = async (week?: string) => renderToStaticMarkup((await LoopsPage({ searchParams: Promise.resolve(week ? { week } : {}) })) as ReactElement);
const tabs = async () => renderToStaticMarkup((await AccountLayout({ children: null })) as ReactElement);

beforeEach(() => {
  store.db = new FakeFirestore();
  vi.stubEnv("LOOPS_ENABLED", "true");
  vi.stubEnv("LOOPS_OPERATOR_EMAILS", "Operator@example.com, someone@example.com");
  vi.stubEnv("NEXT_PUBLIC_NAV_V2_PHASE3_ENABLED", "true");
  requireAdminContext.mockResolvedValue(OPERATOR);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("Settings › Loops", () => {
  it("shows an operator the section, ignoring the address's case, with the empty first week", async () => {
    const html = await open();
    expect(html).toContain("<h2");
    expect(html).toContain("Counts across every brand in this copy, by organisation, for closed weeks. Only the people this copy&#x27;s operator setting names see this.");
    expect(html).toContain("Counts start after the first closed week.");
    expect(html).toContain('aria-label="Week"');
  });

  it("renders every block of a closed week: the Memory Bank stall in amber, thumbs down, coverage and the lines that don't learn", async () => {
    const [week, before] = loopsWeeks(new Date());
    const db = new FakeFirestore();
    db.seed(FLEET_CELLS, fleetCellId.orgs(week!), { n: { orgs: 3, p: { pro: 3 }, i: { unknown: 3 }, reported: 3, listed: 3 } });
    db.seed(FLEET_CELLS, fleetCellId.kind("edit_mode", week!), {
      n: { orgs: 3, st: { stamped: { p: { pro: 3 } }, signalled: { p: { pro: 3 } } }, stuck: { signalled: { p: { pro: 3 }, why: { pro: { plan: 3 } } } }, refused: { plan: 3 } },
    });
    store.db = db;
    const html = await open();
    for (const heading of [
      "Coverage",
      "How far each kind gets, in organisations",
      "Where brands get stuck, by plan",
      "Why learners didn&#x27;t learn, in organisations",
      "Thumbs down by reason",
      "Stamp coverage this week",
      "Go back cards",
      "When the holdback could read",
      "Industries",
      "Not learning",
      "Clean up",
      "Doesn&#x27;t fit us counts",
      "Connector health",
    ]) {
      expect(html, heading).toContain(heading);
    }
    expect(html).toContain("Edit mode, Pro: all 3 organisations that reached Signalled are stuck there, none Learning for 28 days. Top reason: not in the brand&#x27;s plan (3).");
    expect(html).toContain("Not in the brand&#x27;s plan");
    expect(html).toContain("What each line means and why");
    // The other week has no counts yet, so it is shown but isn't a link.
    expect(html).not.toContain(`href="/admin/account/loops?week=${before}"`);
    expect(html).toContain('aria-disabled="true"');
  });

  it("is not found with the switch off, for someone it doesn't name, for an unverified address, or with the setting empty", async () => {
    vi.stubEnv("LOOPS_ENABLED", "false");
    await expect(open()).rejects.toThrow("NEXT_NOT_FOUND");
    vi.stubEnv("LOOPS_ENABLED", "true");
    requireAdminContext.mockResolvedValue(MAYA);
    await expect(open()).rejects.toThrow("NEXT_NOT_FOUND");
    requireAdminContext.mockResolvedValue({ ...OPERATOR, emailVerified: false });
    await expect(open()).rejects.toThrow("NEXT_NOT_FOUND");
    requireAdminContext.mockResolvedValue({ ...OPERATOR, email: undefined });
    await expect(open()).rejects.toThrow("NEXT_NOT_FOUND");
    requireAdminContext.mockResolvedValue(OPERATOR);
    vi.stubEnv("LOOPS_OPERATOR_EMAILS", "");
    await expect(open()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("reads nothing for someone who isn't an operator", async () => {
    const db = new FakeFirestore();
    const collection = vi.spyOn(db, "collection");
    store.db = db;
    requireAdminContext.mockResolvedValue(MAYA);
    await expect(open()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(collection).not.toHaveBeenCalled();
  });

  it("gives an operator the Loops tab, last; no one else gets it, and the sidebar isn't touched", async () => {
    vi.stubEnv("SETTINGS_HISTORY_ENABLED", "true");
    expect(await tabs()).toMatch(/History<\/a><a href="\/admin\/account\/loops"[^>]*>Loops<\/a><\/div>/);
    requireAdminContext.mockResolvedValue(MAYA);
    expect(await tabs()).not.toContain("/admin/account/loops");
    requireAdminContext.mockResolvedValue(OPERATOR);
    vi.stubEnv("LOOPS_ENABLED", "false");
    expect(await tabs()).not.toContain("/admin/account/loops");
  });

  it("puts the tab after every other one, on the older tab strip too", () => {
    vi.stubEnv("NEXT_PUBLIC_NAV_V2_PHASE3_ENABLED", "false");
    const html = renderToStaticMarkup(AccountTabs({ dataModel: true, organisation: true, history: true, loops: true }));
    expect(html).toMatch(/Loops<\/a><\/div>$/);
    expect(renderToStaticMarkup(AccountTabs({ history: true }))).not.toContain("Loops");
  });
});
