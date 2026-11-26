import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeWorld, PEOPLE, type World } from "@/lib/work/testing/world";
import { LUMEN_EU, LUMEN_US } from "@/lib/work/testing/fixtures";
import { addTask } from "@/lib/work/service";

// Work's four screens (WORK_ENABLED): the list, one task, the add page and the Log. Lumen [made up]
// has Lumen Notes (United States, a repo selected) and Lumen Europe; Nina owns it and Sam is a
// member of Lumen Notes. Fernhill Plants is one brand with no repo. One fake database per Firestore
// database, with (default) both the control plane and the United States data, as in production.
const { requireAdminContext, notFound } = vi.hoisted(() => ({
  requireAdminContext: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("@/lib/auth/session", () => ({ requireAdminContext }));
vi.mock("@/lib/auth/adminAuth", () => ({ adminAuth: () => ({ getUsers: async () => ({ users: [] }) }) }));
vi.mock("next/navigation", () => ({ notFound, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), usePathname: () => "/admin/work" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never),
}));
const dbs = vi.hoisted(() => ({ map: {} as Record<string, unknown> }));
vi.mock("@/lib/tenant/firestore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant/firestore")>()),
  getDb: (id = "(default)") => dbs.map[id],
}));

const { default: ListPage } = await import("./page");
const { default: TaskRoute } = await import("./[ref]/page");
const { default: NewPage } = await import("./new/page");
const { default: LogPage } = await import("./log/page");

let w: World;
const as = (ctx: unknown) => requireAdminContext.mockResolvedValue(ctx);
const html = async (el: Promise<unknown>) => renderToStaticMarkup((await el) as ReactElement);
const list = (sp: Record<string, string> = {}) => html(ListPage({ searchParams: Promise.resolve(sp) }));
const task = (ref: string) => html(TaskRoute({ params: Promise.resolve({ ref }) }));
const log = (sp: Record<string, string> = {}) => html(LogPage({ searchParams: Promise.resolve(sp) }));
/** Add through the service, writing where the pages read: the United States data is (default). */
const add = async (who: unknown, body: Parameters<typeof addTask>[1]) => {
  const deps = { ...w.deps, regionDb: (r: "us" | "eu" | "asia") => (r === "us" ? w.control : w.dbOf(r)) };
  const r = await addTask(await w.scope(who as never), body, deps);
  if (!r.ok) throw new Error(r.error);
  return r.value.task.task;
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("WORK_ENABLED", "true");
  w = makeWorld(new Date().toISOString());
  dbs.map = { "(default)": w.control, "signups-eu": w.eu, "signups-asia": w.asia };
  as(PEOPLE.nina);
});
afterEach(() => vi.unstubAllEnvs());

describe("with WORK_ENABLED off", () => {
  it("every Work page is not found, before the session is read", async () => {
    vi.stubEnv("WORK_ENABLED", "");
    await expect(list()).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(task("1")).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(html(NewPage())).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(log()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(requireAdminContext).not.toHaveBeenCalled();
  });
});

describe("the Tasks tab", () => {
  it("shows an owner one list across both brands, with the Brand column, Import and Add task", async () => {
    await add(PEOPLE.nina, { title: "Credits and pricing page", brandId: LUMEN_US, mustHave: true, stage: "billing_tax" });
    await add(PEOPLE.nina, { title: "Cookie notice in German", brandId: LUMEN_EU });
    const page = await list();
    expect(page).toContain("One list for all of Lumen, across 2 brands and every stage.");
    expect(page).toContain("Tasks · 2 open");
    expect(page).toContain("Credits and pricing page");
    expect(page).toContain("Cookie notice in German");
    expect(page).toContain(">Brand<");
    expect(page).toContain("Lumen Europe");
    expect(page).toContain("Billing and tax");
    expect(page).toContain(">Import<");
    expect(page).toContain("Add task");
    expect(page).toContain("Checks due first, then Must have, then last changed.");
    expect(page).toContain('href="/admin/work/1"');
  });

  it("shows a member their brand's tasks only, says so, and offers no Import", async () => {
    await add(PEOPLE.nina, { title: "Cookie notice in German", brandId: LUMEN_EU });
    await add(PEOPLE.sam, { title: "Interview 5 team admins" });
    as(PEOPLE.sam);
    const page = await list();
    expect(page).toContain("You see the tasks tagged Lumen Notes.");
    expect(page).toContain("Interview 5 team admins");
    expect(page).not.toContain("Cookie notice in German");
    expect(page).not.toContain(">Import<");
    expect(page).not.toContain(">Brand<");
  });

  it("opens on the first visit with the ten stages and the ways to start, Vizzy's only with its Work tools", async () => {
    as(PEOPLE.priya);
    const first = await list();
    expect(first).toContain("One list for everything Fernhill Plants has to do");
    expect(first).toContain("Billing and tax");
    expect(first).toContain("Choose a CSV");
    expect(first).toContain("Add your first task");
    expect(first).not.toContain("Ask Vizzy for a start");
    vi.stubEnv("WORK_VIZZY_ENABLED", "true");
    expect(await list()).toContain("Ask Vizzy for a start");
    as(PEOPLE.rosa);
    expect(await list()).not.toContain("Choose a CSV");
  });

  it("filters from the address and says when nothing matches", async () => {
    await add(PEOPLE.nina, { title: "Credits and pricing page", brandId: LUMEN_US, mustHave: true });
    await add(PEOPLE.nina, { title: "Cookie notice in German", brandId: LUMEN_EU });
    const must = await list({ must: "1" });
    expect(must).toContain("Credits and pricing page");
    expect(must).not.toContain("Cookie notice in German");
    expect(must).toContain("Clear filters");
    expect(await list({ stage: "support" })).toContain("No tasks match these filters.");
  });
});

describe("one task", () => {
  it("shows the task with its origin, links, decisions and measure, and a plan to approve", async () => {
    const t = await add(PEOPLE.nina, {
      title: "Invite people to a shared notebook",
      brandId: LUMEN_US,
      description: "Run `npm run check:invites` after each build.",
      typedLinks: [{ kind: "plan", url: "https://docs.example.com/shared-notebooks", title: "Shared notebooks plan", version: "2" }],
      measure: { kind: "runs_better", what: "errors", look: { days: 7 } },
    });
    const page = await task(String(t.ref));
    expect(page).toContain("All tasks");
    expect(page).toContain(`Task #${t.ref}`);
    expect(page).toContain("Invite people to a shared notebook");
    expect(page).toContain("Added by you");
    expect(page).toContain("npm run check:invites");
    expect(page).toContain("Shared notebooks plan");
    expect(page).toContain("Not approved yet");
    expect(page).toContain("Approve the plan");
    expect(page).toContain("Record a decision");
    expect(page).toContain("How we&#x27;ll know it worked");
    expect(page).toContain("Runs better");
    expect(page).toContain("Make it a launch");
    expect(page).toContain("Delete task");
  });

  it("is not found for a ref the person can't see, one that isn't there, or one that isn't a ref", async () => {
    const eu = await add(PEOPLE.nina, { title: "Cookie notice in German", brandId: LUMEN_EU });
    as(PEOPLE.sam);
    await expect(task(String(eu.ref))).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(task("999")).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(task("abc")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("says Make it an idea with the Ideas words on, and offers a member no Delete", async () => {
    vi.stubEnv("NEXT_PUBLIC_NAV_V2_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_NAV_V2_PHASE2_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_NAV_V2_PHASE3_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_NAV_IDEAS_ENABLED", "true");
    vi.stubEnv("LAUNCH_IDEAS_ENABLED", "true");
    const t = await add(PEOPLE.sam, { title: "Interview 5 team admins" });
    as(PEOPLE.sam);
    const page = await task(String(t.ref));
    expect(page).toContain("Make it an idea");
    expect(page).not.toContain("Delete task");
  });
});

describe("the add page", () => {
  it("offers pull requests and switches only where a repo is connected", async () => {
    const lumen = await html(NewPage());
    expect(lumen).toContain("Add a task");
    expect(lumen).toContain("It becomes #1 when you add it.");
    expect(lumen).toContain("Pull request");
    expect(lumen).toContain("Whole business");
    as(PEOPLE.priya);
    const fern = await html(NewPage());
    expect(fern).not.toContain(">Pull request<");
    expect(fern).not.toContain(">Switch<");
    expect(fern).toContain(">Plan<");
    expect(fern).not.toContain("Whole business");
  });
});

describe("the Log", () => {
  it("opens on Today with the box to log a workstream", async () => {
    const page = await log();
    expect(page).toContain("In flight");
    expect(page).toContain("Today");
    expect(page).toContain("Log it");
    expect(page).toContain("Checks due");
    expect(page).toContain("Decisions made");
  });

  it("says when a day can't be shown, and links back to today", async () => {
    const page = await log({ day: "2999-01-01" });
    expect(page).toContain("That isn&#x27;t a day Work can show.");
    expect(page).toContain('href="/admin/work/log"');
  });
});
