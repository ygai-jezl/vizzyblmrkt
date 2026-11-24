import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { CONNECTOR_ERRORS } from "@/lib/connectors/messages";
import type { ConnectionView, PartView } from "@/lib/connectors/service";
import { connectionView, NOW, textOf } from "./testing";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never),
}));
const { ConnectedView } = await import("./ConnectedView");
const W = await import("./words");

// A brand's parts from its organisation (Connectors 3), as the approved BrandConnected screens draw
// them: Fernhill US [made up], kept in the United States, reads Search Console and Google Analytics 4
// through Fernhill Group's sign ins, kept in Europe. Leo is its admin, Sam a member, Priya an owner.
const part = (over: Partial<PartView> = {}): PartView => ({ organisation: "Fernhill Group", brand: "Fernhill US", reads: "live", since: null, keptIn: "Europe", region: "United States", ended: null, ...over });
const broken = (since: string) => ({ state: "broken" as const, lastOkAt: "2026-11-20T08:00:00.000Z", lastCheckedAt: since, message: CONNECTOR_ERRORS.account_refused, pausedUntil: null, since });
const collect = (over: Record<string, unknown> = {}) => ({
  lastDay: "2026-11-21",
  finalThrough: "2026-11-21",
  keptFrom: "2026-10-19",
  days: 34,
  keepDays: 90,
  filled: false,
  timeZone: "America/Los_Angeles",
  lag: "Search Console finishes a day 2 to 3 days later.",
  keeps: "Each day keeps the top 500 pages and the top 500 searches.",
  kept: null,
  waitingFor: null,
  failedSince: null,
  failedOn: null,
  holdReason: null,
  feedsPlanning: true,
  ...over,
});
const SC = connectionView({
  id: "dcn_scscscscscscscscscsc",
  connectorId: "search-console",
  connectorName: "Google Search Console",
  label: "Google Search Console",
  part: part(),
  details: {
    method: "share_access",
    account: "sc-domain:fernhill-us.example",
    ownerUid: "usr_priya",
    secrets: [],
    grants: [{ to: "members", can: "read" }],
    recent: [
      { at: "2026-11-20T10:00:00.000Z", kind: "grants_changed", by: "usr_priya", code: "members" },
      { at: "2026-11-20T09:00:00.000Z", kind: "connected", by: "usr_priya", code: "part_given" },
    ],
    collect: collect(),
  },
});
const GA = connectionView({
  id: "dcn_gagagagagagagagagaga",
  connectorId: "google-analytics",
  connectorName: "Google Analytics 4",
  label: "Fernhill US web",
  part: part(),
  details: {
    method: "oauth_pkce",
    account: "properties/987654321",
    ownerUid: "usr_priya",
    secrets: [],
    grants: [],
    recent: [{ at: "2026-11-19T09:00:00.000Z", kind: "connected", by: "usr_priya", code: "part_given" }],
    collect: collect({ lastDay: "2026-11-23", finalThrough: "2026-11-21", keptFrom: "2026-08-26", days: 90, filled: true, timeZone: "America/New_York", lag: "Days after 21 Nov may still change a little.", feedsPlanning: true }),
  },
});
const OWN = connectionView({ id: "dcn_cfcfcfcfcfcfcfcfcfcf", details: { ownerUid: "usr_leo" } });

type Props = Parameters<typeof ConnectedView>[0];
const render = (p: Partial<Props> = {}) =>
  renderToStaticMarkup(createElement(ConnectedView, { connections: [GA, SC], isAdmin: true, uid: "usr_leo", chat: true, collect: true, planning: true, now: NOW.toISOString(), ...p }));
const sourceBroken = (c: ConnectionView): ConnectionView => ({ ...c, part: part({ reads: "source", since: "2026-11-21T07:00:00.000Z" }), health: { ...broken("2026-11-21T07:00:00.000Z"), message: CONNECTOR_ERRORS.source_broken } });

describe("a part from the organisation on Connected", () => {
  it("lists it From its organisation, like any connection", () => {
    const text = textOf(render());
    expect(text).toContain("Google Analytics 4 Fernhill US web Property 987654321 From Fernhill Group Someone else");
    expect(text).toContain("Google Search Console fernhill-us.example (whole domain) From Fernhill Group");
    expect(text).not.toContain("Shared access");
    expect(text).not.toContain("Signed in with Google");
  });

  it("opens the Manage card managed by the organisation, with both regions, readers, Check now and Pause, and nothing to change how it reads", () => {
    const html = render();
    const text = textOf(html);
    expect(text).toContain("Managed by Fernhill Group. Its owners can change it.");
    expect(text).toContain("Fernhill US keeps its numbers in the United States. The sign in stays in Europe.");
    expect(text).toContain(`${W.CONNECTED_COPY.grantsLead} ${W.CONNECTED_COPY.members} ${W.CONNECTED_COPY.vizzy}`);
    expect(text).toContain("Collected numbers Collected to 23 Nov 2026");
    expect(text).toContain("Check now Pause");
    // No picker, no address, no Check access, no Sign in again, no Disconnect: its owners manage those.
    for (const gone of ["Change property", "Choose a property", "Check access", W.CONNECTED_COPY.address, W.CONNECTED_COPY.reconnect, W.CONNECTED_COPY.disconnect]) {
      expect(text, gone).not.toContain(gone);
    }
    expect(html).not.toContain("/pick?connection=");
  });

  it("leaves out the region line when the brand keeps its numbers where the sign in stays", () => {
    const text = textOf(render({ connections: [{ ...GA, part: part({ region: "Europe" }) }] }));
    expect(text).toContain("Managed by Fernhill Group. Its owners can change it.");
    expect(text).not.toContain("keeps its numbers in");
  });

  it("names the organisation when its sign in needs attention, with Fix for an owner and nothing to press for anyone else", () => {
    const ga = sourceBroken(GA);
    const owner = render({ connections: [ga, SC], owner: true });
    const text = textOf(owner);
    expect(text).toContain("Google Analytics 4 comes from Fernhill Group, and its sign-in needs attention. An owner of Fernhill Group can fix it. Fix");
    expect(owner).toContain('href="/admin/account/organisation"');
    expect(text).toContain("Needs Fernhill Group");
    expect(text).toContain("Stopped on 21 Nov");
    const leo = textOf(render({ connections: [ga, SC] }));
    expect(leo).toContain("An owner of Fernhill Group can fix it.");
    expect(leo).not.toContain(" Fix");
    expect(leo).not.toContain(W.CONNECTED_COPY.reconnect);
    // A member reads the same, with no "ask an admin": an admin can't fix it either.
    const sam = textOf(render({ connections: [{ ...ga, details: undefined }], isAdmin: false, uid: "usr_sam", owner: true }));
    expect(sam).toContain("An owner of Fernhill Group can fix it.");
    expect(sam).not.toContain(W.CONNECTED_COPY.askAdmin);
    expect(sam).not.toContain(" Fix");
  });

  it("names the part it can't read, for its admins, and only that it can't, for its members", () => {
    const sc = { ...SC, health: broken("2026-11-22T06:00:00.000Z") };
    const text = textOf(render({ connections: [GA, sc] }));
    expect(text).toContain("Google Search Console: Can't read sc-domain:fernhill-us.example since 22 Nov. An owner of Fernhill Group can fix it.");
    const sam = textOf(render({ connections: [{ ...sc, details: undefined }], isAdmin: false, uid: "usr_sam" }));
    expect(sam).toContain("Google Search Console: It can't be read since 22 Nov. An owner of Fernhill Group can fix it.");
    expect(sam).not.toContain("fernhill-us.example");
  });

  it("with sharing off, reads nothing and offers nothing, and shows no banner", () => {
    const off = (c: ConnectionView): ConnectionView => ({ ...c, part: part({ reads: "off" }), canReadLive: false, details: { ...c.details!, collect: null } });
    const text = textOf(render({ connections: [off(GA), { ...off(SC), health: broken("2026-11-22T06:00:00.000Z") }] }));
    expect(text).toContain(`Turned off here ${CONNECTOR_ERRORS.sharing_off}`);
    expect(text.split(CONNECTOR_ERRORS.sharing_off).length).toBeGreaterThan(3);
    expect(text).toContain("Managed by Fernhill Group. Its owners can change it.");
    expect(text).not.toContain(W.CONNECTED_COPY.grantsLead);
    expect(text).not.toContain(W.CONNECTED_COPY.checkNow);
    expect(text).not.toContain("An owner of Fernhill Group can fix it.");
  });

  it("says a part its organisation no longer gives, or is still giving, reads nothing", () => {
    const text = textOf(render({ connections: [{ ...GA, part: part({ reads: "ended" }), canReadLive: false, details: { ...GA.details!, collect: null } }] }));
    expect(text).toContain(`Ended ${CONNECTOR_ERRORS.part_ended}`);
    expect(text).toContain(W.PART_COPY.readsNothing);
    const giving = textOf(render({ connections: [{ ...GA, part: part({ reads: "pending" }), canReadLive: false, details: { ...GA.details!, collect: null } }] }));
    expect(giving).toContain(`${W.PART_COPY.pending} ${W.PART_COPY.pendingLine}`);
    const sam = textOf(render({ connections: [{ ...GA, part: part({ reads: "ended" }), canReadLive: false, details: undefined }], isAdmin: false, uid: "usr_sam" }));
    expect(sam).toContain(`${W.PART_COPY.readsNothing} Ended`);
  });

  it("says its owners paused it, and only they resume it", () => {
    const text = textOf(render({ connections: [{ ...GA, part: part({ reads: "paused" }), health: { ...GA.health, state: "paused", message: CONNECTOR_ERRORS.source_paused } }] }));
    expect(text).toContain(`Paused ${CONNECTOR_ERRORS.source_paused}`);
    expect(text).toContain("Check now Pause");
    expect(text).not.toContain(W.CONNECTED_COPY.resume);
  });

  it("says the brand left its organisation once its parts ended, and words their activity", () => {
    const left = (c: ConnectionView, at: string): ConnectionView => ({
      ...c,
      status: "disconnected",
      part: part({ reads: "ended", ended: { why: "left", at } }),
      details: { ...c.details!, recent: [{ at: "2026-11-24T10:05:00.000Z", kind: "erased", by: "system", code: null }, { at, kind: "disconnected", by: "system", code: "left" }, ...c.details!.recent] },
    });
    const html = render({ connections: [left(GA, "2026-11-21T09:00:00.000Z"), left(SC, "2026-11-21T09:00:01.000Z")] });
    const text = textOf(html);
    expect(text.match(/Ended on 21 Nov: Fernhill US left Fernhill Group\./g)).toHaveLength(1);
    expect(text).toContain(W.CONNECTED_COPY.none);
    expect(text).toContain("Google Analytics 4 ended: Fernhill US left Fernhill Group YouGrow");
    expect(text).toContain("Google Analytics 4 given by Fernhill Group An admin");
    // The note goes after a week; the activity stays.
    const later = textOf(render({ connections: [left(GA, "2026-11-10T09:00:00.000Z")] }));
    expect(later).not.toContain("Ended on");
    expect(later).toContain("ended: Fernhill US left Fernhill Group");
  });

  it("keeps a brand's own connection as it is beside its parts", () => {
    const text = textOf(render({ connections: [OWN, GA], selected: OWN.id }));
    expect(text).toContain("Cloudflare Zone 012345…cdef API token You");
    expect(text).toContain("Check now Pause Disconnect");
    expect(text).toContain(W.CONNECTED_COPY.manageHint);
    expect(text).not.toContain("Managed by");
  });
});

describe("a part's words", () => {
  it("say each state, naming who can fix it", () => {
    expect(W.stateOf(sourceBroken(GA))).toEqual({ label: "Needs Fernhill Group", tone: "warn" });
    expect(W.stateOf({ ...GA, part: part({ reads: "off" }) })).toEqual({ label: "Turned off here", tone: "muted" });
    expect(W.stateOf({ ...GA, part: part({ organisation: null }), health: broken("2026-11-22T06:00:00.000Z") })).toEqual({ label: W.PART_COPY.needsOwner, tone: "warn" });
    expect(W.stateOf(GA)).toEqual({ label: "Working", tone: "ok" });
    expect(W.fromWords(null)).toBe("From your organisation");
    expect(W.managedWords(null)).toBe("Managed by your organisation. Its owners can change it.");
    expect(W.partSourceWords("Google Search Console", "Fernhill Group")).toBe("Search Console comes from Fernhill Group, and its sign-in needs attention. An owner of Fernhill Group can fix it.");
    expect(W.partRegionWords({ part: part({ region: "Europe", keptIn: "United States" }) })).toBe("Fernhill US keeps its numbers in Europe. The sign in stays in the United States.");
  });

  it("never offer a part's token for replacing on its Listing", () => {
    const cf = connectionView({ health: broken("2026-11-22T06:00:00.000Z") });
    expect(W.replaceableOf([cf], "cloudflare", cf.id)).toBe(cf);
    expect(W.replaceableOf([{ ...cf, part: part() }], "cloudflare", cf.id)).toBeNull();
  });

  it("word a part's own activity, and leave a brand's own as it was", () => {
    const names = { organisation: "Fernhill Group", brand: "Fernhill US" };
    expect(W.activityWords({ kind: "connected", code: "part_given" }, "Cloudflare", "token_fields", names)).toBe("Cloudflare given by Fernhill Group");
    expect(W.activityWords({ kind: "account_picked", code: "part_changed" }, "Cloudflare", "token_fields", names)).toBe("Cloudflare changed by Fernhill Group");
    expect(W.activityWords({ kind: "disconnected", code: "part_ended" }, "Cloudflare", "token_fields", names)).toBe("Cloudflare taken back by Fernhill Group");
    expect(W.activityWords({ kind: "disconnected", code: "stopped_using" }, "Cloudflare", "token_fields", names)).toBe("Stopped using Cloudflare");
    expect(W.activityWords({ kind: "disconnected", code: "disconnected" }, "Cloudflare", "token_fields", names)).toBe("Cloudflare ended: Fernhill Group disconnected it");
    expect(W.activityWords({ kind: "failed", code: "source_broken" }, "Cloudflare", "token_fields", names)).toBe("Cloudflare check failed: the sign-in at its organisation needs attention");
    expect(W.activityWords({ kind: "disconnected", code: null }, "Cloudflare", "token_fields")).toBe("Cloudflare disconnected");
  });

  it("write in house style", () => {
    const lines = [
      ...Object.values(W.PART_COPY),
      W.managedWords("Fernhill Group"),
      W.partSourceWords("Google Analytics 4", "Fernhill Group"),
      W.partCantReadWords({ ...SC, health: broken("2026-11-22T06:00:00.000Z") }),
      W.partRegionWords({ part: part() })!,
      W.endedLeftWords("21 Nov", "Fernhill US", "Fernhill Group"),
      textOf(render({ owner: true })),
      textOf(render({ connections: [sourceBroken(GA)], owner: true })),
    ];
    for (const line of lines) {
      expect(dashesIn(line), line).toEqual([]);
      expect(aiTellsIn(line), line).toEqual([]);
    }
  });
});
