import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import type { BringInCandidate, OrganisationBrandsScreen } from "@/lib/connectors/organisationBrands";
import { textOf } from "./testing";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
// The dialog's portal needs a browser; here every part of it draws in place.
vi.mock("@radix-ui/react-dialog", () => {
  const pass = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return { Root: pass, Portal: pass, Overlay: () => null, Content: pass, Title: ({ children }: { children?: ReactNode }) => createElement("h2", null, children), Close: () => null, Description: pass };
});
const { BrandsTable, BringInBody, OrganisationBrandsView, bringInState } = await import("./OrganisationBrandsView");
const W = await import("./words");

// Settings › Organisation › Brands (Connectors 3 group 4), as the approved OrgBrands screens draw
// it. Fernhill Group [made up], on Ultra: Fernhill Plants and Harbour Blooms (Europe) and Fernhill
// US (United States). Priya, in Fernhill Plants, also owns Fernhill Cafe's organisation (Free) and
// Fernhill Wholesale's (Enterprise).
const brand = (id: string, name: string, regionName: string, parts: string[] | null, over: Partial<OrganisationBrandsScreen["brands"][number]> = {}) => ({
  id,
  name,
  regionName,
  isThis: false,
  parts,
  keptFrom: [] as string[],
  moveRefusal: null,
  ...over,
});
const cafe: BringInCandidate = { id: "ten_cafe", name: "Fernhill Cafe", regionName: "Europe", organisation: { id: "org_ten_cafe", name: "Fernhill Cafe", planName: "Free", alone: true }, narrower: null, parts: [], emptiedConnections: 0 };
const wholesale: BringInCandidate = {
  id: "ten_wholesale",
  name: "Fernhill Wholesale",
  regionName: "Europe",
  organisation: { id: "org_ten_wholesale", name: "Fernhill Wholesale", planName: "Enterprise", alone: true },
  narrower: "features",
  parts: [],
  emptiedConnections: 0,
};
const screen = (over: Partial<OrganisationBrandsScreen> = {}): OrganisationBrandsScreen => ({
  organisation: { id: "org_ten_fernhill", name: "Fernhill Group", planName: "Ultra" },
  brand: { id: "ten_fernhill", name: "Fernhill Plants" },
  brands: [
    brand("ten_fernhill", "Fernhill Plants", "Europe", ["search-console", "google-analytics"], { isThis: true, keptFrom: ["Europe"] }),
    brand("ten_harbour", "Harbour Blooms", "Europe", ["search-console"]),
    brand("ten_fernhill-us", "Fernhill US", "United States", []),
  ],
  candidates: [cafe, wholesale],
  full: null,
  ...over,
});
const html = (node: ReturnType<typeof createElement>) => textOf(renderToStaticMarkup(node));
const clean = (text: string) => {
  expect(dashesIn(text), text).toEqual([]);
  expect(aiTellsIn(text), text).toEqual([]);
};

describe("the Brands section", () => {
  it("lists each brand with its region and the parts given to it, marking the brand you are in", () => {
    const raw = renderToStaticMarkup(createElement(BrandsTable, { screen: screen() }));
    expect(raw).toContain('aria-label="Brands in Fernhill Group"');
    const t = textOf(raw);
    expect(t).toMatch(/Brand\s+Region\s+Parts given to it/);
    expect(t).toMatch(/Fernhill Plants\s+This brand\s+Europe\s+2/);
    expect(t).toMatch(/Harbour Blooms\s+Europe\s+1/);
    expect(t).toMatch(/Fernhill US\s+United States\s+0/);
  });

  it("says it couldn't count a brand's parts when they couldn't be read", () => {
    expect(html(createElement(BrandsTable, { screen: screen({ brands: [brand("ten_fernhill", "Fernhill Plants", "Europe", null)] }) }))).toContain("Couldn't count");
  });

  it("has the Bring in button and its help", () => {
    const raw = renderToStaticMarkup(createElement(OrganisationBrandsView, { screen: screen() }));
    expect(textOf(raw)).toContain("Bring in a brand you run");
    expect(raw).toContain('href="/help/organisation-brands"');
  });
});

describe("Bring in a brand you run", () => {
  it("says no other brand can join when there is none", () => {
    expect(html(createElement(BringInBody, { screen: screen({ candidates: [] }), pick: null, onPick: () => {}, error: null }))).toContain(
      "No other brand can join yet. A brand can join when you're an owner of its organisation and an admin on its team.",
    );
  });

  it("lists each brand with its organisation and plan", () => {
    const t = html(createElement(BringInBody, { screen: screen(), pick: null, onPick: () => {}, error: null }));
    expect(t).toContain("Fernhill Cafe (its own organisation, Free)");
    expect(t).toContain("Fernhill Wholesale (its own organisation, Enterprise)");
    expect(W.candidateWords({ ...wholesale, organisation: { ...wholesale.organisation, name: "Wholesale Group", alone: false } })).toBe("Fernhill Wholesale (Wholesale Group, Enterprise)");
  });

  it("says what bringing one in does, and turns nothing off", () => {
    const t = html(createElement(BringInBody, { screen: screen(), pick: "ten_cafe", onPick: () => {}, error: null }));
    expect(t).toContain("Fernhill Cafe joins Fernhill Group and takes its plan, Ultra. Nothing it uses today is turned off.");
    expect(bringInState(screen(), cafe)).toMatchObject({ go: true });
  });

  it("refuses a narrower plan before anything is pressed", () => {
    const t = html(createElement(BringInBody, { screen: screen(), pick: "ten_wholesale", onPick: () => {}, error: null }));
    expect(t).toContain("Bringing in Fernhill Wholesale would move it from Enterprise to Ultra and turn off features it has. That needs a plan change first.");
    expect(bringInState(screen(), wholesale)).toMatchObject({ go: false });
  });

  it("says when the plan has no room for another brand", () => {
    const t = html(createElement(BringInBody, { screen: screen({ full: { limit: 3 }, organisation: { id: "org_ten_fernhill", name: "Fernhill Group", planName: "Pro" } }), pick: null, onPick: () => {}, error: null }));
    expect(t).toContain("Fernhill Group already has the 3 brands Pro allows. Bringing in another needs a plan change first.");
    expect(t).not.toContain("Fernhill Cafe (");
  });

  it("names the parts it loses from the organisation it leaves, and that organisation's connections when it is left empty", () => {
    const withParts = { ...cafe, parts: ["cloudflare"], emptiedConnections: 1 };
    expect(W.bringInTextWords(withParts, "Fernhill Group", "Ultra")).toBe(
      "Fernhill Cafe joins Fernhill Group and takes its plan, Ultra. The plan turns nothing off. Its zone from Fernhill Cafe stops now, and what was collected through it is deleted. Its own organisation has no brands left after this, so its connection is disconnected.",
    );
    expect(W.bringInTextWords({ ...cafe, parts: ["search-console", "cloudflare"], emptiedConnections: 2 }, "Fernhill Group", "Ultra")).toContain(
      "Its 2 parts from Fernhill Cafe stop now, and what was collected through them is deleted. Its own organisation has no brands left after this, so its connections are disconnected.",
    );
  });
});

describe("the words", () => {
  it("follow the writing rules", () => {
    for (const text of Object.values(W.BRANDS_COPY)) clean(text);
    clean(W.narrowerWords("Fernhill Wholesale", "Enterprise", "Ultra", "features"));
    clean(W.narrowerWords("Fernhill Wholesale", "Ultra", "Pro", "caps"));
    clean(W.fullWords("Fernhill Group", 1, "Free"));
    clean(W.bringInTextWords({ ...cafe, parts: ["search-console"], emptiedConnections: 1 }, "Fernhill Group", "Ultra"));
    clean(W.moveRefusalWords("Harbour Blooms", "home_only"));
    clean(W.moveRefusalWords("Harbour Blooms", "not_admin", "in"));
    clean(W.bringInDoneWords("Fernhill Cafe", "Fernhill Group"));
    expect(W.fullWords("Fernhill Group", 1, "Free")).toBe("Fernhill Group already has the 1 brand Free allows. Bringing in another needs a plan change first.");
  });
});
