import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { ACTIVITY_KINDS } from "@/lib/types/dataConnection";
import { CONNECTOR_ERRORS, tokenRefusedMessage } from "@/lib/connectors/messages";
import type { ConnectionView } from "@/lib/connectors/service";
import { connectionView, NOW, textOf } from "./testing";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never),
}));
const { ConnectedView, ConnectionRow, MANAGE_SCROLL_MARGIN, ROW_CLASS } = await import("./ConnectedView");
const {
  CONNECTED_COPY,
  accountWords,
  activityOf,
  activityWords,
  bannerWords,
  confirmDisconnectWords,
  connectionWords,
  firstSelected,
  healthLine,
  needsAttention,
  selectedOf,
  stateOf,
  whenWords,
  whoCanReadOf,
  whoWords,
  withGrant,
} = await import("./words");
const { connectedActions, revealManage, NARROW_SCREEN } = await import("./connectedActions");
const wordsModule = await import("./words");

const broken = (message: string) => ({ state: "broken" as const, lastOkAt: "2026-11-20T08:00:00.000Z", lastCheckedAt: "2026-11-21T09:12:00.000Z", message, pausedUntil: null });

// The made-up brand Acme: Search Console working and shared, Cloudflare's token turned down.
const SC = connectionView({
  id: "dcn_scscscscscscscscscsc",
  connectorId: "search-console",
  connectorName: "Google Search Console",
  label: "Google Search Console",
  details: {
    method: "oauth_pkce",
    account: "sc-domain:acme.example",
    grants: [
      { to: "members", can: "read" },
      { to: "agent:vizzy", can: "read" },
    ],
    recent: [
      { at: "2026-11-20T12:00:00.000Z", kind: "grants_changed", by: "usr_alex", code: "members,agent:vizzy" },
      { at: "2026-11-20T11:00:00.000Z", kind: "connected", by: "usr_alex", code: null },
    ],
  },
});
const REFUSED = tokenRefusedMessage("Cloudflare", "connected", true);
const CF = connectionView({
  health: broken(REFUSED),
  details: { recent: [{ at: "2026-11-21T09:12:00.000Z", kind: "failed", by: "system", code: "token_refused" }], ownerUid: "usr_sam" },
});

type Props = Parameters<typeof ConnectedView>[0];
const render = (p: Partial<Props> = {}) =>
  renderToStaticMarkup(createElement(ConnectedView, { connections: [SC, CF], isAdmin: true, uid: "usr_alex", chat: true, now: NOW.toISOString(), ...p }));

describe("Connected, for an admin", () => {
  it("puts a banner over each connection that needs something, with the way to fix it", () => {
    const html = render();
    const text = textOf(html);
    // The approved Connected screen's words, with nothing put before them.
    expect(text).toContain("Cloudflare turned the token down. Vizzy can't read it until you reconnect. Reconnect");
    expect(text).not.toContain("Cloudflare: Cloudflare");
    expect(html).toContain('href="/admin/account/connections/cloudflare?reconnect=dcn_aaaaaaaaaaaaaaaaaaaa"');
    expect(text.match(/Reconnect/g)).toHaveLength(1);
  });

  it("lists each connection: how, who connected, last activity, who can read it and its state", () => {
    const text = textOf(render());
    expect(text).toContain("Connection How Connected by Last activity Who can read Status");
    expect(text).toContain("Google Search Console acme.example (whole domain) Signed in with Google You You · 22 hours ago Admins, members, Vizzy Working");
    expect(text).toContain("Cloudflare Zone 012345…cdef API token Someone else YouGrow · 48 minutes ago Admins Needs attention");
  });

  it("opens the first row, as the approved screen, while another needs attention under its banner", () => {
    const html = render();
    const text = textOf(html);
    expect(text).toContain("Google Search Console · acme.example (whole domain) Working");
    expect(text).not.toContain(`Cloudflare · Zone 012345…cdef Needs attention ${REFUSED}`);
    expect(text).toContain(`${CONNECTED_COPY.grantsLead} ${CONNECTED_COPY.members} ${CONNECTED_COPY.vizzy}`);
    expect(text).toContain("Check now Pause Change property Disconnect");
    expect(text).toContain(CONNECTED_COPY.manageHint);
    // Search Console lets members and Vizzy read it, so both boxes are ticked.
    expect(html.match(/type="checkbox"[^>]*checked/g)).toHaveLength(2);
  });

  it("opens a connection needing attention when it is the first row, with who may read it, Check now, Pause and Disconnect", () => {
    const html = render({ connections: [CF, SC] });
    const text = textOf(html);
    expect(text).toContain(`Cloudflare · Zone 012345…cdef Needs attention ${REFUSED}`);
    expect(text).toContain("Check now Pause Disconnect");
    expect(html).not.toMatch(/type="checkbox"[^>]*checked/);
  });

  it("shows every connection's recent changes, newest first, kept 90 days", () => {
    const text = textOf(render());
    const at = (s: string) => text.indexOf(s);
    expect(at("Cloudflare check failed: the token was turned down YouGrow · 48 minutes ago")).toBeGreaterThan(0);
    expect(at("Members and Vizzy may read Google Search Console You · 22 hours ago")).toBeGreaterThan(at("Cloudflare check failed"));
    expect(at("Google Search Console connected by signing in with Google")).toBeGreaterThan(at("Members and Vizzy may read"));
    expect(text).toContain(CONNECTED_COPY.activityKept);
  });

  it("offers the Vizzy grant only while Vizzy reads connected data, and keeps it out of who can read", () => {
    const text = textOf(render({ chat: false }));
    expect(text).not.toContain(CONNECTED_COPY.vizzy);
    expect(text).toContain("Admins, members Working");
  });

  it("reconnects a sign in with Google, checks a shared address and sends a new one to the picker", () => {
    const oauth = connectionView({ id: "dcn_ooooooooooooooooooo2", connectorId: "search-console", connectorName: "Google Search Console", health: broken(CONNECTOR_ERRORS.signin_refused), details: { method: "oauth_pkce", account: "sc-domain:acme.example" } });
    const shared = connectionView({
      id: "dcn_shshshshshshshshshsh",
      connectorId: "google-analytics",
      connectorName: "Google Analytics",
      needsAccount: true,
      health: { state: "check", lastOkAt: null, lastCheckedAt: null, message: null, pausedUntil: null },
      details: { method: "share_access", account: "", serviceAccount: { email: "ygc-made-up@connect.example.iam.gserviceaccount.com", deletedAt: null } },
    });
    const html = render({ connections: [oauth, shared] });
    const text = textOf(html);
    expect(html).toMatch(/<button[^>]*>Reconnect<\/button>/);
    expect(text).toContain("Google Analytics is connected, but reads nothing until a property is chosen. Choose a property");
    expect(html).toContain('href="/admin/account/connections/google-analytics/pick?connection=dcn_shshshshshshshshshsh"');
    // The first row opens: the sign in.
    expect(text).toContain("Change property");
    const sharedOnly = textOf(render({ connections: [shared] }));
    expect(sharedOnly).toContain("Google address ygc-made-up@connect.example.iam.gserviceaccount.com Check access");
    expect(sharedOnly).not.toContain("Check now");
  });

  it("offers Resume while paused, and only Disconnect while the connector is off here", () => {
    const paused = connectionView({ health: { state: "paused", lastOkAt: null, lastCheckedAt: null, message: null, pausedUntil: null }, details: { pausedAt: "2026-11-21T09:00:00.000Z", pausedBy: "usr_alex" } });
    const text = textOf(render({ connections: [paused] }));
    expect(text).toContain(`Paused ${CONNECTED_COPY.pausedByAdmin}`);
    expect(text).toContain("Resume");
    const off = textOf(render({ connections: [connectionView({ connectorOn: false })] }));
    expect(off).toContain(`Turned off here ${CONNECTED_COPY.turnedOff}`);
    expect(off).not.toContain("Check now");
    expect(off).toContain("Disconnect");
  });

  it("says when nothing is connected, and links to Browse", () => {
    const html = render({ connections: [] });
    expect(textOf(html)).toContain(CONNECTED_COPY.none);
    expect(html).toContain('href="/admin/account/connections/browse"');
  });
});

describe("Connected's panel stays on the connection acted on", () => {
  type Answer = { ok: true; data: unknown } | { ok: false; status: number; error: string; message: string };
  const ok = (data: unknown): Answer => ({ ok: true, data });
  const healed = { ...CF, health: { ...CF.health, state: "ok" as const, message: null } };

  /** The page's state as the actions change it, with the routes answering from a list. */
  function page(list: ConnectionView[], answers: Answer[], confirmed = true, signedIn: Answer = ok({ url: "https://accounts.google.com/made-up" })) {
    const state = { list: [...list], selected: firstSelected(list), note: null as unknown, pushed: [] as string[], asked: [] as string[], calls: [] as string[], refreshed: 0 };
    const act = connectedActions({
      call: (async (url: string, init?: { method?: string }) => {
        state.calls.push(`${init?.method ?? "GET"} ${url}`);
        return answers.shift()!;
      }) as never,
      signIn: (async () => signedIn) as never,
      replace: (view) => (state.list = state.list.map((c) => (c.id === view.id ? view : c))),
      select: (id) => (state.selected = id),
      note: (n) => (state.note = n),
      confirm: (message) => (state.asked.push(message), confirmed),
      leave: () => {},
      push: (path) => state.pushed.push(path),
      refresh: () => state.refreshed++,
    });
    const shown = () => selectedOf(state.list, state.selected)?.id ?? null;
    return { state, act, shown };
  }

  it("selects the first shown connection explicitly when the page is drawn", () => {
    // The first row, though Cloudflare needs attention: as the approved Connected screen.
    expect(firstSelected([SC, CF])).toBe(SC.id);
    expect(firstSelected([CF, SC])).toBe(CF.id);
    expect(firstSelected([{ ...SC, status: "disconnected" }, CF])).toBe(CF.id);
    expect(firstSelected([SC])).toBe(SC.id);
    expect(firstSelected([{ ...SC, status: "disconnected" }])).toBeNull();
    expect(selectedOf([SC, CF], null)).toBeNull();
    expect(selectedOf([SC, { ...CF, status: "disconnected" }], CF.id)).toBeNull();
  });

  it("stays on Cloudflare after Check now fixes it, though the old fallback would have opened Search Console", async () => {
    const p = page([SC, CF], [ok({ connection: healed, check: { ok: true, message: null } })]);
    // The admin opens Cloudflare, which needs attention.
    p.state.selected = CF.id;
    expect(p.shown()).toBe(CF.id);
    await p.act.check(CF);
    expect(p.shown()).toBe(CF.id);
    // Nothing needs attention now, so a panel worked out from state would have jumped to the first row.
    expect(needsAttention(p.state.list)).toEqual([]);
    expect(p.state.list[0]!.id).toBe(SC.id);
    expect(p.state.note).toEqual({ tone: "ok", text: CONNECTED_COPY.checkedOk });
  });

  it("stays on the one acted on through Pause, Resume and a grant change, while another needs attention", async () => {
    const paused = { ...SC, health: { ...SC.health, state: "paused" as const }, details: { ...SC.details!, pausedAt: "2026-11-21T10:00:00.000Z", pausedBy: "usr_alex" } };
    const p = page([SC, CF], [ok(paused), ok(SC), ok({ ...SC, details: { ...SC.details!, grants: [] } })]);
    // The admin picks Search Console; Cloudflare still needs attention.
    p.state.selected = SC.id;
    await p.act.pause(SC, true);
    expect(p.shown()).toBe(SC.id);
    await p.act.pause(paused, false);
    expect(p.shown()).toBe(SC.id);
    await p.act.grant(SC, "members", false);
    expect(p.shown()).toBe(SC.id);
    expect(p.state.calls).toEqual([
      `POST /api/admin/connectors/connections/${SC.id}/pause`,
      `POST /api/admin/connectors/connections/${SC.id}/pause`,
      `PUT /api/admin/connectors/connections/${SC.id}/grants`,
    ]);
  });

  it("moves to a connection acted on from its banner, and stays when the action is refused", async () => {
    const p = page([SC, CF], [{ ok: false, status: 409, error: "paused", message: CONNECTOR_ERRORS.paused }, ok(CF)]);
    p.state.selected = SC.id;
    await p.act.check(CF);
    expect(p.shown()).toBe(CF.id);
    expect(p.state.note).toEqual({ tone: "warn", text: CONNECTOR_ERRORS.paused });
  });

  it("shows what a refused Check now found at once: the row's state and health line change without a reload", async () => {
    // Search Console works when the page is drawn; Check now answers 409 because its saved sign in no longer opens.
    const refusal = { ok: false as const, status: 409, error: "secret_unopenable", message: CONNECTOR_ERRORS.secret_unopenable };
    const found = { ...SC, health: { ...SC.health, state: "broken" as const, message: CONNECTOR_ERRORS.secret_unopenable } };
    const p = page([SC, CF], [refusal, ok(found)]);
    expect(stateOf(p.state.list[0]!).label).toBe("Working");
    await p.act.check(SC);
    expect(p.state.calls).toEqual([`POST /api/admin/connectors/connections/${SC.id}/check`, `GET /api/admin/connectors/connections/${SC.id}`]);
    expect(p.state.note).toEqual({ tone: "warn", text: CONNECTOR_ERRORS.secret_unopenable });
    expect(stateOf(p.state.list[0]!).label).toBe("Needs attention");
    expect(healthLine(p.state.list[0]!, NOW)).toBe(CONNECTOR_ERRORS.secret_unopenable);
    expect(needsAttention(p.state.list).map((c) => c.id)).toEqual([SC.id, CF.id]);
    expect(p.shown()).toBe(SC.id);
    expect(p.state.refreshed).toBe(0);
  });

  it("reads the connection again after every refused action, and the whole list when that read fails too", async () => {
    const no = (status: number, error: string) => ({ ok: false as const, status, error, message: `Refused: ${error}.` });
    const runs: Array<[string, (p: ReturnType<typeof page>) => Promise<void>, Answer | null]> = [
      ["check", (p) => p.act.check(CF), no(409, "paused")],
      ["checkAccess", (p) => p.act.checkAccess(CF), no(409, "share_pending")],
      ["pause", (p) => p.act.pause(CF, true), no(502, "error")],
      ["grant", (p) => p.act.grant(CF, "members", true), no(403, "forbidden")],
      ["disconnect", (p) => p.act.disconnect(CF), no(502, "error")],
      ["reconnect", (p) => p.act.reconnect(CF), null],
    ];
    for (const [name, run, answer] of runs) {
      const now = { ...CF, health: { ...CF.health, state: "paused" as const } };
      const p = page([SC, CF], answer ? [answer, ok(now)] : [ok(now)], true, no(503, "signin_unconfigured"));
      await run(p);
      expect(p.state.calls.at(-1), name).toBe(`GET /api/admin/connectors/connections/${CF.id}`);
      expect(p.state.list[1], name).toEqual(now);
      expect((p.state.note as { text: string }).text, name).toMatch(/^Refused: /);
      // The connection's own read refused too, say because it was disconnected elsewhere: the whole list.
      const gone = page([SC, CF], answer ? [answer, no(404, "not_found")] : [no(404, "not_found")], true, no(503, "signin_unconfigured"));
      await run(gone);
      expect(gone.state.refreshed, name).toBe(1);
      expect(gone.state.list, name).toEqual([SC, CF]);
    }
  });

  it("selects nothing after a Disconnect, says which went, and changes nothing when the admin says no", async () => {
    // Connected after Check, named by the zone picked from the list.
    const named = { ...CF, label: "acme.example" };
    const gone = { ...named, status: "disconnected" as const };
    const message = "Disconnecting deletes the token YouGrow keeps. Delete it in Cloudflare too.";
    const p = page([SC, named], [ok({ connection: gone, message })]);
    await p.act.disconnect(named);
    expect(p.state.asked).toEqual([`Disconnect Cloudflare for acme.example? ${CONNECTED_COPY.confirmDisconnect}`]);
    expect(p.state.selected).toBeNull();
    expect(p.shown()).toBeNull();
    expect(p.state.note).toEqual({ tone: "ok", text: `Cloudflare for acme.example is disconnected. ${message}` });
    const no = page([SC, CF], [], false);
    no.state.selected = CF.id;
    await no.act.disconnect(CF);
    expect(no.state.calls).toEqual([]);
    expect(no.shown()).toBe(CF.id);
  });

  it("names the connection a Disconnect asks about by its connector and what it reads", () => {
    expect(confirmDisconnectWords({ ...CF, label: "acme.example" })).toBe("Disconnect Cloudflare for acme.example? YouGrow deletes what it stored for it, and it reads nothing more.");
    expect(connectionWords(SC)).toBe("Google Search Console for acme.example (whole domain)");
    expect(connectionWords(CF)).toBe("Cloudflare for Zone 012345…cdef");
    expect(connectionWords(connectionView({ connectorName: "Google Analytics 4", label: "Google Analytics 4", needsAccount: true, details: { account: "" } }))).toBe("Google Analytics 4");
    expect(textOf(render({ connections: [{ ...CF, label: "acme.example" }] }))).toContain("Cloudflare · acme.example Needs attention");
  });
});

type ElProps = { children?: ReactNode; onClick?: () => void; [k: string]: unknown };

/** The elements from the root down to the first one that matches, as a click would pass through them. */
function pathTo(node: ReactNode, match: (el: ReactElement<ElProps>) => boolean): Array<ReactElement<ElProps>> | null {
  if (Array.isArray(node)) {
    for (const n of node) {
      const found = pathTo(n, match);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement<ElProps>(node)) return null;
  if (match(node)) return [node];
  const below = pathTo(node.props.children, match);
  return below ? [node, ...below] : null;
}

/** A click on the matching element: each handler from it up to the row runs, as the browser bubbles it. */
function clickOn(tree: ReactNode, match: (el: ReactElement<ElProps>) => boolean) {
  const path = pathTo(tree, match);
  if (!path) throw new Error("nothing to click");
  for (const el of [...path].reverse()) el.props.onClick?.();
}

describe("Connected's rows pick the connection", () => {
  const row = (c: ConnectionView, over: { isAdmin?: boolean; on?: boolean } = {}) => {
    const picked: string[] = [];
    const tree = ConnectionRow({ c, isAdmin: over.isAdmin ?? true, on: over.on ?? false, uid: "usr_alex", chat: true, now: NOW, onPick: (id) => picked.push(id) });
    return { tree, picked };
  };
  const isButton = (el: ReactElement<ElProps>) => el.type === "button";
  const isCell = (el: ReactElement<ElProps>) => el.type === "td";

  it("picks the connection from a click anywhere on its row, or its name's button, once each time", () => {
    const { tree, picked } = row(CF);
    clickOn(tree, isCell);
    expect(picked).toEqual([CF.id]);
    // Enter or Space on the name's button is a click on it: the row hears it once, never twice.
    clickOn(tree, isButton);
    expect(picked).toEqual([CF.id, CF.id]);
    expect(pathTo(tree, isButton)!.at(-1)!.props.onClick).toBeUndefined();
  });

  it("marks the picked row for admins: selected, tinted with an accent bar in light and dark, and its name pressed", () => {
    const html = render();
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html.match(/aria-selected="false"/g)).toHaveLength(1);
    expect(html).toContain(`<tr class="${ROW_CLASS.picked}" aria-selected="true"><td class="border-b border-neutral-100 px-3 py-2.5 align-top dark:border-neutral-900 ${ROW_CLASS.bar}">`);
    expect(html).toContain(`<tr class="${ROW_CLASS.pickable}" aria-selected="false">`);
    expect(html).toMatch(/aria-pressed="true">Google Search Console<\/button>/);
    expect(html).toMatch(/aria-pressed="false">Cloudflare<\/button>/);
    // A clear tint and bar in both themes, and a pointer with a hover on the rows not picked.
    expect(ROW_CLASS.picked).toMatch(/\bbg-blue-100\/70\b.*dark:bg-blue-900\/40/);
    // Not the hover grey: a picked row reads differently from a hovered one in dark mode too.
    expect(ROW_CLASS.picked).not.toContain("neutral");
    expect(ROW_CLASS.bar).toMatch(/shadow-\[inset_3px_0_0_#2563eb\].*dark:shadow-\[inset_3px_0_0_#3b82f6\]/);
    expect(ROW_CLASS.pickable).toMatch(/cursor-pointer.*hover:bg-neutral-50.*dark:hover:bg-neutral-900/);
    // Opening Cloudflare first moves the mark with it.
    const first = render({ connections: [CF, SC] });
    expect(first).toContain(`<tr class="${ROW_CLASS.picked}" aria-selected="true"><td class="border-b border-neutral-100 px-3 py-2.5 align-top dark:border-neutral-900 ${ROW_CLASS.bar}">`);
    expect(first).toMatch(/<tr class="[^"]*" aria-selected="true">(?:(?!<\/tr>).)*aria-pressed="true">Cloudflare<\/button>/);
  });

  it("puts each connector's mark beside its name in the rows and the Manage card, or its letters when it has none", () => {
    const html = render();
    const row = (name: string) => html.match(new RegExp(`<tr [^>]*>(?:(?!</tr>).)*>${name}</button>`))![0];
    expect(row("Google Search Console")).toContain('<img src="/marks/connectors/search-console/icon.png" alt=""');
    expect(row("Cloudflare")).toContain('<img src="/marks/connectors/cloudflare/icon.png" alt=""');
    const manage = html.match(/<h3 id="manage-title"[^>]*>((?:(?!<\/h3>).)*)<\/h3>/)![1]!;
    expect(manage).toContain('<img src="/marks/connectors/search-console/icon.png" alt=""');
    expect(textOf(manage)).toBe("Google Search Console · acme.example (whole domain)");
    // A connector this build no longer knows keeps a tile of letters, and members see the marks too.
    const gone = textOf(render({ connections: [connectionView({ connectorId: "old-tool", connectorName: "Old Tool", label: "Old Tool", connectorIcon: undefined })] }));
    expect(gone).toContain("OT Old Tool");
    expect(render({ isAdmin: false, connections: [{ ...SC, details: undefined }] })).toContain('<img src="/marks/connectors/search-console/icon.png" alt=""');
  });

  it("gives a member's rows nothing to pick", () => {
    const html = render({ isAdmin: false, connections: [{ ...SC, details: undefined }] });
    expect(html).not.toContain("aria-selected");
    expect(html).not.toContain("cursor-pointer");
    const { tree, picked } = row({ ...SC, details: undefined }, { isAdmin: false });
    expect(tree.props.onClick).toBeUndefined();
    expect(picked).toEqual([]);
  });

  it("brings the Manage card into view after a pick on a narrow screen only, without motion when asked", () => {
    const scrolled: unknown[] = [];
    const card = { scrollIntoView: (o?: unknown) => void scrolled.push(o) } as Pick<HTMLElement, "scrollIntoView">;
    const screen = (narrow: boolean, still = false) => ({
      matchMedia: (q: string) => ({ matches: q === NARROW_SCREEN ? narrow : q === "(prefers-reduced-motion: reduce)" ? still : false }),
    });
    expect(revealManage(card, screen(false))).toBe(false);
    expect(scrolled).toEqual([]);
    expect(revealManage(card, screen(true))).toBe(true);
    expect(revealManage(card, screen(true, true))).toBe(true);
    expect(scrolled).toEqual([
      { behavior: "smooth", block: "start" },
      { behavior: "auto", block: "start" },
    ]);
    // No card drawn (nothing picked yet, or a member): nothing to scroll to.
    expect(revealManage(null, screen(true))).toBe(false);
    expect(NARROW_SCREEN).toBe("(max-width: 767px)");
    // The card stops below the sticky admin header (48px), so its heading isn't hidden behind it.
    expect(MANAGE_SCROLL_MARGIN).toBe("scroll-mt-16");
    expect(render()).toMatch(/<section aria-labelledby="manage-title" class="[^"]*\bscroll-mt-16\b/);
  });
});

describe("Connected, for a member", () => {
  it("shows names and states, whether they can read each, and nothing to press", () => {
    const html = render({ isAdmin: false, connections: [{ ...SC, details: undefined }, { ...CF, details: undefined, canReadLive: false }] });
    const text = textOf(html);
    expect(text).toContain(`${REFUSED} ${CONNECTED_COPY.askAdmin}`);
    expect(text).toContain("Connection Reading Status");
    expect(text).toContain("Google Search Console You can read it Working");
    expect(text).toContain("Cloudflare Admins only Needs attention");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<input");
    expect(text).not.toContain(CONNECTED_COPY.activity);
  });
});

describe("Connected's words", () => {
  it("name every activity kind, the way each connected, and who did it", () => {
    for (const kind of ACTIVITY_KINDS) {
      const line = activityWords({ kind, code: null }, "Cloudflare", "token_fields");
      expect(line, kind).not.toBe("Cloudflare changed");
      expect(dashesIn(line)).toEqual([]);
      expect(aiTellsIn(line)).toEqual([]);
    }
    expect(activityWords({ kind: "connected", code: "signed_in_again" }, "Google Analytics", "oauth_pkce")).toBe("Google Analytics signed in again");
    expect(activityWords({ kind: "connected", code: null }, "Google Analytics", "share_access")).toBe("Google Analytics connected by sharing access");
    expect(activityWords({ kind: "grants_changed", code: "none" }, "Cloudflare", "token_fields")).toBe("Only admins may read Cloudflare");
    expect(activityWords({ kind: "paused", code: "rate_limited" }, "Cloudflare", "token_fields")).toBe("Calls to Cloudflare paused for a while: the provider asked YouGrow to slow down");
    expect(activityWords({ kind: "access_checked", code: "ok" }, "Google Analytics", "share_access")).toBe("Access checked: Google Analytics can see the property");
    expect(whoWords("usr_alex", "usr_alex")).toBe("You");
    expect(whoWords("agent:vizzy", "usr_alex")).toBe("Vizzy");
    expect(whoWords("usr_sam", "usr_alex")).toBe("An admin");
    expect(activityOf([{ ...CF, details: { ...CF.details!, recent: [{ at: "2026-11-21T09:00:00.000Z", kind: "purged", by: "ops-label", code: null }] } }])[0]!.by).toBe("operator");
  });

  it("put the tool's name before a banner's message only when the message doesn't say it", () => {
    expect(bannerWords(CF)).toBe(REFUSED);
    expect(bannerWords({ ...CF, health: { ...CF.health, message: CONNECTOR_ERRORS.account_refused } })).toBe(`Cloudflare: ${CONNECTOR_ERRORS.account_refused}`);
    expect(bannerWords({ ...SC, needsAccount: true })).toBe("Google Search Console is connected, but reads nothing until a property is chosen.");
  });

  it("say which connection a banner or an activity line is about when two connect to the same tool", () => {
    const acme = { ...CF, label: "acme.example", details: { ...CF.details!, recent: [{ at: "2026-11-21T09:30:00.000Z", kind: "paused" as const, by: "usr_alex", code: null }] } };
    const shop = connectionView({
      id: "dcn_bbbbbbbbbbbbbbbbbbbb",
      label: "shop.acme.example",
      details: { account: "fedcba9876543210fedcba9876543210", recent: [{ at: "2026-11-21T09:20:00.000Z", kind: "verified", by: "system", code: null }] },
    });
    const all = [SC, acme, shop];
    expect(bannerWords(acme, all)).toBe("Cloudflare for acme.example turned the token down. Vizzy can't read it until you reconnect.");
    expect(bannerWords({ ...acme, health: { ...acme.health, message: CONNECTOR_ERRORS.account_refused } }, all)).toBe(`Cloudflare for acme.example: ${CONNECTOR_ERRORS.account_refused}`);
    expect(activityOf(all).map((r) => r.text).slice(0, 2)).toEqual(["Cloudflare for acme.example paused", "Cloudflare for shop.acme.example checked: working"]);
    // One connection to a tool keeps the tool's name alone, as the approved screen.
    expect(bannerWords(acme, [SC, acme])).toBe(REFUSED);
    expect(activityOf([SC, acme])[0]!.text).toBe("Cloudflare paused");
    // A disconnected one still in the list counts too, so the lines it left say which.
    expect(activityOf([acme, { ...shop, status: "disconnected" }])[0]!.text).toBe("Cloudflare for acme.example paused");
    const text = textOf(render({ connections: all }));
    expect(text).toContain("Cloudflare for acme.example turned the token down. Vizzy can't read it until you reconnect.");
    expect(text).toContain("Cloudflare for acme.example paused");
    expect(text).toContain("Cloudflare for shop.acme.example checked: working");
    expect(text).not.toContain("Google Search Console for");
  });

  it("write moments, accounts, states and grants plainly", () => {
    expect(whenWords("2026-11-21T09:59:40.000Z", NOW)).toBe("just now");
    expect(whenWords("2026-11-21T09:59:00.000Z", NOW)).toBe("1 minute ago");
    expect(whenWords("2026-11-21T07:00:00.000Z", NOW)).toBe("3 hours ago");
    expect(whenWords("2026-11-20T08:00:00.000Z", NOW)).toBe("yesterday");
    expect(whenWords("2026-11-02T08:00:00.000Z", NOW)).toBe("2 Nov 2026");
    expect(accountWords("https://shop.acme.example/")).toBe("https://shop.acme.example/");
    expect(accountWords("properties/123456")).toBe("Property 123456");
    expect(accountWords("")).toBe("No property chosen yet");
    expect(stateOf({ ...CF, status: "disconnected" }).label).toBe("Disconnected");
    expect(stateOf({ ...CF, health: { ...CF.health, state: "check" } }).label).toBe("Check failed");
    expect(whoCanReadOf(SC, true)).toBe("Admins, members, Vizzy");
    expect(whoCanReadOf({ details: undefined }, true)).toBe("Admins");
    expect(withGrant([{ to: "agent:vizzy", can: "read" }], "members", true)).toEqual([
      { to: "agent:vizzy", can: "read" },
      { to: "members", can: "read" },
    ]);
    expect(withGrant(SC.details!.grants, "members", false)).toEqual([{ to: "agent:vizzy", can: "read" }]);
  });

  it("say how long a pause after a provider's limit has left", () => {
    const line = healthLine(
      connectionView({ health: { state: "paused", lastOkAt: null, lastCheckedAt: null, message: CONNECTOR_ERRORS.rate_limited, pausedUntil: "2026-11-21T10:14:10.000Z" } }),
      NOW,
    );
    expect(line).toBe(`${CONNECTOR_ERRORS.rate_limited} Calls start again by themselves in about 15 minutes.`);
    expect(healthLine(connectionView(), NOW)).toBe("Last worked 1 hour ago.");
  });

  it("write in house style", () => {
    for (const line of Object.values(CONNECTED_COPY)) {
      expect(dashesIn(line), line).toEqual([]);
      expect(aiTellsIn(line), line).toEqual([]);
    }
  });
});

describe("Connected as people read it", () => {
  it("writes in house style for an admin and a member", () => {
    for (const page of [render(), render({ chat: false }), render({ isAdmin: false, connections: [{ ...CF, details: undefined }] }), render({ connections: [] })]) {
      const text = textOf(page);
      expect(dashesIn(text), text.slice(0, 80)).toEqual([]);
      expect(aiTellsIn(text), text.slice(0, 80)).toEqual([]);
    }
  });
});

describe("collected numbers on Connected", () => {
  const { COLLECTED_COPY, collectedCell, collectedLines, manageHintOf, readingWords } = wordsModule;
  const collect = (over: Partial<NonNullable<NonNullable<ConnectionView["details"]>["collect"]>> = {}) => ({
    lastDay: "2026-11-20",
    finalThrough: "2026-11-20",
    keptFrom: "2026-08-23",
    days: 90,
    keepDays: 90,
    filled: true,
    timeZone: "America/Los_Angeles",
    lag: "Search Console finishes a day 2 to 3 days later.",
    keeps: "Each day keeps the top 500 pages and the top 500 searches.",
    kept: { day: "2026-11-20", by: "topic", seen: 1000, rows: 500, more: true },
    waitingFor: "2026-11-21",
    failedSince: null,
    failedOn: null,
    holdReason: null,
    feedsPlanning: true,
    ...over,
  });
  const site = (over: Parameters<typeof collect>[0] = {}, details: Partial<NonNullable<ConnectionView["details"]>> = {}, rest: Partial<ConnectionView> = {}) =>
    ({ ...SC, ...rest, details: { ...SC.details!, collect: collect(over), ...details } }) as ConnectionView;

  it("says how far it is collected, how far final, and when a day is late", () => {
    expect(collectedCell(site())).toEqual({ main: "To 20 Nov, 90 days", hint: "Waiting for Search Console to finish 21 Nov.", progress: null });
    expect(collectedCell(site({ lastDay: "2026-11-21", finalThrough: "2026-11-15", waitingFor: null }))?.main).toBe("To 21 Nov (final to 15 Nov), 90 days");
    expect(collectedCell(site({ filled: false, days: 34, keptFrom: "2026-10-18" }))).toEqual({ main: "Filling 90 days: 34 of 90", hint: null, progress: { value: 34, max: 90 } });
    expect(collectedCell(site({}, { pausedAt: "2026-11-12T10:00:00.000Z" }))).toMatchObject({ main: "Paused on 12 Nov", hint: "Collected to 20 Nov" });
    expect(collectedCell(site({ lastDay: "2026-11-18" }, {}, { health: { ...SC.health, state: "broken", since: "2026-11-19T09:00:00.000Z" } }))).toMatchObject({ main: "Stopped on 19 Nov", hint: "Collected to 18 Nov" });
    expect(collectedCell({ ...SC, details: { ...SC.details!, collect: null } })).toBeNull();
  });

  it("says Stopped only after 3 days of failing, and before that notes the failure beside the usual cell", () => {
    // The server sets failedOn for a failure under 3 days old, failedSince only after: Review's own rule.
    const recent = site({ failedOn: "2026-11-23T08:00:00.000Z", waitingFor: null });
    expect(collectedCell(recent)).toEqual({ main: "To 20 Nov, 90 days", hint: "Collecting failed on 23 Nov. YouGrow tries again on its own.", progress: null });
    expect(collectedLines(recent).map((l) => l.text)).toContain("Collecting failed on 23 Nov. YouGrow tries again on its own.");
    expect(collectedLines(recent).map((l) => l.text).join(" ")).not.toContain("Stopped");
    const long = site({ failedSince: "2026-11-19T08:00:00.000Z", waitingFor: null });
    expect(collectedCell(long)?.main).toBe("Stopped on 19 Nov");
  });

  it("doesn't ask for a Vizzy grant the copy can't give: suggestions need Vizzy to read connected data", () => {
    const membersOnly = site({}, { grants: [{ to: "members", can: "read" }] });
    const off = collectedLines(membersOnly, { planning: true, chat: false }).at(-1)!;
    expect(`${off.lead}${off.text}`).toBe("Used for planning: no. Suggestions need Vizzy to read connected data, which is off in this copy.");
    const on = collectedLines(membersOnly, { planning: true, chat: true }).at(-1)!;
    expect(on.text).toContain("Let Vizzy read it too");
  });

  it("writes the Manage card's block as the approved screen, the planning line only while numbers suggest articles", () => {
    const text = collectedLines(site()).map((l) => `${l.lead ?? ""}${l.text}`);
    expect(text).toEqual([
      "Collected to 20 Nov 2026, Pacific time. Search Console finishes a day 2 to 3 days later.",
      "Waiting for Search Console to finish 21 Nov.",
      "Kept: 23 Aug to 20 Nov (90 days).",
      "Each day keeps the top 500 pages and the top 500 searches. On 20 Nov Google listed at least 1,000 searches and 500 were kept.",
    ]);
    const planned = collectedLines(site(), { planning: true }).at(-1)!;
    expect(`${planned.lead}${planned.text}`).toBe("Used for planning: yes. Members and Vizzy can read it, so its numbers feed Next up, Review and the brand map.");
    const membersOnly = collectedLines(site({}, { grants: [{ to: "members", can: "read" }] }), { planning: true }).at(-1)!;
    expect(membersOnly.text).toBe(" no. Let Vizzy read it too, and its numbers will feed Next up, Review and the brand map.");
    const filling = collectedLines(site({ filled: false, days: 34, keptFrom: "2026-10-18", waitingFor: null }));
    expect(filling.map((l) => l.text)).toContain("Kept: 18 Oct to 20 Nov so far (34 of 90 days).");
    expect(filling.find((l) => l.progress)?.progress).toEqual({ value: 34, max: 90 });
    expect(filling.map((l) => l.text)).toContain(COLLECTED_COPY.restArrive);
    const paused = collectedLines(site({ lastDay: "2026-11-10" }, { pausedAt: "2026-11-12T10:00:00.000Z" })).map((l) => l.text);
    expect(paused.slice(0, 2)).toEqual(["Paused on 12 Nov. Nothing is collected until you resume.", "Collected to 10 Nov 2026, Pacific time."]);
    expect(paused).toContain("Each day still leaves after 90 days.");
  });

  it("says Disconnect deletes collected numbers, and the suggestions only while they make some", () => {
    expect(manageHintOf(site(), { collect: false })).toBe(CONNECTED_COPY.manageHint);
    expect(manageHintOf(site(), { collect: true })).toBe(COLLECTED_COPY.manageHint);
    expect(manageHintOf(site(), { collect: true, planning: true })).toBe(COLLECTED_COPY.manageHintPlanning);
    // Not used for planning (members or Vizzy can't read it): it made no suggestions to delete.
    for (const grants of [[], [{ to: "members" as const, can: "read" as const }], [{ to: "agent:vizzy" as const, can: "read" as const }]]) {
      expect(manageHintOf(site({}, { grants }), { collect: true, planning: true })).toBe(COLLECTED_COPY.manageHint);
    }
    expect(manageHintOf(site({ feedsPlanning: false }), { collect: true, planning: true })).toBe(COLLECTED_COPY.manageHint);
    expect(readingWords({ canReadLive: true, collectedTo: "2026-11-20" }, true)).toBe("You can read it, collected to 20 Nov");
    expect(readingWords({ canReadLive: true, collectedTo: "2026-11-20" }, false)).toBe("You can read it");
    expect(readingWords({ canReadLive: false, collectedTo: null }, true)).toBe("Admins only");
  });

  it("shows the Collected column and block only while collected numbers are on, and opens on the connection asked for", () => {
    const withCollect = site();
    const on = textOf(renderToStaticMarkup(createElement(ConnectedView, { connections: [CF, withCollect], isAdmin: true, uid: "usr_alex", chat: true, collect: true, selected: withCollect.id, now: NOW.toISOString() })));
    expect(on).toContain("Who can read Collected Status");
    expect(on).toContain("To 20 Nov, 90 days");
    expect(on).toContain("Collected numbers Collected to 20 Nov 2026, Pacific time.");
    expect(on).toContain(COLLECTED_COPY.manageHint);
    const off = textOf(renderToStaticMarkup(createElement(ConnectedView, { connections: [CF, withCollect], isAdmin: true, uid: "usr_alex", chat: true, now: NOW.toISOString() })));
    expect(off).not.toContain("Collected");
    expect(firstSelected([CF, withCollect], withCollect.id)).toBe(withCollect.id);
    expect(firstSelected([CF, withCollect], "dcn_zzzzzzzzzzzzzzzzzzzz")).toBe(CF.id);
    const member = textOf(renderToStaticMarkup(createElement(ConnectedView, { connections: [{ ...withCollect, details: undefined, collectedTo: "2026-11-20" }], isAdmin: false, uid: "usr_sam", chat: true, collect: true, now: NOW.toISOString() })));
    expect(member).toContain("You can read it, collected to 20 Nov");
    expect(member).not.toContain("Collected numbers");
  });

  it("writes every collected line in house style", () => {
    const all = [
      ...Object.values(COLLECTED_COPY),
      ...collectedLines(site(), { planning: true }).map((l) => l.text),
      ...collectedLines(site({ filled: false, days: 2 }), { planning: true }).map((l) => l.text),
    ];
    for (const text of all) {
      expect(dashesIn(text), text).toEqual([]);
      expect(aiTellsIn(text), text).toEqual([]);
    }
  });
});
