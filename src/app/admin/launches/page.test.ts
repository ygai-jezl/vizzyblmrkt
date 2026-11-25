import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeFirestore } from "@/lib/tenant/testing/fakeFirestore";
import type { ComparedIdea } from "@/lib/ideas/compare";

// The launches list (nav v2): with LAUNCH_IDEAS_ENABLED, ?idea= filters by status and ?compare=
// shows 2 to 4 of this brand's launches side by side. The page's data comes from a fake Firestore.
const state = vi.hoisted(() => ({ db: null as unknown, ctx: null as unknown }));
vi.mock("@/lib/auth/session", () => ({ requireAdminContext: async () => state.ctx }));
vi.mock("@/lib/tenant", async (orig) => {
  const real = await orig<typeof import("@/lib/tenant")>();
  return { ...real, forTenant: (ctx: Parameters<typeof real.forTenant>[0]) => real.forTenant(ctx, state.db as FakeFirestore) };
});
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("not_found");
  },
}));
const { default: LaunchesPage } = await import("./page");
const { CompareTable } = await import("@/components/admin/ideas/CompareTable");
const { ComparePicks } = await import("@/components/admin/ideas/ComparePicks");

interface El {
  type: unknown;
  props: Record<string, unknown> & { children?: ReactNode };
}
const isEl = (n: unknown): n is El => typeof n === "object" && n !== null && "type" in n && "props" in n;

/** Every element in the page as written, components left unrendered. */
function elements(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const n of node) elements(n, out);
    return out;
  }
  if (!isEl(node)) return out;
  out.push(node);
  elements(node.props.children, out);
  return out;
}

const admin = { tenantId: "ten_A", region: "us", source: "idtoken", userId: "usr_admin", role: "admin" };

function world(): FakeFirestore {
  const db = new FakeFirestore();
  const launch = (id: string, tenantId: string, createdAt: string, extra: Record<string, unknown> = {}) =>
    db.seed("campaigns", id, { tenantId, waitlistName: id, createdAt, ...extra });
  launch("offline-mode", "ten_A", "2026-11-19T00:00:00.000Z", { idea: { status: "exploring" } });
  launch("team-spaces", "ten_A", "2026-10-28T00:00:00.000Z", { idea: { status: "testing" } });
  launch("weekly-digest", "ten_A", "2026-09-09T00:00:00.000Z", { idea: { status: "launched" } });
  launch("calendar-sync", "ten_A", "2026-08-14T00:00:00.000Z", { idea: { status: "parked" } });
  launch("ai-summaries", "ten_A", "2026-07-05T00:00:00.000Z", { idea: { status: "killed" } });
  launch("old-launch", "ten_A", "2026-03-01T00:00:00.000Z");
  launch("product-updates", "ten_A", "2026-02-20T00:00:00.000Z", { idea: { justAList: true } });
  launch("their-idea", "ten_B", "2026-11-01T00:00:00.000Z", { idea: { status: "testing" } });
  return db;
}

const open = async (sp: Record<string, string | string[]> = {}) => elements(await LaunchesPage({ searchParams: Promise.resolve(sp) }));
const compareOf = (els: El[]) => els.find((e) => e.type === CompareTable)?.props.columns as ComparedIdea[] | undefined;
/** The launches the list shows, by their compare box or their spacer. */
const rowIds = (els: El[]) => els.filter((e) => e.type === "li").map((e) => String((e as unknown as { key: string }).key));
const boxes = (els: El[]) => els.filter((e) => e.type === "input" && e.props.name === "compare").map((e) => e.props.value);

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_NAV_V2_ENABLED", "true");
  vi.stubEnv("LAUNCH_IDEAS_ENABLED", "true");
  state.db = world();
  state.ctx = admin;
});
afterEach(() => vi.unstubAllEnvs());

describe("the launches list", () => {
  it("is not found with nav v2 off", async () => {
    vi.stubEnv("NEXT_PUBLIC_NAV_V2_ENABLED", "false");
    await expect(open()).rejects.toThrow("not_found");
  });

  it("puts a compare box on every row but Just a list, in a plain GET form", async () => {
    const els = await open();
    expect(rowIds(els)).toEqual(["offline-mode", "team-spaces", "weekly-digest", "calendar-sync", "ai-summaries", "old-launch", "product-updates"]);
    expect(boxes(els)).toEqual(["offline-mode", "team-spaces", "weekly-digest", "calendar-sync", "ai-summaries", "old-launch"]);
    const form = els.find((e) => e.type === "form")!;
    expect(form.props).toMatchObject({ method: "get", action: "/admin/launches" });
    expect(els.some((e) => e.type === ComparePicks)).toBe(true);
  });

  it("filters by ?idea=: a status, none yet, or Just a list, and ignores anything else", async () => {
    expect(rowIds(await open({ idea: "testing" }))).toEqual(["team-spaces"]);
    expect(rowIds(await open({ idea: "none" }))).toEqual(["old-launch"]);
    expect(rowIds(await open({ idea: "list" }))).toEqual(["product-updates"]);
    expect(rowIds(await open({ idea: "archived" }))).toHaveLength(7);
  });

  it("shows 2 to 4 launches side by side, from a,b or the repeated parameter", async () => {
    expect(compareOf(await open({ compare: "team-spaces,offline-mode" }))?.map((c) => c.id)).toEqual(["team-spaces", "offline-mode"]);
    const four = compareOf(await open({ compare: ["team-spaces", "offline-mode", "weekly-digest", "calendar-sync"] }));
    expect(four?.map((c) => c.id)).toEqual(["team-spaces", "offline-mode", "weekly-digest", "calendar-sync"]);
  });

  it("ignores other values and shows the list", async () => {
    for (const compare of ["team-spaces", "a,b,c,d,e", "team-spaces,bad/id", ["team-spaces", "team-spaces"]]) {
      const els = await open({ compare });
      expect(compareOf(els), String(compare)).toBeUndefined();
      expect(rowIds(els)).toHaveLength(7);
    }
  });

  it("leaves out another brand's launch and Just a list, and shows the list when fewer than two are left", async () => {
    const cols = compareOf(await open({ compare: "team-spaces,their-idea,product-updates,offline-mode" }));
    expect(cols?.map((c) => c.id)).toEqual(["team-spaces", "offline-mode"]);
    const els = await open({ compare: "team-spaces,their-idea" });
    expect(compareOf(els)).toBeUndefined();
    expect(rowIds(els)).not.toContain("their-idea");
  });

  it("is today's list with LAUNCH_IDEAS_ENABLED off: no boxes, no filter, no compare", async () => {
    vi.stubEnv("LAUNCH_IDEAS_ENABLED", "false");
    const els = await open({ compare: "team-spaces,offline-mode", idea: "testing" });
    expect(compareOf(els)).toBeUndefined();
    expect(rowIds(els)).toHaveLength(7);
    expect(boxes(els)).toEqual([]);
    expect(els.some((e) => e.type === "form")).toBe(false);
  });

  it("tells a member only admins set an idea", async () => {
    state.ctx = { ...admin, userId: "usr_sam", role: "member" };
    const note = (await open()).find((e) => e.props.role === "note");
    expect(String(note?.props.children)).toContain("Only admins set a launch's hypothesis, status and outcome.");
  });
});

describe("the list's words", () => {
  /** Every string the page writes itself, components left unrendered. */
  const words = (els: El[]) =>
    els
      .flatMap((e) => (Array.isArray(e.props.children) ? e.props.children : [e.props.children]))
      .filter((c): c is string => typeof c === "string")
      .join(" | ");
  const wordsOn = () => {
    vi.stubEnv("NEXT_PUBLIC_NAV_V2_PHASE2_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_NAV_V2_PHASE3_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_NAV_IDEAS_ENABLED", "true");
  };

  it("say Ideas with the words on, and hand them to the compare table", async () => {
    wordsOn();
    const t = words(await open());
    expect(t).toContain("Ideas");
    expect(t).toContain("Each idea tests something with a waitlist before you build it.");
    expect(t).toContain("idea");
    // The status Launched and the made-up launch called old-launch aren't the word.
    expect(t.replace(/old-launch/g, "")).not.toMatch(/\blaunch(es|'s)?\b/i);
    const compare = (await open({ compare: "team-spaces,offline-mode" })).find((e) => e.type === CompareTable);
    expect(compare?.props.ideas).toBe(true);
  });

  it("say an idea's in the member note and the empty states", async () => {
    wordsOn();
    state.ctx = { ...admin, userId: "usr_sam", role: "member" };
    expect(words(await open())).toContain("Only admins set an idea's hypothesis, status and outcome.");
    expect(words(await open({ status: "archived" }))).toContain("No archived ideas.");
  });

  it("say Launches with the nav switch off, even with LAUNCH_IDEAS_ENABLED on", async () => {
    const t = words(await open());
    expect(t).toContain("Launches");
    expect(t).toContain("A launch is a waitlist page and the emails that keep it warm.");
    expect((await open({ compare: "team-spaces,offline-mode" })).find((e) => e.type === CompareTable)?.props.ideas).toBe(false);
  });
});
