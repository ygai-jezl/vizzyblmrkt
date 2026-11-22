import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { ACTIVITY_KINDS } from "@/lib/types/dataConnection";
import { CONNECTOR_ERRORS } from "@/lib/connectors/messages";
import { connectionView, NOW, textOf } from "./testing";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never),
}));
const { ConnectedView } = await import("./ConnectedView");
const { CONNECTED_COPY, accountWords, activityOf, activityWords, healthLine, stateOf, whenWords, whoCanReadOf, whoWords, withGrant } = await import("./words");

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
const CF = connectionView({
  health: broken(CONNECTOR_ERRORS.token_refused),
  details: { recent: [{ at: "2026-11-21T09:12:00.000Z", kind: "failed", by: "system", code: "token_refused" }], ownerUid: "usr_sam" },
});

type Props = Parameters<typeof ConnectedView>[0];
const render = (p: Partial<Props> = {}) =>
  renderToStaticMarkup(createElement(ConnectedView, { connections: [SC, CF], isAdmin: true, uid: "usr_alex", chat: true, now: NOW.toISOString(), ...p }));

describe("Connected, for an admin", () => {
  it("puts a banner over each connection that needs something, with the way to fix it", () => {
    const html = render();
    const text = textOf(html);
    expect(text).toContain(`Cloudflare: ${CONNECTOR_ERRORS.token_refused} Reconnect`);
    expect(html).toContain('href="/admin/account/connections/cloudflare?reconnect=dcn_aaaaaaaaaaaaaaaaaaaa"');
    expect(text.match(/Reconnect/g)).toHaveLength(1);
  });

  it("lists each connection: how, who connected, last activity, who can read it and its state", () => {
    const text = textOf(render());
    expect(text).toContain("Connection How Connected by Last activity Who can read Status");
    expect(text).toContain("Google Search Console acme.example (whole domain) Signed in with Google You You · 22 hours ago Admins, members, Vizzy Working");
    expect(text).toContain("Cloudflare Zone 012345…cdef API token Someone else YouGrow · 48 minutes ago Admins Needs attention");
  });

  it("opens the connection needing attention first, with who may read it, Check now, Pause and Disconnect", () => {
    const html = render();
    const text = textOf(html);
    expect(text).toContain(`Cloudflare · Zone 012345…cdef Needs attention ${CONNECTOR_ERRORS.token_refused}`);
    expect(text).toContain(`${CONNECTED_COPY.grantsLead} ${CONNECTED_COPY.members} ${CONNECTED_COPY.vizzy}`);
    expect(text).toContain("Check now Pause Disconnect");
    expect(text).toContain(CONNECTED_COPY.manageHint);
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
    // The first needing attention opens: the sign in.
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

describe("Connected, for a member", () => {
  it("shows names and states, whether they can read each, and nothing to press", () => {
    const html = render({ isAdmin: false, connections: [{ ...SC, details: undefined }, { ...CF, details: undefined, canReadLive: false }] });
    const text = textOf(html);
    expect(text).toContain(`Cloudflare: ${CONNECTOR_ERRORS.token_refused} ${CONNECTED_COPY.askAdmin}`);
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
