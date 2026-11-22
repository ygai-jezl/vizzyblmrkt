import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { connectionView, listingFor, textOf } from "./testing";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never),
}));
const { BrowseView } = await import("./BrowseView");
const { SCREEN_COPY, categoriesOf, connectorStatus, filterConnectors, initialsOf } = await import("./words");

const ALL = [listingFor("search-console", ["oauth_pkce", "share_access"]), listingFor("google-analytics", ["share_access"]), listingFor("cloudflare", ["token_fields"])];
const render = (props: Partial<Parameters<typeof BrowseView>[0]> = {}) =>
  renderToStaticMarkup(createElement(BrowseView, { connectors: ALL, connections: [], chat: false, ...props }));

describe("Browse", () => {
  it("shows a card per offered connector, linking to its Listing, with the ways to connect ready here", () => {
    const html = render();
    const text = textOf(html);
    expect(html).toContain('href="/admin/account/connections/search-console"');
    expect(html).toContain('href="/admin/account/connections/cloudflare"');
    expect(text).toContain("Google Search Console Search and analytics · Built by YouGrow");
    expect(text).toContain("Cloudflare Website and traffic · Built by YouGrow");
    expect(text).toContain("Ready Sign in with Google Share access");
    // GA4's Sign in isn't ready on this copy, so only share access shows.
    expect(text).toContain("Google Analytics Search and analytics · Built by YouGrow Sessions, users, views and key events for your site, read from Google Analytics 4 when you ask. Ready Share access");
    expect(text).toContain("Ready API token");
    expect(text).toContain(SCREEN_COPY.browseFoot);
    // The chips, in the order the connectors come, named as the approved Browse screen names them.
    expect(text).toContain("All Search and analytics Website and traffic");
  });

  it("leaves out a connector whose switch is off, because the list route never sends it", () => {
    const text = textOf(render({ connectors: [listingFor("cloudflare", ["token_fields"])] }));
    expect(text).toContain("Cloudflare");
    expect(text).not.toContain("Search Console");
    // One category: no chips.
    expect(text).not.toContain("All");
  });

  it("says when nothing is turned on, and names Vizzy only while Vizzy reads connected data", () => {
    expect(textOf(render({ connectors: [] }))).toContain(SCREEN_COPY.noConnectors);
    expect(textOf(render())).toContain(SCREEN_COPY.browseLead);
    expect(textOf(render({ chat: true }))).toContain(SCREEN_COPY.browseLeadVizzy);
  });

  it("puts each connector's state on its card", () => {
    const text = textOf(
      render({
        connections: [
          connectionView({ connectorId: "cloudflare", health: { state: "broken", lastOkAt: null, lastCheckedAt: null, message: "x", pausedUntil: null } }),
          connectionView({ id: "dcn_bbbbbbbbbbbbbbbbbbbb", connectorId: "search-console", connectorName: "Google Search Console" }),
        ],
      }),
    );
    expect(text).toContain("Needs attention API token");
    expect(text).toContain("Connected Sign in with Google");
  });
});

describe("Browse's words", () => {
  it("search by name, summary or category, and narrow by a chip", () => {
    expect(filterConnectors(ALL, "clicks", null).map((c) => c.id)).toEqual(["search-console"]);
    expect(filterConnectors(ALL, "TRAFFIC", null).map((c) => c.id)).toEqual(["cloudflare"]);
    expect(filterConnectors(ALL, "", "search_analytics").map((c) => c.id)).toEqual(["search-console", "google-analytics"]);
    expect(filterConnectors(ALL, "", "website_traffic").map((c) => c.id)).toEqual(["cloudflare"]);
    expect(filterConnectors(ALL, "cloud", "search_analytics")).toEqual([]);
    expect(categoriesOf(ALL)).toEqual(["search_analytics", "website_traffic"]);
  });

  it("rank a connector's state: attention, then a property to pick, then paused, then connected", () => {
    const sick = connectionView({ health: { state: "check", lastOkAt: null, lastCheckedAt: null, message: null, pausedUntil: null } });
    const picking = connectionView({ id: "dcn_cccccccccccccccccccc", needsAccount: true });
    const paused = connectionView({ health: { state: "paused", lastOkAt: null, lastCheckedAt: null, message: null, pausedUntil: null } });
    expect(connectorStatus("cloudflare", [])).toEqual({ label: "Ready", tone: "plain" });
    expect(connectorStatus("cloudflare", [picking, sick]).label).toBe("Needs attention");
    expect(connectorStatus("cloudflare", [picking, connectionView()]).label).toBe("Choose a property");
    expect(connectorStatus("cloudflare", [paused]).label).toBe("Paused");
    expect(connectorStatus("cloudflare", [connectionView({ status: "disconnected" })]).label).toBe("Ready");
    expect(connectorStatus("search-console", [sick]).label).toBe("Ready");
  });

  it("give each connector two letters", () => {
    expect(initialsOf("Google Search Console")).toBe("SC");
    expect(initialsOf("Google Analytics")).toBe("GA");
    expect(initialsOf("Cloudflare")).toBe("C");
  });

  it("write in house style", () => {
    for (const line of Object.values(SCREEN_COPY)) {
      expect(dashesIn(line), line).toEqual([]);
      expect(aiTellsIn(line), line).toEqual([]);
    }
  });
});

describe("Browse as people read it", () => {
  it("writes in house style", () => {
    for (const page of [render(), render({ chat: true }), render({ connectors: [] })]) {
      const text = textOf(page);
      expect(dashesIn(text)).toEqual([]);
      expect(aiTellsIn(text)).toEqual([]);
    }
  });
});
