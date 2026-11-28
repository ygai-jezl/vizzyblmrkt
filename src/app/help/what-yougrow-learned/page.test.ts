import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import Page from "./page";
import { GET } from "../what-yougrow-learned.md/route";

/**
 * /help/what-yougrow-learned and its Markdown twin are served exactly while the page is listed
 * (isHelpPageShown "learning"): image style versions or the learning loops on. With only the
 * loops on, it is the page the learning setting's "How this works" link opens, so it must not 404.
 */

afterEach(() => vi.unstubAllEnvs());

const COUNTS_ONLY = "Your brand can leave the counts across brands at any time.";

describe("the What YouGrow learned help page", () => {
  it("is served with only LOOPS_ENABLED on, as the counts across brands", async () => {
    vi.stubEnv("LOOPS_ENABLED", "true");
    vi.stubEnv("IMAGE_STYLE_VERSIONS_ENABLED", "false");
    vi.stubEnv("NEXT_PUBLIC_HELP_PAGES_ENABLED", "true");
    const html = renderToStaticMarkup(Page());
    expect(html.replace(/\s+/g, " ")).toContain(COUNTS_ONLY);
    expect(html).toContain('id="counts-across-brands"');
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("counts across brands");
  });

  it("is not found with image style versions and the learning loops both off", () => {
    vi.stubEnv("NEXT_PUBLIC_HELP_PAGES_ENABLED", "true");
    expect(() => Page()).toThrow();
    expect(GET().status).toBe(404);
  });
});
