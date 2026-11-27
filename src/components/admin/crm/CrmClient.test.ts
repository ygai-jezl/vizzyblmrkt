import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BOARD_WORDS } from "@/lib/raise/pipeline/words";

let search = "";
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/admin/crm",
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never),
}));
const { CrmClient } = await import("./CrmClient");

const page = (tab: string, investors: { tab: string } | null) => {
  search = tab ? `tab=${tab}` : "";
  return renderToStaticMarkup(
    createElement(CrmClient, {
      isAdmin: true,
      initialContacts: [],
      contactsCursor: null,
      initialCompanies: [],
      companiesCursor: null,
      audience: { productUsers: true, personView: true, oneView: true },
      investors,
    }),
  );
};

// People › Investors (RAISE_PIPELINE_ENABLED): a fourth pill after People, Companies and Engaged.
describe("the board's tab on People", () => {
  it("shows after Engaged, named for the brand's board, and opens the board from ?tab=investors", () => {
    const html = page("investors", { tab: "Funding" });
    expect(html.indexOf(">Engaged<")).toBeLessThan(html.indexOf(">Funding<"));
    expect(html).toContain(BOARD_WORDS.loading);
  });

  it("is gone without a board, and ?tab=investors lands on People", () => {
    const html = page("investors", null);
    expect(html).not.toContain(">Investors<");
    expect(html).not.toContain(BOARD_WORDS.loading);
    // People is the pill that is picked.
    expect(html).toMatch(/border-neutral-900 bg-neutral-900[^"]*">People</);
  });
});
