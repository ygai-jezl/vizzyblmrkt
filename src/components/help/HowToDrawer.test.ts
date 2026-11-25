import { createElement, type ComponentType } from "react";
import type { HelpBodyProps } from "@/lib/help/pages";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never),
}));

// The How to drawer renders in the browser, where server switches read off, so it tells each help
// body what the admin shell was given: with sharing and the join on, the drawer's pages say the same
// as /help does (Connectors 3).
describe("the How to drawer's help bodies", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("passes on sharing and the join from the shell", async () => {
    const { drawerBodyProps } = await import("./HowToDrawer");
    expect(drawerBodyProps(null)).toMatchObject({ sharing: false, join: false });
    expect(drawerBodyProps({ sharing: true, join: true } as never)).toMatchObject({ sharing: true, join: true });
  });

  it("passes on ideas and their words from the shell", async () => {
    const { drawerBodyProps } = await import("./HowToDrawer");
    expect(drawerBodyProps(null)).toMatchObject({ ideas: false, ideaWords: false });
    expect(drawerBodyProps({ ideas: true, ideaWords: true } as never)).toMatchObject({ ideas: true, ideaWords: true });
  });

  it("shows the shared connection sections of Connected data and Brands in your organisation with the shell's values on", async () => {
    // As in the browser: the server switches read off.
    vi.stubEnv("CONNECTORS_SHARING_ENABLED", "");
    vi.stubEnv("ORGANISATION_JOIN_ENABLED", "");
    const { drawerBodyProps } = await import("./HowToDrawer");
    const props = drawerBodyProps({ sharing: true, join: true } as never);
    const ConnectedData = (await import("./pages/connected-data")).default as ComponentType<HelpBodyProps>;
    const OrganisationBrands = (await import("./pages/organisation-brands")).default as ComponentType<HelpBodyProps>;
    expect(renderToStaticMarkup(createElement(ConnectedData, props))).toContain("A part from your organisation");
    expect(renderToStaticMarkup(createElement(OrganisationBrands, props))).toContain("Its parts from your organisation stop at once");
    const off = drawerBodyProps(null);
    expect(renderToStaticMarkup(createElement(ConnectedData, off))).not.toContain("A part from your organisation");
  });
});
