import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeWorld, PEOPLE, type World } from "@/lib/work/testing/world";
import { LUMEN_EU, LUMEN_US } from "@/lib/work/testing/fixtures";
import { addTask, editTask } from "@/lib/work/service";
import { addSuggestion, proposeWorkSuggestion } from "@/lib/work/suggestions";
import { WORK_COPY } from "@/lib/work/screenWords";
import { IMAGES_OFF_LINE } from "@/lib/work/words";

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
// Firebase Auth knows nobody here. The task page reads each brand's team names side by side, and
// Vitest can hand one of two imports of a mocked module made at the same moment the real module,
// which then spends seconds looking for a Google Cloud project (past the time a test gets on CI).
// So the names lookup gets its own lookup that finds nobody, and never imports Firebase Auth.
vi.mock("@/lib/team/names", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/team/names")>();
  const nobody = async () => [];
  return { ...real, teamMemberNames: (...[ctx, ids, opts]: Parameters<typeof real.teamMemberNames>) => real.teamMemberNames(ctx, ids, { ...opts, lookup: opts?.lookup ?? nobody }) };
});
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

// Each of these tests draws a whole page, and the first to draw a part loads its modules then:
// on CI's slower runners that can take longer than the 5 seconds a test gets by default.
const WHOLE_PAGE = { timeout: 30_000 };

describe("with WORK_ENABLED off", () => {
  it("every Work page is not found, before the session is read", async () => {
    vi.stubEnv("WORK_ENABLED", "");
    await expect(list()).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(task("1")).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(html(NewPage({ searchParams: Promise.resolve({}) }))).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(log()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(requireAdminContext).not.toHaveBeenCalled();
  });
});

describe("the Tasks tab", WHOLE_PAGE, () => {
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

describe("the Tasks tab with quick edit", WHOLE_PAGE, () => {
  const reads = () => ["(default)", "signups-eu", "signups-asia"].reduce((n, id) => n + (dbs.map[id] as { collectionCalls: (c: string) => number }).collectionCalls("work_tasks"), 0);

  it("off, draws today's list exactly, ignoring ?open and reading nothing more", async () => {
    await add(PEOPLE.nina, { title: "Credits and pricing page", brandId: LUMEN_US, mustHave: true });
    vi.stubEnv("WORK_QUICK_EDIT_ENABLED", "false");
    let n = reads();
    const plain = await list();
    const plainReads = reads() - n;
    n = reads();
    const opened = await list({ open: "1" });
    expect(reads() - n).toBe(plainReads);
    expect(opened).toBe(plain);
    expect(opened).not.toContain("wk-row-panel");
    expect(opened).not.toContain("data-ref-button");
    expect(opened).toContain('href="/admin/work/1"');
  });

  it("on, draws the task opened with ?open in place under its row, with everything its page has", async () => {
    vi.stubEnv("WORK_QUICK_EDIT_ENABLED", "true");
    await add(PEOPLE.nina, { title: "Credits and pricing page", brandId: LUMEN_US, mustHave: true, description: "Prices for the Team plan." });
    await add(PEOPLE.nina, { title: "Cookie notice in German", brandId: LUMEN_EU });
    const closed = await list();
    expect(closed).toContain('aria-expanded="false" data-ref-button="1"');
    expect(closed).not.toContain('id="wk-row-panel"');
    const page = await list({ open: "1" });
    expect(page).toContain('aria-expanded="true" aria-controls="wk-row-panel" data-ref-button="1"');
    expect(page).toContain('<section id="wk-row-panel"');
    expect(page).toContain("Task #1 ");
    expect(page).toContain("Prices for the Team plan.");
    expect(page).toContain("Open the full page");
    expect(page).toContain('aria-label="Quick fields"');
    expect(page).toContain("Delete task");
    // The other row stays closed, and the order line is today's.
    expect(page).toContain('aria-expanded="false" data-ref-button="2"');
    expect(page).toContain("Checks due first, then Must have, then last changed.");
  });

  it("on, words an operator's loop kind measure and its due check in the row as its page does, with the learning loops on", async () => {
    vi.stubEnv("WORK_QUICK_EDIT_ENABLED", "true");
    vi.stubEnv("LOOPS_ENABLED", "true");
    vi.stubEnv("LOOPS_OPERATOR_EMAILS", "nina@lumen.example");
    const t = await add(PEOPLE.nina, { title: "Brighter post images", brandId: LUMEN_US, status: "done", measure: { kind: "used", counts: { loopKind: "post_image" }, look: { days: 7 } } });
    // How we'll know it worked, as the page draws it, less where a click in the row lands.
    const measureOf = (html: string) => {
      const from = html.indexOf('<section aria-labelledby="wk-ms-h"');
      expect(from).toBeGreaterThan(-1);
      return html.slice(from, html.indexOf("</section>", from)).replace(/ data-qe="[^"]*"/g, "");
    };
    // Eight days after Done its check is due, and with image learning off an image kind isn't counted.
    const due = `<strong>${WORK_COPY.measureDueTitle}</strong> Used: the post_image loop, 7 days after it&#x27;s done. ${IMAGES_OFF_LINE.replace(/'/g, "&#x27;")}`;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 8 * 86_400_000);
      const page = await task(String(t.ref));
      const row = await list({ open: String(t.ref) });
      expect(page).toContain(due);
      expect(row).toContain(due);
      expect(measureOf(row)).toBe(measureOf(page));
      expect(measureOf(row)).toContain("the post_image loop");
    } finally {
      vi.useRealTimers();
    }
  });

  it("says there's no task with that number for one that isn't there, or one the person can't see", async () => {
    vi.stubEnv("WORK_QUICK_EDIT_ENABLED", "true");
    await add(PEOPLE.nina, { title: "Credits and pricing page", brandId: LUMEN_US });
    const eu = await add(PEOPLE.nina, { title: "Cookie notice in German", brandId: LUMEN_EU });
    expect(await list({ open: "999" })).toContain("There&#x27;s no task with that number that you can see.");
    as(PEOPLE.sam);
    const sam = await list({ open: String(eu.ref) });
    expect(sam).toContain("There&#x27;s no task with that number that you can see.");
    expect(sam).not.toContain("Cookie notice in German");
  });

  it("keeps the only task, set Done under Open, as a kept row, never No tasks match", async () => {
    vi.stubEnv("WORK_QUICK_EDIT_ENABLED", "true");
    const t = await add(PEOPLE.nina, { title: "Register the business name", brandId: LUMEN_US });
    const deps = { ...w.deps, regionDb: (r: "us" | "eu" | "asia") => (r === "us" ? w.control : w.dbOf(r)) };
    const r = await editTask(await w.scope(PEOPLE.nina), t.ref, { status: "done" }, deps);
    if (!r.ok) throw new Error(r.error);
    expect(await list()).toContain("No tasks match these filters.");
    const kept = await list({ open: String(t.ref) });
    expect(kept).not.toContain("No tasks match these filters.");
    expect(kept).toContain(`data-row="${t.ref}"`);
    expect(kept).toContain("This task no longer matches your filters. It leaves the list when you close it.");
  });
});

describe("one task", WHOLE_PAGE, () => {
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

describe("the add page", WHOLE_PAGE, () => {
  it("offers pull requests and switches only where a repo is connected", async () => {
    const lumen = await html(NewPage({ searchParams: Promise.resolve({}) }));
    expect(lumen).toContain("Add a task");
    expect(lumen).toContain("It becomes #1 when you add it.");
    expect(lumen).toContain("Pull request");
    expect(lumen).toContain("Whole business");
    as(PEOPLE.priya);
    const fern = await html(NewPage({ searchParams: Promise.resolve({}) }));
    expect(fern).not.toContain(">Pull request<");
    expect(fern).not.toContain(">Switch<");
    expect(fern).toContain(">Plan<");
    expect(fern).not.toContain("Whole business");
  });
});

describe("the Log", WHOLE_PAGE, () => {
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

describe("Edit then add", WHOLE_PAGE, () => {
  const newPage = (sp: Record<string, string>) => html(NewPage({ searchParams: Promise.resolve(sp) }));
  async function suggest(brandId: string | null = LUMEN_US) {
    const deps = { ...w.deps, regionDb: (r: "us" | "eu" | "asia") => (r === "us" ? w.control : w.dbOf(r)) };
    const r = await proposeWorkSuggestion(
      await w.scope(PEOPLE.nina),
      {
        task: {
          title: "Answer “Does Lumen work offline?” on your site",
          description: "A short page that answers it.",
          stage: "market",
          brandId,
          typedLinks: [],
          measure: { kind: "moves", meaning: "searchClicks", look: { days: 28 } },
          proposed: { kind: "moves", reason: "It answers a question people search for." },
          from: "from your numbers",
          why: "41 searches asked it last month.",
        },
      },
      deps,
    );
    if (!r.ok || !r.value.action) throw new Error("not made");
    return r.value.action;
  }

  it("opens the add page filled with Vizzy's suggestion, its kind marked Vizzy suggests, Cancel back to Review", async () => {
    const a = await suggest();
    const page = await newPage({ suggestion: a.id });
    expect(page).toContain("New task from Vizzy");
    expect(page).toContain('value="Answer “Does Lumen work offline?” on your site"');
    expect(page).toContain("Vizzy wrote it from your numbers. What Vizzy wrote is kept beside what you add.");
    expect(page).toContain("Vizzy suggests Moves a number. It answers a question people search for.");
    expect(page).toContain('href="/admin/approvals#work_suggestion"');
    // The task and the suggestion commit together, so only brands kept in this region are offered.
    expect(page).not.toContain(">Lumen Europe<");
  });

  it("shows the task's origin with where Vizzy wrote it from, and what Vizzy suggested for each field changed", async () => {
    const a = await suggest();
    const deps = { ...w.deps, regionDb: (r: "us" | "eu" | "asia") => (r === "us" ? w.control : w.dbOf(r)) };
    const r = await addSuggestion(
      await w.scope(PEOPLE.nina),
      { actionId: a.id, rev: 1, task: { title: "Does Lumen work offline? A help page", description: "A short page that answers it.", stage: "support", brandId: LUMEN_US, typedLinks: [], measure: { kind: "moves", meaning: "searchClicks", look: { days: 28 } } } },
      deps,
    );
    if (!r.ok) throw new Error(r.error);
    const page = await task(String(r.value.task.task.ref));
    expect(page).toMatch(/From Vizzy:<\/span> from your numbers\. Added by you on \d+ \w+, edited before adding\./);
    expect(page).toContain("What Vizzy suggested");
    expect(page).toContain("Answer “Does Lumen work offline?” on your site");
    expect(page).toContain("5 Market");
  });

  it("after Edit then add, leaves the decided suggestion's address for a fresh add page, never its refusal", async () => {
    const a = await suggest();
    const deps = { ...w.deps, regionDb: (r: "us" | "eu" | "asia") => (r === "us" ? w.control : w.dbOf(r)) };
    const r = await addSuggestion(await w.scope(PEOPLE.nina), { actionId: a.id, rev: 1 }, deps);
    if (!r.ok) throw new Error(r.error);
    // Read again, the suggestion's own address refuses: it is decided now.
    expect(await newPage({ suggestion: a.id })).toContain("That suggestion was added or dismissed already.");
    // So the form reads nothing again after adding: it keeps its done note and moves the address
    // to the plain add page, which is what a reload or Add another opens.
    const { afterAddSteps } = await import("@/components/admin/work/TaskForm");
    expect(afterAddSteps(true)).toEqual({ refresh: false, address: "/admin/work/new", refreshOnAnother: true });
    expect(afterAddSteps(false)).toEqual({ refresh: true, address: null, refreshOnAnother: false });
    const fresh = await newPage({});
    expect(fresh).toContain("Add a task");
    expect(fresh).not.toContain("New task from Vizzy");
    expect(fresh).not.toContain("added or dismissed already");
  });

  it("says why when the suggestion can't be added, with the way back to Review", async () => {
    const whole = await suggest(null);
    for (const id of ["not-an-id", `aa_${"3".repeat(40)}`]) {
      const page = await newPage({ suggestion: id });
      expect(page).toContain("That suggestion isn&#x27;t there any more, or it&#x27;s for a brand you can&#x27;t see.");
      expect(page).toContain('href="/admin/approvals#work_suggestion"');
    }
    as(PEOPLE.sam);
    expect(await newPage({ suggestion: whole.id })).toContain("That suggestion isn&#x27;t there any more");
  });
});
