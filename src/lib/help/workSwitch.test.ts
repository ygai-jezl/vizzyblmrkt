import { afterEach, describe, expect, it, vi } from "vitest";
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";

/**
 * /help/work (ADR-0020) exists only while WORK_ENABLED is on. It is a server switch, so the pages
 * read it when they render, and the How to drawer passes the shell's answer. What Vizzy does in
 * Work shows only while WORK_VIZZY_ENABLED is on too. Each case loads the modules afresh.
 */
async function load(on: boolean, vizzy = false) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_HELP_PAGES_ENABLED", "true");
  vi.stubEnv("WORK_ENABLED", on ? "true" : "false");
  vi.stubEnv("WORK_VIZZY_ENABLED", vizzy ? "true" : "false");
  const [pages, agent, md, docs, bodies] = await Promise.all([
    import("./pages"),
    import("./agentFiles"),
    import("@/app/help/work.md/route"),
    import("@/lib/developers/markdown"),
    import("@/components/help/bodies"),
  ]);
  return { ...pages, ...agent, md, docs, bodies };
}

const ORIGIN = "https://app.example.com";

describe("the Work help switch", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("off: no page, its Markdown copy is not found, and Review and approvals says nothing of Work", async () => {
    const { shownHelpPages, helpLlmsTxt, helpPageMarkdown, md } = await load(false, true);
    expect(shownHelpPages().map((p) => p.slug)).not.toContain("work");
    expect(helpLlmsTxt(ORIGIN)).not.toContain("/help/work");
    expect((await md.GET()).status).toBe(404);
    const review = helpPageMarkdown("review-and-approvals", ORIGIN)!;
    for (const words of ["Checks due today", "Ready to start", "Tasks Vizzy suggests", "/help/work"]) expect(review).not.toContain(words);
  });

  it("on: listed last in the first group, served as Markdown, and linked from Review and approvals", async () => {
    const { shownHelpPages, helpLlmsTxt, helpPageMarkdown, helpPage, md } = await load(true);
    const shown = shownHelpPages();
    const start = shown.filter((p) => p.group === "start").map((p) => p.slug);
    expect(start[start.length - 1]).toBe("work");
    expect(helpPage("work")).toMatchObject({ label: "Work", group: "start", path: "/help/work" });
    expect(helpLlmsTxt(ORIGIN)).toContain(`${ORIGIN}/help/work.md`);
    const res = await md.GET();
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/^# Work\n/);
    const review = helpPageMarkdown("review-and-approvals", ORIGIN)!;
    expect(review).toContain("**Checks due today**");
    expect(review).toContain("**Ready to start**");
    expect(review).toContain(`([Checks](${ORIGIN}/help/work.md))`);
    // Vizzy's Work tools are off: no suggestions to read about.
    expect(review).not.toContain("Tasks Vizzy suggests");
  });

  it("has the sections the plan names, other pages link to, and each reads in house style", async () => {
    const { helpPageMarkdown } = await load(true, true);
    const text = helpPageMarkdown("work", ORIGIN)!;
    for (const heading of [
      "## Your tasks",
      "## Filter the list",
      "## Connected to and other links",
      "## How we'll know it worked",
      "## Checks",
      "## Decisions",
      "## The Log",
      "## Import your backlog",
      "## Work in Review, and Vizzy",
      "## Check it worked",
      "## If you see this",
    ]) {
      expect(text, heading).toContain(heading);
    }
    for (const line of text.split("\n")) expect(dashesIn(line), line).toEqual([]);
    expect(aiTellsIn(text)).toEqual([]);
    // The four kinds of win, the then and the one tap read are under How we'll know it worked.
    for (const words of ["**Used**", "**Moves a number**", "**Runs better**", "**Done is the win**", "**Add a then (optional)**", "**Too soon to tell**"]) {
      expect(text, words).toContain(words);
    }
    // What a measure's check says, in the check's own words.
    expect(text).toContain("Work counted 212 notes made from a template from Lumen Notes' product since 11 Nov.");
    expect(text).toContain("Work can't count orders for Fernhill Plants yet, so your read is the record.");
    // Review's three actions and the one tap reasons on Dismiss sit under Work in Review.
    const vizzy = text.slice(text.indexOf("## Work in Review"), text.indexOf("## Check it worked"));
    for (const words of ["**Add to Work**", "**Edit then add**", "**Dismiss**", "Not now, Not for us, Already on it, Wrong", "**No reason**", "in 30 days"]) {
      expect(vizzy, words).toContain(words);
    }
    // Approving a plan is a decision, never drafted.
    const decisions = text.slice(text.indexOf("## Decisions"), text.indexOf("## The Log"));
    expect(decisions).toContain("### Approve the plan");
    expect(decisions).toContain("Vizzy never drafts an approval.");
    // A plan link is under Connected to.
    const links = text.slice(text.indexOf("## Connected to"), text.indexOf("## How we'll know"));
    expect(links).toContain("**Plan**");
  });

  it("describes Vizzy's part only while Vizzy's Work tools are on, as the How to drawer is told", async () => {
    const { bodies, docs } = await load(true);
    const md = (workVizzy: boolean) => docs.docToMarkdown(bodies.HELP_BODIES.work!({ workVizzy }), ORIGIN);
    const off = md(false);
    expect(off).toContain("## Work in Review");
    expect(off).not.toContain("Work in Review, and Vizzy");
    for (const words of ["Tasks Vizzy suggests", "Edit then add", "Save to today's log"]) expect(off, words).not.toContain(words);
    const on = md(true);
    for (const words of ["Tasks Vizzy suggests", "**Edit then add**", "**Save to today's log**", "**Choose**"]) expect(on, words).toContain(words);
    const review = (work: boolean, workVizzy: boolean) => docs.docToMarkdown(bodies.HELP_BODIES["review-and-approvals"]!({ work, workVizzy }), ORIGIN);
    expect(review(true, true)).toContain("**Tasks Vizzy suggests**");
    expect(review(true, false)).not.toContain("Tasks Vizzy suggests");
    expect(review(false, true)).not.toContain("Tasks Vizzy suggests");
  });

  it("says how a task opens in place on the list only while quick edit is on, as the How to drawer is told", async () => {
    const { bodies, docs, helpPageMarkdown } = await load(true);
    const md = (workQuickEdit: boolean) => docs.docToMarkdown(bodies.HELP_BODIES.work!({ workQuickEdit }), ORIGIN);
    const off = md(false);
    expect(off).toContain("Open a task from the list to see its own page. All tasks takes you back.");
    expect(off).toContain("On a task's page, press **Edit** beside Description");
    for (const words of ["Change a task in the list", "Sort again", "Someone changed this task just now", "Keep editing"]) expect(off, words).not.toContain(words);
    const on = md(true);
    const tasks = on.slice(on.indexOf("## Your tasks"), on.indexOf("## Filter the list"));
    for (const words of [
      "### Change a task in the list",
      "**Open the full page**",
      "Enter saves, Esc puts the old title back",
      "Cmd+Enter (Ctrl+Enter on Windows)",
      "**Undo**",
      "Stage and Brand save half a second after your last pick",
      "**Keep editing** or **Discard**",
      "**Sort again**",
      "This task no longer matches your filters. It leaves the list when you close it.",
      "On a task's full page, press **Edit** beside Description to change the title, description and notes; in the list, click them instead.",
    ]) {
      expect(tasks, words).toContain(words);
    }
    expect(tasks).not.toContain("All tasks takes you back.");
    // Its two new messages, after Vizzy's, only with quick edit on.
    const messages = on.slice(on.indexOf("## If you see this"));
    expect(messages).toContain("Someone changed this task just now. Their change is showing, and your text is still in its box, so save again.");
    expect(messages).toContain("Someone changed this task just now. Their change is showing, so make your change again.");
    for (const line of on.split("\n")) expect(dashesIn(line), line).toEqual([]);
    expect(aiTellsIn(on)).toEqual([]);
    // The page itself reads the server's switch.
    vi.stubEnv("WORK_QUICK_EDIT_ENABLED", "true");
    expect(helpPageMarkdown("work", ORIGIN)).toContain("### Change a task in the list");
    vi.stubEnv("WORK_QUICK_EDIT_ENABLED", "false");
    expect(helpPageMarkdown("work", ORIGIN)).not.toContain("### Change a task in the list");
  });

  it("says Make it an idea or a launch in the words people read", async () => {
    const { bodies, docs } = await load(true);
    const md = (ideaWords: boolean) => docs.docToMarkdown(bodies.HELP_BODIES.work!({ ideaWords }), ORIGIN);
    expect(md(true)).toContain("**Make it an idea**");
    expect(md(false)).toContain("**Make it a launch**");
  });
});
