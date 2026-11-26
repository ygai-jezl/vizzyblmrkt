import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { ACTION_IDS, ASK_ACTION_IDS, PAGE_ACTION_IDS } from "@/lib/types/nextAction";
import { ASK_ACTIONS, PAGE_ACTIONS, actionSpec, allowedActions, resolveAction, type ActionEnv } from "./actions";

const SRC = join(process.cwd(), "src");

/** /admin/launches/[campaignId]/journey exists as src/app/admin/launches/[campaignId]/journey/page.tsx. */
function routeExists(href: string): boolean {
  const path = href.split(/[?#]/)[0]!;
  const dynamic = path.replace(/^\/admin\/launches\/[^/]+/, "/admin/launches/[campaignId]").replace(/^\/admin\/workspace\/[^/]+/, "/admin/workspace/[workspaceId]").replace(/^\/admin\/products\/[^/]+/, "/admin/products/[connectionId]");
  return existsSync(join(SRC, "app", dynamic, "page.tsx"));
}

const FULL: ActionEnv = {
  role: "admin",
  signals: { firstLaunchId: "lch_1", firstWorkspaceId: "ws_1", firstProductId: "pc_1", lifecycle: true, activeLaunches: 1 },
  areas: { emailStyle: true, brandMap: true, invites: true, about: true },
};
const EMPTY: ActionEnv = {
  role: "admin",
  signals: { firstLaunchId: null, firstWorkspaceId: null, firstProductId: null, lifecycle: false, activeLaunches: 0 },
  areas: { emailStyle: false, brandMap: false, invites: false, about: false },
};

describe("the next action allowlist", () => {
  it("names every id once, each with a spec, and nothing else", () => {
    expect(new Set(ACTION_IDS).size).toBe(ACTION_IDS.length);
    expect(Object.keys(PAGE_ACTIONS).sort()).toEqual([...PAGE_ACTION_IDS].sort());
    expect(Object.keys(ASK_ACTIONS).sort()).toEqual([...ASK_ACTION_IDS].sort());
  });

  it("opens only admin pages that exist, with everything on", () => {
    for (const id of PAGE_ACTION_IDS) {
      const r = resolveAction(id, FULL);
      expect(r?.kind, id).toBe("page");
      if (r?.kind !== "page") continue;
      expect(r.href, id).toMatch(/^\/admin/);
      expect(routeExists(r.href), `${id} opens ${r.href}, which has no page`).toBe(true);
    }
  });

  it("asks Vizzy only our own prompts, in house style", () => {
    for (const id of ASK_ACTION_IDS) {
      const r = resolveAction(id, FULL);
      expect(r, id).toEqual({ id, kind: "ask", prompt: ASK_ACTIONS[id].prompt });
    }
    for (const id of ACTION_IDS) {
      const spec = actionSpec(id);
      const words = [spec.label, spec.what, ...(id.startsWith("ask.") ? [ASK_ACTIONS[id as keyof typeof ASK_ACTIONS].prompt] : [])];
      for (const w of words) expect([...dashesIn(w), ...aiTellsIn(w)], `${id}: ${w}`).toEqual([]);
      expect(spec.label.length, id).toBeLessThanOrEqual(28);
    }
  });

  it("follows what the brand has switched on and what exists", () => {
    const empty = new Set(allowedActions(EMPTY));
    for (const id of ["page.welcome_email", "page.share_waitlist", "page.invite_waitlist", "page.knowledge", "page.schedule_post", "page.newsletter"]) {
      expect(empty.has(id as never), id).toBe(false);
    }
    for (const id of ["page.connect_product", "page.learn_product", "page.journeys", "page.email_style", "page.brand_map", "page.about"]) {
      expect(empty.has(id as never), id).toBe(false);
    }
    for (const id of ["ask.welcome_email", "ask.share_post"]) expect(empty.has(id as never), id).toBe(false);
    for (const id of ["page.create_launch", "page.sending", "page.start_programme", "ask.plan_idea", "ask.waitlist_page"]) expect(empty.has(id as never), id).toBe(true);
    // Invites need lifecycle as well as the invites switch.
    expect(resolveAction("page.invite_waitlist", { ...FULL, signals: { ...FULL.signals, lifecycle: false } })).toBeNull();
    expect(allowedActions(FULL)).toEqual([...PAGE_ACTION_IDS, ...ASK_ACTION_IDS]);
  });

  it("gives a member nothing: the card is for admins", () => {
    expect(allowedActions({ ...FULL, role: "member" })).toEqual([]);
    expect(allowedActions({ ...FULL, role: undefined })).toEqual([]);
    expect(resolveAction("page.review", { ...FULL, role: "member" })).toBeNull();
  });

  it("refuses an id off the list, a free URL and a free path", () => {
    for (const bad of [
      "https://evil.example.com",
      "//evil.example.com",
      "/admin/account",
      "/admin/../api/admin/brands",
      "javascript:alert(1)",
      "page.delete_brand",
      "ask.anything",
      "",
      null,
      42,
      { id: "page.review" },
      "__proto__",
      "constructor",
      "toString",
    ]) {
      expect(resolveAction(bad, FULL), String(bad)).toBeNull();
    }
  });

  it("never lets an id carry a stored record's id out of the path", () => {
    const odd: ActionEnv = { ...FULL, signals: { ...FULL.signals, firstLaunchId: "../../api/x?y=1#z", firstWorkspaceId: "a/b", firstProductId: "c d" } };
    for (const id of PAGE_ACTION_IDS) {
      const r = resolveAction(id, odd);
      if (r?.kind === "page") expect(r.href, id).toMatch(/^\/admin(?:\/[A-Za-z0-9_%-]+)*(?:\?tab=[a-z]+)?(?:#[a-z-]+)?$/);
    }
  });
});
