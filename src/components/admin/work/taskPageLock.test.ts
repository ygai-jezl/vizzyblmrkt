import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DUE, MEMBER, PLAIN, ROWS } from "@/lib/work/testing/screens";

// The task page's and the list's markup, locked before quick edit moves the task page's insides
// into sections the open row shares (plan-work-quick-edit section 4). The files under
// __snapshots__ are the markup as it was; a change to it fails here, so the page stays as it is.
// Three made-up tasks: plain, a due measure's check with blockers and links, and a member's in
// the brand view.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/admin/work" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => createElement("a", { href, ...rest }, children as never),
}));
const { TaskPage } = await import("./TaskPage");
const { WorkTable } = await import("./WorkTable");

/** One tag a line, so a change reads as a diff. */
const lines = (html: string) => `${html.replace(/></g, ">\n<")}\n`;

describe("the task page's markup", () => {
  it.each([
    ["plain", PLAIN],
    ["due", DUE],
    ["member", MEMBER],
  ] as const)("is unchanged for the %s task", async (name, screen) => {
    await expect(lines(renderToStaticMarkup(createElement(TaskPage, { screen })))).toMatchFileSnapshot(`./__snapshots__/taskPage.${name}.html`);
  });
});

describe("the list's markup", () => {
  it("is unchanged with more than one brand, and with one", async () => {
    await expect(lines(renderToStaticMarkup(createElement(WorkTable, { rows: ROWS, multiBrand: true, ideaWords: true })))).toMatchFileSnapshot("./__snapshots__/workTable.brands.html");
    await expect(lines(renderToStaticMarkup(createElement(WorkTable, { rows: ROWS, multiBrand: false, ideaWords: false })))).toMatchFileSnapshot("./__snapshots__/workTable.oneBrand.html");
  });
});
