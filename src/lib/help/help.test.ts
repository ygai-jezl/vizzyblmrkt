import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { HELP_BODIES } from "@/components/help/bodies";
import { Messages } from "@/components/help/blocks";
import { HELP_LOADERS } from "@/components/help/loaders";
import { H2 } from "@/components/developers/Doc";
import { SETUP_HOW_TO } from "@/lib/connect/setupChecklist";
import { computeGrowth, type GrowthSignals } from "@/lib/nav/growth";
import { launchChecklist } from "@/lib/nav/launchChecklist";
import { docToMarkdown } from "@/lib/developers/markdown";
import { helpLlmsTxt, helpPageMarkdown } from "./agentFiles";
import { HELP_PAGES, helpPage, shownHelpPages } from "./pages";
import { HELP_PLACES, helpFor, parseHelpPath } from "./places";
import { isPeopleNameEnabled } from "@/lib/audience/flags";


/**
 * Keeps the help pages true to the app: every link and section exists, every
 * route a page sends you to is real, every message a page quotes is still one
 * the app shows, and the copy keeps to house style (no dashes as punctuation).
 */

// The pages are read with every switched section shown (Brand › What we've seen points at one), so
// their links and copy are checked too.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_BRAND_NOTES_ENABLED = "true";
  process.env.NEXT_PUBLIC_COMPETITORS_ENABLED = "true";
  process.env.NEXT_PUBLIC_BRAND_NOTES_QUESTIONS_ENABLED = "true";
  process.env.NEXT_PUBLIC_BRAND_NOTES_REST_ENABLED = "true";
  process.env.NEXT_PUBLIC_BRAND_MAP_SITUATION_ASK_ENABLED = "true";
  process.env.NEXT_PUBLIC_BLOG_AI_SUMMARY_LINKS_ENABLED = "true";
  process.env.LAUNCH_SITE_SIGNUPS_ENABLED = "true";
  process.env.AUDIENCE_PERSON_LINKS_ENABLED = "true";
  process.env.AUDIENCE_ONE_VIEW_ENABLED = "true";
  process.env.ONTOLOGY_PERSON_IDS_ENABLED = "true";
  process.env.AUDIENCE_FIELDS_ENABLED = "true";
  process.env.AUDIENCE_FIELD_FILTERS_ENABLED = "true";
  process.env.AUDIENCE_ADD_PERSON_ENABLED = "true";
  process.env.AUDIENCE_TIMELINE_ENABLED = "true";
  process.env.AUDIENCE_VIZZY_FIELDS_ENABLED = "true";
  process.env.NEXT_PUBLIC_EDIT_MODE_ENABLED = "true";
  process.env.NEXT_PUBLIC_EDIT_MODE_EMAILS_ENABLED = "true";
  process.env.NEXT_PUBLIC_NEWSLETTER_MARKDOWN_EMAIL_ENABLED = "true";
  process.env.NEXT_PUBLIC_EDIT_MODE_VIZZY_ENABLED = "true";
  process.env.EDIT_MODE_VIZZY_LEARNING_ENABLED = "true";
  process.env.NEXT_PUBLIC_SEARCH_ENABLED = "true";
  process.env.BRAND_SIGNALS_ENABLED = "true";
  process.env.SIGNALS_DATAFORSEO_ENABLED = "true";
  process.env.BRAND_MAP_NEXT_UP_ENABLED = "true";
  process.env.CREATE_ARTICLE_AUTOPILOT_ENABLED = "true";
  process.env.NEXT_PUBLIC_PLANS_ENABLED = "true";
});

const SRC = join(process.cwd(), "src");

interface El {
  type: unknown;
  props: Record<string, unknown> & { children?: ReactNode };
}
const isEl = (n: unknown): n is El => typeof n === "object" && n !== null && "type" in n && "props" in n;

/** Every element in a page, plain components rendered (the pages and blocks use no hooks). */
function elements(node: ReactNode, out: El[] = []): El[] {
  if (Array.isArray(node)) {
    for (const n of node) elements(n as ReactNode, out);
    return out;
  }
  if (!isEl(node)) return out;
  out.push(node);
  if (typeof node.type === "function" && typeof node.props.href !== "string") {
    elements((node.type as (p: unknown) => ReactNode)(node.props), out);
  } else {
    elements(node.props.children, out);
  }
  return out;
}

const pages = HELP_PAGES.map((p) => ({ page: p, els: elements(HELP_BODIES[p.slug]!()) }));
const anchorsOf = (slug: string) =>
  new Set(pages.find((x) => x.page.slug === slug)?.els.filter((e) => e.type === H2).map((e) => String(e.props.id)) ?? []);

function expectHelpPath(path: string, where: string) {
  const parsed = parseHelpPath(path);
  expect(parsed, `${where}: ${path}`).not.toBeNull();
  expect(Object.hasOwn(HELP_BODIES, parsed!.slug), `${where}: no page for ${path}`).toBe(true);
  if (parsed!.anchor) expect(anchorsOf(parsed!.slug).has(parsed!.anchor), `${where}: no section for ${path}`).toBe(true);
}

/** /admin/launches/new → src/app/admin/launches/new/page.tsx exists. */
function adminRouteExists(href: string): boolean {
  const path = href.split(/[?#]/)[0]!.replace(/\/$/, "");
  return existsSync(join(SRC, "app", path, "page.tsx"));
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe("the help pages", () => {
  it("each has a body, a drawer loader, a page route and a Markdown copy", () => {
    for (const p of HELP_PAGES) {
      expect(Object.hasOwn(HELP_BODIES, p.slug), p.path).toBe(true);
      expect(Object.hasOwn(HELP_LOADERS, p.slug), p.path).toBe(true);
      expect(existsSync(join(SRC, "app", p.path, "page.tsx")), p.path).toBe(true);
      expect(existsSync(join(SRC, "app", `${p.path}.md`, "route.ts")), `${p.path}.md`).toBe(true);
    }
    expect(Object.keys(HELP_BODIES).sort()).toEqual(HELP_PAGES.map((p) => p.slug).sort());
  });

  it("render as Markdown, one heading first, and are listed in llms.txt", () => {
    const index = helpLlmsTxt("https://app.example.com");
    for (const p of HELP_PAGES) {
      const md = helpPageMarkdown(p.slug, "https://app.example.com")!;
      expect(md, p.path).toMatch(/^# \S/);
      expect(index).toContain(`https://app.example.com${p.path}.md`);
    }
  });

  it("link only to help sections that exist and app pages that exist", () => {
    for (const { page, els } of pages) {
      for (const el of els) {
        const href = el.props.href;
        if (typeof href !== "string") continue;
        if (href.startsWith("/help")) expectHelpPath(href, page.path);
        else if (href.startsWith("/admin")) expect(adminRouteExists(href), `${page.path} links to ${href}`).toBe(true);
        else if (href.startsWith("/developers")) expect(existsSync(join(SRC, "app", href.split("#")[0]!, "page.tsx")), href).toBe(true);
      }
    }
  });

  it("quote only messages the app really shows", () => {
    const corpus = sourceFiles(SRC)
      .filter((f) => !f.includes(join("components", "help")) && !f.includes(join("app", "help")))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n")
      // Apostrophes and quotes may be written as entities or escapes in source.
      .replace(/&apos;|&#39;|\\'/g, "'")
      .replace(/&quot;|\\"/g, '"');
    for (const { page, els } of pages) {
      for (const el of els.filter((e) => e.type === Messages)) {
        for (const [message] of el.props.rows as Array<[string, ReactNode]>) {
          expect(corpus.includes(message), `${page.path} quotes "${message}", which isn't in src`).toBe(true);
        }
      }
    }
  });

  it("use no dashes as punctuation", () => {
    for (const p of HELP_PAGES) {
      const text = helpPageMarkdown(p.slug, "https://app.example.com")!;
      for (const line of text.split("\n")) {
        expect(/[–—]/.test(line), `${p.path}: ${line}`).toBe(false);
        expect(/\S - \S/.test(line), `${p.path}: ${line}`).toBe(false);
      }
    }
  });
});

describe("People in place of Audience", () => {
  const PEOPLE_PAGES = ["your-audience", "people", "connect-your-product", "plan-and-usage"];
  const md = (slug: string, people: boolean) => docToMarkdown(HELP_BODIES[slug]!({ people }), "https://app.example.com");

  it("the pages that name the area say People while it is on, and never Audience", () => {
    for (const slug of PEOPLE_PAGES) {
      const text = md(slug, true);
      expect(text, slug).not.toMatch(/\bAudience\b/);
      for (const line of text.split("\n")) {
        expect(/[–—]/.test(line) || /\S - \S/.test(line), `${slug}: ${line}`).toBe(false);
      }
    }
    expect(md("your-audience", true)).toMatch(/^# People\n/);
    expect(md("people", true)).toContain("See [People](https://app.example.com/help/your-audience.md)");
  });

  it("keep Audience while it is off", () => {
    expect(md("your-audience", false)).toMatch(/^# Your audience\n/);
    expect(md("your-audience", false)).toContain("Audience");
    expect(md("connect-your-product", false)).toContain("A page for each user in Audience");
  });

  it("list the People list's page as People, keeping its slug", () => {
    expect(helpPage("your-audience", { people: true })).toMatchObject({ label: "People", path: "/help/your-audience" });
    expect(helpPage("your-audience", { people: false })?.label).toBe("Your audience");
    // The server's answer, used by the /help navigation, llms.txt and the page title.
    expect(shownHelpPages().find((p) => p.slug === "your-audience")?.label).toBe("Your audience");
    vi.stubEnv("NEXT_PUBLIC_NAV_V2_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_NAV_V2_PHASE2_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_NAV_V2_PHASE3_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_NAV_PEOPLE_ENABLED", "true");
    try {
      expect(shownHelpPages().find((p) => p.slug === "your-audience")?.label).toBe("People");
      expect(helpPage("your-audience")?.label).toBe("People");
      expect(md("your-audience", isPeopleNameEnabled())).toMatch(/^# People\n/);
      expect(helpPageMarkdown("your-audience", "https://app.example.com")).toMatch(/^# People\n/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("links into the help", () => {
  const SETUP = {
    domainVerified: false,
    senderDetails: false,
    logo: false,
    voice: false,
    emailStyle: false,
    knowledge: false,
    brandMapSaved: false,
    social: false,
    git: false,
  };
  const SIGNALS: GrowthSignals = {
    activeLaunches: 0,
    firstLaunchId: null,
    welcomeEmailLive: false,
    signups: 0,
    workspaces: 0,
    firstWorkspaceId: null,
    postsScheduled: 0,
    newslettersSent: 0,
    lifecycle: true,
    products: 0,
    firstProductId: null,
    catalogReady: false,
    eventsReceived: false,
    journeys: 0,
    firstJourneyId: null,
    journeyPublished: false,
    journeyLive: false,
    invited: 0,
    setup: SETUP,
  };

  it("every Home step, checklist step and page's How to points at a real section", () => {
    for (const st of computeGrowth(SIGNALS).stages.flatMap((s) => s.steps)) expectHelpPath(st.howTo!, `Home: ${st.label}`);
    const launch = launchChecklist({
      campaignId: "c1",
      signups: 1,
      welcomeLive: false,
      spotsPerReferral: 0,
      newslettersSent: 0,
      invites: { lockText: null, invited: 0, signedUp: 0 },
      guide: true,
    });
    for (const st of launch) expectHelpPath(st.howTo!, `Launch checklist: ${st.label}`);
    for (const [id, path] of Object.entries(SETUP_HOW_TO)) expectHelpPath(path, `Product setup: ${id}`);
    for (const path of HELP_PLACES) expectHelpPath(path, "How to button");
  });

  it("Home's steps link to app pages that exist", () => {
    for (const st of computeGrowth(SIGNALS).stages.flatMap((s) => s.steps)) {
      expect(adminRouteExists(st.href), `${st.label}: ${st.href}`).toBe(true);
    }
  });

  it("the How to button picks the most specific page", () => {
    expect(helpFor("/admin")).toBe("/help");
    expect(helpFor("/admin/account")).toBe("/help/email-sending");
    expect(helpFor("/admin/account/connections")).toBe("/help/connected-accounts");
    expect(helpFor("/admin/launches/c1/invites")).toBe("/help/invite-your-waitlist");
    expect(helpFor("/admin/workspace/w1/curate/grounding")).toBe("/help/programmes-and-knowledge#knowledge");
    expect(helpFor("/admin/workspace/w1/curate/idea-board")).toBe("/help/write-and-schedule#write");
    expect(helpFor("/admin/lifecycle/j1")).toBe("/help/onboarding-journeys");
    expect(helpFor("/admin/somewhere-new")).toBe("/help");
  });

  it("opens the People list's page from the People area only with People on", () => {
    expect(helpFor("/admin/crm")).toBe("/help/people");
    expect(helpFor("/admin/crm/people/pu_3f9a")).toBe("/help/people");
    expect(helpFor("/admin/crm", { people: true })).toBe("/help/your-audience");
    expect(helpFor("/admin/crm/people/ct_9b2e", { people: true })).toBe("/help/your-audience");
    // Only the People area changes.
    expect(helpFor("/admin/lifecycle/j1", { people: true })).toBe("/help/onboarding-journeys");
    expect(HELP_PLACES).toEqual(expect.arrayContaining(["/help/people", "/help/your-audience"]));
  });

  it("sends Plan and usage and Add Brand to the plans page while its switch is on", () => {
    expect(helpFor("/admin/account/billing")).toBe("/help/plan-and-usage");
    expect(helpFor("/admin/brands/new")).toBe("/help/plan-and-usage#brands");
    expect(HELP_PLACES).toContain("/help/plan-and-usage");
  });
});

describe("the fields sections", () => {
  const md = (fields: boolean, fieldFilters = fields) => docToMarkdown(HELP_BODIES["your-audience"]!({ people: true, fields, fieldFilters }), "https://app.example.com");

  it("show while fields are on, and How to on Data model opens them", () => {
    expect(md(true)).toContain("## Your own fields");
    expect(md(true)).toContain("## Company fields");
    expect(helpFor("/admin/account/data-model")).toBe("/help/your-audience#fields");
  });

  it("stay hidden while fields are off", () => {
    expect(md(false)).not.toContain("Data model");
    expect(md(false)).not.toContain("Company fields");
  });

  it("explain filters only while field filters are on", () => {
    expect(md(true, true)).toContain("## Filter by a field or a group");
    expect(md(true, true)).toContain("Everyone in this group");
    expect(md(true, false)).not.toContain("Filter by a field");
    expect(md(true, false)).toContain("Tick **Only people we can email**");
  });
});

describe("the New person section", () => {
  const md = (slug: string, addPerson: boolean) => docToMarkdown(HELP_BODIES[slug]!({ people: true, fields: true, fieldFilters: true, addPerson }), "https://app.example.com");

  it("shows while New person is on, with the four ways to agree and the plan's people", () => {
    const text = md("your-audience", true);
    expect(text).toContain("## Add someone by hand");
    for (const way of ["Told me in person", "Signed a form", "Replied by email", "Other"]) expect(text).toContain(`**${way}**`);
    expect(text).toContain("Nothing is sent to them yet");
    expect(md("plan-and-usage", true)).toContain("New person");
  });

  it("stays hidden while it is off", () => {
    expect(md("your-audience", false)).not.toContain("Add someone by hand");
    expect(md("your-audience", false)).not.toContain("New person");
    expect(md("plan-and-usage", false)).not.toContain("New person");
  });
});

describe("the timeline section", () => {
  const md = (timeline: boolean) => docToMarkdown(HELP_BODIES["your-audience"]!({ people: true, fields: true, fieldFilters: true, addPerson: true, timeline }), "https://app.example.com");

  it("shows while the timeline is on, saying when it starts and that erase removes it", () => {
    expect(md(true)).toContain("## The timeline");
    expect(md(true)).toContain("from the day the timeline was turned on");
    expect(md(true)).toContain("erasing them removes it");
  });

  it("stays hidden while it is off", () => {
    expect(md(false)).not.toContain("timeline");
  });
});

describe("the Vizzy and their fields section", () => {
  const md = (slug: string, vizzyFields: boolean) =>
    docToMarkdown(HELP_BODIES[slug]!({ people: true, fields: true, fieldFilters: true, addPerson: true, timeline: true, vizzyFields }), "https://app.example.com");

  it("shows while Vizzy's field suggestions are on: what Vizzy sees, that an admin confirms, and undo", () => {
    const text = md("your-audience", true);
    expect(text).toContain("## Vizzy and their fields");
    expect(text).toContain("select, multi select, status, checkbox, number, currency and date fields");
    expect(text).toContain("never sees text");
    expect(text).toContain("Nothing changes until then");
    expect(text).toContain("**Undo** within 7 days");
    expect(md("review-and-approvals", true)).toContain("**Suggestions about people**");
  });

  it("stays hidden while they are off", () => {
    expect(md("your-audience", false)).not.toContain("Vizzy suggests");
    expect(md("review-and-approvals", false)).not.toContain("Suggestions about people");
  });
});
