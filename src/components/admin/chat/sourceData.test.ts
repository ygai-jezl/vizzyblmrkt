import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { MANIFESTS } from "@/lib/connectors/manifests";
import { chatSourceOf, COLLECTED_SUFFIX, connectorSourceOf, withSource } from "./sourceData";
import { SOURCE_COPY, SourceLine } from "./SourceLine";
import { MessageThread } from "./MessageThread";
import type { ChatExchange } from "./useDashboardChat";

// A read_connected_live result as the agent stream carries it: the Python tool passes the app's body through.
const read = (connectorId: unknown, status = "success") => ({
  status,
  connection: { id: "dcn_aaaaaaaaaaaaaaaaaaaa", connectorId, connector: "Google Search Console", label: "acme.example" },
  period: { from: "2026-10-24", to: "2026-11-20", timeZone: "America/Los_Angeles", finalThrough: "2026-11-18", words: "24 Oct to 20 Nov 2026, Pacific time" },
  rows: [],
  more: false,
  meanings: {},
  notes: [],
});

const line = (ids: string[]) => renderToStaticMarkup(createElement(SourceLine, { ids }));

describe("which connectors an answer read", () => {
  it("takes the connector id from a successful live read", () => {
    expect(connectorSourceOf("read_connected_live", read("search-console"))).toBe("search-console");
    expect(connectorSourceOf("read_connected_live", read("google-analytics"))).toBe("google-analytics");
    expect(connectorSourceOf("read_connected_live", read("cloudflare"))).toBe("cloudflare");
  });

  it("marks numbers read from what YouGrow collected, apart from live reads", () => {
    expect(connectorSourceOf("get_connected_numbers", read("search-console"))).toBe("search-console:collected");
    expect(connectorSourceOf("get_connected_numbers", read("search-console", "error"))).toBeNull();
    expect(connectorSourceOf("get_connected_numbers", read("evil.example"))).toBeNull();
    expect(connectorSourceOf("toString", read("search-console"))).toBeNull();
    expect(chatSourceOf("search-console:collected")).toMatchObject({ id: "search-console", name: "Google Search Console", collected: true });
    expect(chatSourceOf("search-console")).toMatchObject({ collected: false });
    expect(chatSourceOf(`evil.example${COLLECTED_SUFFIX}`)).toBeNull();
    // Read both ways in one answer, each is listed once.
    const exchange: ChatExchange[] = [{ role: "agent", text: "" }];
    expect(withSource(withSource(exchange, "search-console"), "search-console:collected")[0]!.sources).toEqual(["search-console", "search-console:collected"]);
  });

  it("ignores other tools, failed reads, ids no manifest has and odd shapes", () => {
    expect(connectorSourceOf("list_connections", read("search-console"))).toBeNull();
    expect(connectorSourceOf("get_post_results", { status: "success", connection: { connectorId: "search-console" } })).toBeNull();
    expect(connectorSourceOf("read_connected_live", read("search-console", "error"))).toBeNull();
    expect(connectorSourceOf("read_connected_live", { status: "error", code: "no_agent_grant", message: "x" })).toBeNull();
    expect(connectorSourceOf("read_connected_live", read("evil.example"))).toBeNull();
    expect(connectorSourceOf("read_connected_live", read({ id: "search-console" }))).toBeNull();
    expect(connectorSourceOf("read_connected_live", { status: "success", connection: "search-console" })).toBeNull();
    expect(connectorSourceOf("read_connected_live", undefined)).toBeNull();
  });

  it("adds each connector once to the latest agent message, in the order read", () => {
    const exchange: ChatExchange[] = [
      { role: "user", text: "How did search go?" },
      { role: "agent", text: "", isStreaming: true },
    ];
    const once = withSource(exchange, "search-console");
    expect(once[1]!.sources).toEqual(["search-console"]);
    expect(exchange[1]!.sources).toBeUndefined();
    const twice = withSource(withSource(once, "cloudflare"), "search-console");
    expect(twice[1]!.sources).toEqual(["search-console", "cloudflare"]);
    expect(twice[1]!.isStreaming).toBe(true);
    expect(withSource([{ role: "user", text: "hi" }] as ChatExchange[], "cloudflare")).toEqual([{ role: "user", text: "hi" }]);
  });

  it("takes every name, mark and link from the manifests", () => {
    for (const m of MANIFESTS) {
      const s = chatSourceOf(m.id)!;
      expect(s.name).toBe(m.name);
      expect(s.icon).toEqual(m.icon);
      expect(s.home).toBe(m.home);
      expect(s.home, m.id).toMatch(/^https:\/\//);
    }
    expect(chatSourceOf("nope")).toBeNull();
  });
});

describe("SourceLine", () => {
  it("links Search Console and Cloudflare by their mark and name to their own dashboards", () => {
    const out = line(["search-console", "cloudflare"]);
    expect(out).toContain(`<span>${SOURCE_COPY.from}</span>`);
    expect(out).toContain('<a href="https://search.google.com/search-console" target="_blank" rel="noopener noreferrer"');
    expect(out).toContain('<img src="/marks/connectors/search-console/icon.png" alt=""');
    expect(out).toContain("<span>Google Search Console</span>");
    expect(out).toContain('<a href="https://dash.cloudflare.com/" target="_blank" rel="noopener noreferrer"');
    expect(out).toContain('<img src="/marks/connectors/cloudflare/icon.png" alt=""');
    expect(out).toContain("<span>Cloudflare</span>");
    expect(out.indexOf("Google Search Console")).toBeLessThan(out.indexOf("Cloudflare</span>"));
    expect(out).toContain(`<span class="sr-only">${SOURCE_COPY.newTab}</span>`);
  });

  it("shows Google Analytics as its linked wide logo, light and dark, at its size", () => {
    const lockup = chatSourceOf("google-analytics")!.icon!.lockup!;
    const out = line(["google-analytics"]);
    expect(out).toContain(`<a href="${lockup.href}" target="_blank" rel="noopener noreferrer"`);
    expect(out).toContain(`<img src="${lockup.light}" alt="Google Analytics" width="${lockup.width}" height="${lockup.height}"`);
    expect(out).toContain(`<img src="${lockup.dark}" alt="Google Analytics"`);
    expect(lockup.width).toBeGreaterThanOrEqual(154);
    expect(lockup.height).toBeGreaterThanOrEqual(50);
    // The logo has the words in it: no second name beside it.
    expect(out).not.toContain("Google Analytics 4");
  });

  it("says (collected) after the name for numbers YouGrow collected", () => {
    const out = line(["search-console:collected"]);
    expect(out).toContain(`<span>Google Search Console ${SOURCE_COPY.collected}</span>`);
    expect(out).toContain('<a href="https://search.google.com/search-console" target="_blank" rel="noopener noreferrer"');
    expect(line(["search-console"])).not.toContain(SOURCE_COPY.collected);
    // Google Analytics keeps its logo alone, as its owner asks; screen readers hear it was collected.
    const ga = line(["google-analytics:collected"]);
    expect(ga).toContain('alt="Google Analytics"');
    expect(ga).toContain(`<span class="sr-only"> ${SOURCE_COPY.collected}</span>`);
    // Its logo shows once, however its numbers were read.
    expect(line(["google-analytics", "google-analytics:collected"]).match(/alt="Google Analytics"/g)).toHaveLength(2);
  });

  it("shows nothing for ids no manifest has", () => {
    expect(line([])).toBe("");
    expect(line(["evil.example"])).toBe("");
  });

  it("writes in house style", () => {
    for (const text of Object.values(SOURCE_COPY)) {
      expect(dashesIn(text), text).toEqual([]);
      expect(aiTellsIn(text), text).toEqual([]);
    }
  });
});

describe("MessageThread", () => {
  const thread = (exchange: ChatExchange[]) =>
    renderToStaticMarkup(createElement(MessageThread, { exchange, isThinking: false, currentThought: "", toolStatus: null }));

  it("ends an answer that read a connection with its source line, after the text", () => {
    const out = thread([
      { role: "user", text: "Which pages got clicks?" },
      { role: "agent", text: "Two pages got clicks.", sources: ["search-console"] },
    ]);
    expect(out).toContain(SOURCE_COPY.from);
    expect(out.indexOf("Two pages got clicks.")).toBeLessThan(out.indexOf(SOURCE_COPY.from));
  });

  it("shows no source line under answers that read nothing", () => {
    const out = thread([
      { role: "user", text: "Hi" },
      { role: "agent", text: "Hello." },
      { role: "agent", text: "Still here.", sources: [] },
    ]);
    expect(out).not.toContain(SOURCE_COPY.from);
  });
});
