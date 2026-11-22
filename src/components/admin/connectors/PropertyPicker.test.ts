import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { CONNECTOR_ERRORS } from "@/lib/connectors/messages";
import { listingFor, textOf } from "./testing";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never),
}));
const { PickerForm, PropertyPicker } = await import("./PropertyPicker");
const { PICKER_COPY, accountHost, domainNote, listedNoteOf, preselected, sameSite } = await import("./words");

// Made-up properties for the made-up brand Acme.
const SITES = [
  { id: "sc-domain:acme.example", label: "acme.example (whole domain)", detail: "Owner" },
  { id: "https://shop.acme.example/", label: "https://shop.acme.example/", detail: "Full user" },
  { id: "https://other-brand.example/", label: "https://other-brand.example/", detail: "Restricted" },
];
const PROPS = [
  { id: "properties/111111", label: "Acme website", detail: "Acme" },
  { id: "properties/222222", label: "other-brand.example", detail: "Agency" },
];

type FormProps = Parameters<typeof PickerForm>[0];
const form = (over: Partial<FormProps> = {}) =>
  renderToStaticMarkup(
    createElement(PickerForm, {
      connectorId: "search-console",
      connectorName: "Google Search Console",
      connectionId: "dcn_sisisisisisisisisisi",
      method: "oauth_pkce",
      sharedWith: null,
      current: "",
      rootDomain: "acme.example",
      listedNote: listedNoteOf(listingFor("search-console", ["oauth_pkce"])),
      loaded: { accounts: SITES, more: false, current: "" },
      loadError: null,
      chosen: "sc-domain:acme.example",
      onChoose: () => {},
      busy: null,
      error: null,
      onSubmit: () => {},
      onCancel: () => {},
      ...over,
    }),
  );

describe("the property picker", () => {
  it("lists what the sign in sees, with each one's access, and marks one on another website without blocking it", () => {
    const html = form();
    const text = textOf(html);
    expect(text).toContain("Signed in with Google Which property is this brand's?");
    expect(text).toContain("These are the Google Search Console properties this Google account can see. Listed once so you can pick one. Sites you haven't verified are left out.");
    expect(text).toContain("acme.example (whole domain) Owner");
    expect(text).toContain("https://other-brand.example/ Not on acme.example, this brand's site. You can still choose it. Restricted");
    expect(text.match(/Not on acme\.example/g)).toHaveLength(1);
    // Every one can be chosen, the marked one too.
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    expect(html).not.toMatch(/type="radio"[^>]*disabled/);
    expect(text).toContain("Connect this property Cancel");
    expect(text).toContain(PICKER_COPY.newHint);
  });

  it("marks nothing when the brand has no root domain", () => {
    expect(textOf(form({ rootDomain: null }))).not.toContain("Not on");
  });

  it("says who shared, and what to do when the address sees nothing yet", () => {
    const text = textOf(form({ method: "share_access", sharedWith: "ygc-made-up@connect.example.iam.gserviceaccount.com", loaded: { accounts: [], more: false, current: "" }, chosen: null }));
    expect(text).toContain("Shared with ygc-made-up@connect.example.iam.gserviceaccount.com");
    expect(text).toContain("the address can see");
    expect(text).toContain(CONNECTOR_ERRORS.share_not_visible);
    expect(text).toContain("Back to Google Search Console");
  });

  it("changes what an existing connection reads without deleting anything on Cancel", () => {
    const html = form({ current: "sc-domain:acme.example", loaded: { accounts: SITES, more: true, current: "sc-domain:acme.example" } });
    const text = textOf(html);
    expect(text).toContain("Read this property");
    expect(html).toContain('href="/admin/account/connections/connected"');
    expect(text).toContain(PICKER_COPY.changeHint);
    expect(text).toContain("Only the first 3 are listed.");
  });

  it("shows the route's words when the list can't load, and waits while it loads", () => {
    expect(textOf(form({ loaded: null, loadError: CONNECTOR_ERRORS.signin_refused }))).toContain(CONNECTOR_ERRORS.signin_refused);
    expect(textOf(form({ loaded: null }))).toContain(PICKER_COPY.loading);
    expect(textOf(renderToStaticMarkup(createElement(PropertyPicker, {
      connectorId: "google-analytics",
      connectorName: "Google Analytics",
      connectionId: "dcn_gagagagagagagagagaga",
      method: "share_access",
      sharedWith: null,
      current: "",
      rootDomain: null,
      listedNote: null,
    })))).toContain(PICKER_COPY.loading);
  });
});

describe("the picker's domain words", () => {
  it("find the website a site or property is on, when it says", () => {
    expect(accountHost(SITES[0]!)).toBe("acme.example");
    expect(accountHost(SITES[1]!)).toBe("shop.acme.example");
    expect(accountHost({ id: "https://www.acme.example/blog/", label: "x" })).toBe("acme.example");
    expect(accountHost(PROPS[0]!)).toBeNull();
    expect(accountHost(PROPS[1]!)).toBe("other-brand.example");
    expect(accountHost({ id: "properties/3", label: "Acme (acme.example) main" })).toBe("acme.example");
  });

  it("count a subdomain, www and a domain property as the brand's own site", () => {
    expect(sameSite("shop.acme.example", "acme.example")).toBe(true);
    expect(sameSite("acme.example", "www.acme.example")).toBe(true);
    expect(sameSite("acme.example", "shop.acme.example")).toBe(true);
    expect(sameSite("notacme.example", "acme.example")).toBe(false);
    expect(domainNote(PROPS[0]!, "acme.example")).toBeNull();
    expect(domainNote(PROPS[1]!, "acme.example")).toBe("Not on acme.example, this brand's site. You can still choose it.");
    expect(domainNote(PROPS[1]!, "  ")).toBeNull();
  });

  it("start on what it reads, else the brand's own site, else the only one", () => {
    expect(preselected(SITES, "https://shop.acme.example/", "acme.example")).toBe("https://shop.acme.example/");
    expect(preselected([SITES[2]!, SITES[1]!], "", "acme.example")).toBe("https://shop.acme.example/");
    expect(preselected(PROPS, "", "acme.example")).toBeNull();
    expect(preselected([PROPS[0]!], "", null)).toBe("properties/111111");
  });

  it("take the list's note from the manifest, and write in house style", () => {
    expect(listedNoteOf(listingFor("google-analytics", ["share_access"]))).toBe("Listed once so you can pick one.");
    expect(listedNoteOf(listingFor("cloudflare", ["token_fields"]))).toBeNull();
    for (const line of [...Object.values(PICKER_COPY), domainNote(PROPS[1]!, "acme.example")!]) {
      expect(dashesIn(line), line).toEqual([]);
      expect(aiTellsIn(line), line).toEqual([]);
    }
  });
});
