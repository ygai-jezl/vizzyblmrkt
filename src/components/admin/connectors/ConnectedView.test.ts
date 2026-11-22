import { createElement } from "react";
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
const { ConnectedView } = await import("./ConnectedView");
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
const { connectedActions } = await import("./connectedActions");

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
  function page(list: ConnectionView[], answers: Answer[], confirmed = true) {
    const state = { list: [...list], selected: firstSelected(list), note: null as unknown, pushed: [] as string[], asked: [] as string[], calls: [] as string[] };
    const act = connectedActions({
      call: (async (url: string, init?: { method?: string }) => {
        state.calls.push(`${init?.method ?? "GET"} ${url}`);
        return answers.shift()!;
      }) as never,
      signIn: async () => ({ ok: true, data: { url: "https://accounts.google.com/made-up" } }),
      replace: (view) => (state.list = state.list.map((c) => (c.id === view.id ? view : c))),
      select: (id) => (state.selected = id),
      note: (n) => (state.note = n),
      confirm: (message) => (state.asked.push(message), confirmed),
      leave: () => {},
      push: (path) => state.pushed.push(path),
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
    const p = page([SC, CF], [{ ok: false, status: 409, error: "paused", message: CONNECTOR_ERRORS.paused }]);
    p.state.selected = SC.id;
    await p.act.check(CF);
    expect(p.shown()).toBe(CF.id);
    expect(p.state.note).toEqual({ tone: "warn", text: CONNECTOR_ERRORS.paused });
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
