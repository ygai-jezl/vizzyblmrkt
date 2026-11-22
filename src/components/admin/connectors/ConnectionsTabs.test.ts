import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const path = vi.hoisted(() => ({ now: "/admin/account/connections" }));
vi.mock("next/navigation", () => ({ usePathname: () => path.now }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never),
}));
const { ConnectionsTabs, connectionsTabOf } = await import("./ConnectionsTabs");

const render = (pathname: string, connected: number | null) => {
  path.now = pathname;
  return renderToStaticMarkup(createElement(ConnectionsTabs, { connected }));
};

describe("the Connections sub-tabs", () => {
  it("keep Accounts on the base route, where every sign in callback returns", () => {
    expect(connectionsTabOf("/admin/account/connections")).toBe("accounts");
    expect(connectionsTabOf("/admin/account/connections/")).toBe("accounts");
    expect(connectionsTabOf(null)).toBe("accounts");
  });

  it("put a connector's Listing and its picker under Browse, and Connected on its own", () => {
    expect(connectionsTabOf("/admin/account/connections/browse")).toBe("browse");
    expect(connectionsTabOf("/admin/account/connections/search-console")).toBe("browse");
    expect(connectionsTabOf("/admin/account/connections/google-analytics/pick")).toBe("browse");
    expect(connectionsTabOf("/admin/account/connections/connected")).toBe("connected");
  });

  it("mark the open tab and show how many are connected", () => {
    const html = render("/admin/account/connections/connected", 2);
    expect(html).toContain('href="/admin/account/connections"');
    expect(html).toContain('href="/admin/account/connections/browse"');
    expect(html).toMatch(/aria-current="page"[^>]*>Connected<span[^>]*>2<\/span>/);
    expect(html.match(/aria-current/g)).toHaveLength(1);
    expect(html).toContain(">Accounts<");
    expect(html).toContain(">Browse<");
  });

  it("leave the count out when there is none or it isn't known", () => {
    expect(render("/admin/account/connections", 0)).not.toMatch(/Connected<span/);
    expect(render("/admin/account/connections", null)).not.toMatch(/Connected<span/);
    expect(render("/admin/account/connections", null)).toMatch(/aria-current="page"[^>]*>Accounts</);
  });
});
