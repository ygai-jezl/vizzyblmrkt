import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import type { ConnectionView, PartView } from "@/lib/connectors/service";
import { connectionView, NOW, textOf } from "./testing";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never),
}));
// The dialog's portal needs a browser; here every part of it draws in place.
vi.mock("@radix-ui/react-dialog", () => {
  const pass = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return { Root: pass, Portal: pass, Overlay: () => null, Content: pass, Title: ({ children }: { children?: ReactNode }) => createElement("h2", null, children), Close: () => null, Description: pass };
});
const { ConnectedView, StopUsingDialog } = await import("./ConnectedView");
const { connectedActions } = await import("./connectedActions");
const W = await import("./words");

// Stop using a part (Connectors 3): Harbour Blooms [made up] reads one Search Console site and one
// Google Analytics 4 property from Fernhill Group [made up]. Leo is Harbour Blooms' admin.
const part = (over: Partial<PartView> = {}): PartView => ({ organisation: "Fernhill Group", brand: "Harbour Blooms", reads: "live", since: null, keptIn: "Europe", region: "Europe", ended: null, ...over });
const collect = { lastDay: "2026-11-21", finalThrough: "2026-11-21", keptFrom: "2026-10-19", days: 34, keepDays: 90, filled: false, timeZone: "America/Los_Angeles", lag: "Search Console finishes a day 2 to 3 days later.", keeps: "Each day keeps the top 500 pages and the top 500 searches.", kept: null, waitingFor: null, failedSince: null, failedOn: null, holdReason: null, feedsPlanning: true };
const both = [
  { to: "members" as const, can: "read" as const },
  { to: "agent:vizzy" as const, can: "read" as const },
];
const SC = connectionView({
  id: "dcn_scscscscscscscscscsc",
  connectorId: "search-console",
  connectorName: "Google Search Console",
  label: "Google Search Console",
  part: part(),
  details: { method: "oauth_pkce", account: "sc-domain:harbourblooms.example", ownerUid: "usr_priya", secrets: [], grants: [{ to: "members", can: "read" }], collect },
});
const GA = connectionView({
  id: "dcn_gagagagagagagagagaga",
  connectorId: "google-analytics",
  connectorName: "Google Analytics 4",
  label: "Harbour Blooms web",
  part: part(),
  details: { method: "share_access", account: "properties/24680135", ownerUid: "usr_priya", secrets: [], grants: both, collect: { ...collect, feedsPlanning: true } },
});

const render = (p: Partial<Parameters<typeof ConnectedView>[0]> = {}) =>
  textOf(renderToStaticMarkup(createElement(ConnectedView, { connections: [SC], isAdmin: true, uid: "usr_leo", chat: true, collect: true, planning: true, now: NOW.toISOString(), ...p })));

describe("Stop using a part", () => {
  it("is on the part's Manage card, in place of Disconnect, saying what it deletes", () => {
    const text = render();
    expect(text).toContain("Check now Pause Stop using");
    expect(text).not.toContain("Disconnect");
    expect(text).toContain(W.PART_COPY.hintCollect);
    // Used for planning (members and Vizzy read it): its suggestions go too.
    expect(render({ connections: [GA] })).toContain(W.PART_COPY.hintPlanning);
    expect(render({ collect: false })).toContain(W.PART_COPY.hint);
    // With sharing off, a part offers nothing, Stop using included.
    expect(render({ connections: [{ ...SC, part: part({ reads: "off" }) }] })).not.toContain("Stop using");
  });

  it("asks first, naming the part, what is deleted and that the organisation's owners are told", () => {
    const text = textOf(renderToStaticMarkup(createElement(StopUsingDialog, { c: GA, collect: true, busy: false, onClose: () => {}, onConfirm: () => {} })));
    expect(text).toContain("Stop using Google Analytics 4");
    // Tags read as spaces here: the name is bold, then ", <part>".
    expect(text).toMatch(/Google Analytics 4 ?, Property 24680135 \(Harbour Blooms web\)/);
    expect(text).toContain("Harbour Blooms stops reading this property, and what YouGrow collected for it is deleted. Fernhill Group's owners are told.");
    expect(text).toMatch(/Cancel Stop using$/);
    const site = textOf(renderToStaticMarkup(createElement(StopUsingDialog, { c: SC, collect: false, busy: false, onClose: () => {}, onConfirm: () => {} })));
    expect(site).toMatch(/Google Search Console ?, sc-domain:harbourblooms\.example/);
    expect(site).toContain("Harbour Blooms stops reading this site, and what YouGrow stored for it is deleted.");
  });

  it("ends the part through Disconnect's route, leaves the panel empty and says the owners are told", async () => {
    const state = { list: [SC], selected: SC.id as string | null, note: null as unknown, calls: [] as string[], asked: 0, refreshed: 0 };
    const ended: ConnectionView = { ...SC, status: "disconnected", part: part({ reads: "ended", ended: { why: "stopped_using", at: NOW.toISOString() } }) };
    const answers: unknown[] = [{ ok: true, data: { connection: ended, message: "made-up" } }];
    const act = connectedActions({
      call: (async (url: string, init?: { method?: string }) => {
        state.calls.push(`${init?.method ?? "GET"} ${url}`);
        return answers.shift();
      }) as never,
      replace: (view) => (state.list = state.list.map((c) => (c.id === view.id ? view : c))),
      select: (id) => (state.selected = id),
      note: (n) => (state.note = n),
      confirm: () => (state.asked++, true),
      leave: () => {},
      push: () => {},
      refresh: () => state.refreshed++,
    });
    await act.stopUsing(SC);
    expect(state.calls).toEqual([`DELETE /api/admin/connectors/connections/${SC.id}`]);
    // The dialog asked already: no browser confirm.
    expect(state.asked).toBe(0);
    expect(state.list[0]!.status).toBe("disconnected");
    expect(state.selected).toBeNull();
    expect(state.note).toEqual({ tone: "ok", text: "Harbour Blooms stopped using Google Search Console from Fernhill Group. Fernhill Group's owners are told." });
  });

  it("says why when it is refused, and reads the connection again", async () => {
    const state = { note: null as unknown, calls: [] as string[] };
    const answers: unknown[] = [{ ok: false, status: 403, error: "forbidden", message: "Only admins can do that." }, { ok: true, data: SC }];
    const act = connectedActions({
      call: (async (url: string, init?: { method?: string }) => {
        state.calls.push(`${init?.method ?? "GET"} ${url}`);
        return answers.shift();
      }) as never,
      replace: () => {},
      select: () => {},
      note: (n) => (state.note = n),
      confirm: () => true,
      leave: () => {},
      push: () => {},
      refresh: () => {},
    });
    await act.stopUsing(SC);
    expect(state.note).toEqual({ tone: "err", text: "Only admins can do that." });
    expect(state.calls).toEqual([`DELETE /api/admin/connectors/connections/${SC.id}`, `GET /api/admin/connectors/connections/${SC.id}`]);
  });

  it("writes in house style", () => {
    const lines = [
      W.PART_COPY.stopUsing,
      W.PART_COPY.hint,
      W.PART_COPY.hintCollect,
      W.PART_COPY.hintPlanning,
      W.stopUsingTitleWords("Google Analytics 4"),
      W.stopUsingTextWords(GA, true),
      W.stopUsingTextWords({ ...GA, part: part({ organisation: null, brand: null }) }, false),
      W.stoppedUsingNoteWords(GA),
    ];
    for (const line of lines) {
      expect(dashesIn(line), line).toEqual([]);
      expect(aiTellsIn(line), line).toEqual([]);
    }
    expect(W.stopUsingTextWords({ ...GA, part: part({ organisation: null, brand: null }) }, false)).toBe("This brand stops reading this property, and what YouGrow stored for it is deleted. Your organisation's owners are told.");
  });
});
