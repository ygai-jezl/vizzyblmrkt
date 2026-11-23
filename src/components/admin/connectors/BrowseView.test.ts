import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { connectionView, listingFor, textOf } from "./testing";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never),
}));
const { BrowseView } = await import("./BrowseView");
const { CATEGORY_GROUPS, SCREEN_COPY, categoriesOf, connectorStatus, filterConnectors, groupOf, initialsOf } = await import("./words");
const { CONNECTOR_CATEGORIES } = await import("@/lib/connectors/manifest");
const { allConnectors } = await import("@/lib/connectors/catalog");

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
    expect(text).toContain("Google Analytics 4 Search and analytics · Built by YouGrow Sessions, users, views and key events for your site, read from Google Analytics 4 when you ask. Ready Share access");
    // In the approved Browse screen's order: Search Console, Google Analytics 4, Cloudflare.
    expect(text.indexOf("Google Search Console Search")).toBeLessThan(text.indexOf("Google Analytics 4 Search"));
    expect(text.indexOf("Google Analytics 4 Search")).toBeLessThan(text.indexOf("Cloudflare Website"));
    expect(text).toContain("Ready API token");
    expect(text).toContain(SCREEN_COPY.browseFoot);
    // Accounts holds GitHub, GitLab, LinkedIn and X; email sending is under Sending.
    expect(SCREEN_COPY.browseFoot).toContain("Your accounts for code and posts stay under Accounts, and email sending is under Sending.");
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
  it("search by name, summary or group, and narrow by a chip", () => {
    expect(filterConnectors(ALL, "clicks", null).map((c) => c.id)).toEqual(["search-console"]);
    expect(filterConnectors(ALL, "TRAFFIC", null).map((c) => c.id)).toEqual(["cloudflare"]);
    expect(filterConnectors(ALL, "", "search-analytics").map((c) => c.id)).toEqual(["search-console", "google-analytics"]);
    expect(filterConnectors(ALL, "", "website-traffic").map((c) => c.id)).toEqual(["cloudflare"]);
    expect(filterConnectors(ALL, "cloud", "search-analytics")).toEqual([]);
    expect(categoriesOf(ALL)).toEqual([
      { id: "search-analytics", label: "Search and analytics" },
      { id: "website-traffic", label: "Website and traffic" },
    ]);
  });

  it("keep the manifests' fine categories, and group them only for display", () => {
    const byId = Object.fromEntries(allConnectors().map((m) => [m.id, m.category]));
    expect(byId).toEqual({ "search-console": "search", "google-analytics": "analytics", cloudflare: "traffic" });
    expect(groupOf("analytics")).toEqual({ id: "search-analytics", label: "Search and analytics" });
    expect(groupOf("search")).toEqual({ id: "search-analytics", label: "Search and analytics" });
    expect(groupOf("traffic")).toEqual({ id: "website-traffic", label: "Website and traffic" });
    // Every category the manifest schema allows is in exactly one group.
    for (const c of CONNECTOR_CATEGORIES) expect(CATEGORY_GROUPS.filter((g) => (g.categories as readonly string[]).includes(c)), c).toHaveLength(1);
  });

  it("list the connectors in the approved Browse screen's order", () => {
    expect(allConnectors().map((m) => m.name)).toEqual(["Google Search Console", "Google Analytics 4", "Cloudflare"]);
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

  it("give each connector two letters, as the approved screens: SC, GA and CF", () => {
    expect(initialsOf("Google Search Console")).toBe("SC");
    expect(initialsOf("Google Analytics 4")).toBe("GA");
    // A one word name takes the manifest's own letters, else its first two, or two words inside it.
    expect(initialsOf("Cloudflare", "CF")).toBe("CF");
    expect(initialsOf("Cloudflare")).toBe("CL");
    expect(initialsOf("HubSpot")).toBe("HS");
    // As Browse and the Listing draw them from the manifests, when a connector has no mark of its own.
    const tiles = (html: string) => [...html.matchAll(/<span aria-hidden="true"[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]);
    expect(tiles(render({ connectors: ALL.map((c) => ({ ...c, icon: undefined })) }))).toEqual(["SC", "GA", "CF"]);
    expect(ALL.map((c) => c.initials)).toEqual([undefined, undefined, "CF"]);
  });

  it("show each connector's own mark on a neutral plate, with no words, beside its name", () => {
    const html = render();
    const marks = [...html.matchAll(/<span aria-hidden="true" class="([^"]*)"><img src="([^"]+)" alt=""/g)];
    expect(marks.map((m) => m[2])).toEqual(["/marks/connectors/search-console/icon.png", "/marks/connectors/google-analytics/icon.svg", "/marks/connectors/cloudflare/icon.png"]);
    // White in both themes, as the owners show their full colour marks; the size of today's tile.
    for (const [, cls] of marks) expect(cls).toMatch(/\bbg-white\b.*\bh-10 w-10 rounded-lg\b/);
    expect(html).not.toMatch(/<span aria-hidden="true"[^>]*>(?:SC|GA|CF)<\/span>/);
    expect(textOf(html)).toMatch(/^.*Google Search Console Search and analytics · Built by YouGrow/);
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
