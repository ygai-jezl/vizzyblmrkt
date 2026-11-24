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
import { aiTellsIn, dashesIn } from "@/lib/content/writingRules";
import { STATE_LABELS } from "@/components/admin/connectors/words";
import { SOURCE_COPY } from "@/components/admin/chat/SourceLine";
import { HEALTH_HELP, SEARCH_TEXT_HELP, SIGNALS_HELP, VIZZY_COLLECTED_HELP } from "@/lib/connectors/helpText";
import { allConnectors } from "@/lib/connectors/catalog";
import { CONNECTOR_ERRORS, tokenRefusedMessage } from "@/lib/connectors/messages";
import { helpLlmsTxt, helpPageMarkdown } from "./agentFiles";
import { HELP_PAGES, helpPage, shownHelpPages } from "./pages";
import { HELP_PLACES, helpFor, parseHelpPath } from "./places";
import { isPeopleNameEnabled } from "@/lib/audience/flags";
import { VIZZY_READS_HINT } from "@/components/admin/audience/fieldsApi";


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
  process.env.AUDIENCE_VIZZY_TEXT_FIELDS_ENABLED = "true";
  process.env.AUDIENCE_VIZZY_ADD_PERSON_ENABLED = "true";
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
  process.env.BRAND_MAP_ENABLED = "true";
  process.env.BRAND_MAP_PAGES_ENABLED = "true";
  process.env.BLOG_LIVE_WATCH_ENABLED = "true";
  process.env.NEXT_PUBLIC_PLANS_ENABLED = "true";
  process.env.NEXT_PUBLIC_CONNECTORS_ENABLED = "true";
  process.env.CONNECTORS_ENABLED = "true";
  process.env.CONNECTORS_CHAT_ENABLED = "true";
  process.env.CONNECTORS_COLLECT_ENABLED = "true";
  process.env.CONNECTORS_SEARCH_TEXT_ENABLED = "true";
  process.env.CONNECTOR_SIGNALS_ENABLED = "true";
  process.env.BRAND_MAP_SCALE_ENABLED = "true";
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

  it("never hand a body that takes props to Next.js as the page itself", () => {
    // Next.js checks a page's props against its own PageProps, so `export default SomeHelp` breaks
    // the build once SomeHelp takes HelpBodyProps. Such a body is wrapped in a Page of its own.
    for (const p of HELP_PAGES) {
      const route = readFileSync(join(SRC, "app", p.path, "page.tsx"), "utf8");
      const direct = route.match(/^export default ([A-Za-z0-9_]+);/m)?.[1];
      if (!direct) continue;
      const from = route.match(new RegExp(`import ${direct} from "@/(components/help/pages/[^"]+)"`))?.[1];
      expect(from, `${p.path}: ${direct} is not a help body`).toBeDefined();
      const body = readFileSync(join(SRC, `${from}.tsx`), "utf8");
      expect(body.includes("HelpBodyProps"), `${p.path}: wrap ${direct} in export default function Page()`).toBe(false);
    }
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
    // Messages the app builds from a manifest's name, as a turned down token's are, count as shown.
    const generated = new Set(
      allConnectors().flatMap((m) => [true, false].flatMap((chat) => [tokenRefusedMessage(m.name, "connected", chat), tokenRefusedMessage(m.name, "connecting", chat)])),
    );
    for (const { page, els } of pages) {
      for (const el of els.filter((e) => e.type === Messages)) {
        for (const [message] of el.props.rows as Array<[string, ReactNode]>) {
          expect(corpus.includes(message) || generated.has(message), `${page.path} quotes "${message}", which isn't in src`).toBe(true);
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

  it("sends Browse, a connector's pages and Connected to Connected data, and Accounts to Connected accounts", () => {
    expect(helpFor("/admin/account/connections")).toBe("/help/connected-accounts");
    expect(helpFor("/admin/account/connections/browse")).toBe("/help/connected-data#connect");
    expect(helpFor("/admin/account/connections/search-console")).toBe("/help/connected-data#connect");
    expect(helpFor("/admin/account/connections/google-analytics/pick")).toBe("/help/connected-data#connect");
    expect(helpFor("/admin/account/connections/connected")).toBe("/help/connected-data#connected");
  });

  it("sends Plan and usage and Add Brand to the plans page while its switch is on", () => {
    expect(helpFor("/admin/account/billing")).toBe("/help/plan-and-usage");
    expect(helpFor("/admin/brands/new")).toBe("/help/plan-and-usage#brands");
    expect(HELP_PLACES).toContain("/help/plan-and-usage");
  });
});

describe("catalog history on Connect your product", () => {
  const md = (catalogHistory: boolean) => docToMarkdown(HELP_BODIES["connect-your-product"]!({ catalogHistory }), "https://app.example.com");

  it("follows what it is told, so the How to drawer can pass the server's switch", () => {
    expect(md(true)).toContain("Every save of the catalog is kept under **History**");
    expect(md(false)).not.toContain("Every save of the catalog");
  });
});

describe("the fields sections", () => {
  const md = (fields: boolean, fieldFilters = fields) => docToMarkdown(HELP_BODIES["your-audience"]!({ people: true, fields, fieldFilters }), "https://app.example.com");

  it("name fields in the page's summary only while they are on", () => {
    expect(helpPage("your-audience", { fields: false })?.summary).not.toContain("fields");
    expect(helpPage("your-audience", { fields: true })?.summary).toContain("your own fields on people and companies");
    // The server's answer, used by llms.txt, the page's description and the list Vizzy reads.
    expect(shownHelpPages().find((p) => p.slug === "your-audience")?.summary).toContain("your own fields");
    vi.stubEnv("AUDIENCE_FIELDS_ENABLED", "false");
    try {
      expect(shownHelpPages().find((p) => p.slug === "your-audience")?.summary).not.toContain("fields");
      expect(helpPage("your-audience")?.summary).not.toContain("fields");
    } finally {
      vi.unstubAllEnvs();
    }
  });

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

  it("lists what Vizzy suggested only while a Vizzy switch for people is on", () => {
    const at = (over: Record<string, boolean>) =>
      docToMarkdown(HELP_BODIES["your-audience"]!({ people: true, fields: true, fieldFilters: true, addPerson: true, timeline: true, vizzyFields: false, vizzyAddPerson: false, ...over }), "https://app.example.com");
    expect(at({})).not.toContain("what Vizzy suggested");
    expect(at({ vizzyFields: true })).toContain("what Vizzy suggested");
    expect(at({ vizzyAddPerson: true })).toContain("what Vizzy suggested");
  });
});

describe("the Vizzy and their fields section", () => {
  const md = (slug: string, vizzyFields: boolean, vizzyTextFields = false) =>
    docToMarkdown(
      HELP_BODIES[slug]!({ people: true, fields: true, fieldFilters: true, addPerson: true, timeline: true, vizzyFields, vizzyTextFields, vizzyAddPerson: false }),
      "https://app.example.com",
    );

  it("shows while Vizzy's field suggestions are on: what Vizzy sees, that an admin confirms, and undo", () => {
    const text = md("your-audience", true);
    expect(text).toContain("## Vizzy and their fields");
    expect(text).toContain("select, multi select, status, checkbox, number, currency and date fields");
    expect(text).toContain("never sees text");
    expect(text).toContain("Nothing changes until then");
    expect(text).toContain("**Undo** within 7 days");
    expect(md("review-and-approvals", true)).toContain("**Suggestions about people**");
    // A suggestion set aside because Vizzy can no longer read a field: asking again won't help.
    expect(text).toContain("or Vizzy can no longer read one. Ask Vizzy again if it still fits, or set the value under Fields.");
    expect(text).toContain("If Vizzy can no longer read the field, set the value yourself under Fields.");
  });

  it("explains Vizzy can read this field while text fields are on, and keeps email, phone, link and team member out", () => {
    const text = md("your-audience", true, true);
    expect(text).toContain("select, multi select, status, checkbox, number, currency and date fields, and text fields an admin");
    expect(text).toContain("**Vizzy can read this field**");
    expect(text).toContain("never sees other text fields, or email, phone, link or team member fields, whatever is ticked");
    expect(text).toContain("at most 500 characters");
    expect(text).toContain("It starts unticked");
    // The hint Data model shows beside the tick, word for word.
    expect(text).toContain(`"${VIZZY_READS_HINT}"`);
    expect(text).toContain("The **Vizzy reads** column");
    expect(text).toContain("never tick it again");
    expect(text).toContain("since Vizzy made it, or an admin unticked Vizzy can read this field for one of them, confirming sets");
    expect(text).not.toContain("never sees text");
    // Off, or without Vizzy's fields: as before.
    expect(md("your-audience", true, false)).not.toContain("Vizzy can read this field");
    expect(md("your-audience", true, false)).toContain("since Vizzy made it, confirming sets");
    expect(md("your-audience", false, true)).not.toContain("Vizzy can read this field");
  });

  it("stays hidden while they are off", () => {
    expect(md("your-audience", false)).not.toContain("Vizzy suggests");
    expect(md("review-and-approvals", false)).not.toContain("Suggestions about people");
  });
});

describe("Vizzy filling in New person", () => {
  const md = (slug: string, vizzyAddPerson: boolean, addPerson = true) =>
    docToMarkdown(HELP_BODIES[slug]!({ people: true, fields: true, fieldFilters: true, addPerson, timeline: true, vizzyFields: false, vizzyAddPerson }), "https://app.example.com");

  it("shows while it is on: you confirm, you record how they agreed, and what was typed goes", () => {
    const text = md("your-audience", true);
    expect(text).toContain("Vizzy never records that someone agreed");
    expect(text).toContain("nobody is added until you confirm");
    expect(text).toContain("or after 7 days");
    expect(md("review-and-approvals", true)).toContain("New person forms Vizzy filled in");
  });

  it("lists data sources that need you only while collected numbers are on", () => {
    const review = (on: boolean) => docToMarkdown(HELP_BODIES["review-and-approvals"]!({ connectorsCollect: on }), "https://app.example.com");
    expect(review(true)).toContain("**Data sources that need you**: a connected tool that can't be read");
    expect(review(true)).toContain("([Collected numbers](https://app.example.com/help/connected-data.md))");
    expect(review(false)).not.toContain("Data sources that need you");
  });

  it("stays hidden while it, or New person, is off", () => {
    expect(md("your-audience", false)).not.toContain("Vizzy never records");
    expect(md("your-audience", true, false)).not.toContain("Vizzy never records");
    expect(md("review-and-approvals", false)).not.toContain("Suggestions about people");
  });
});

describe("Connected data", () => {
  const md = (connectorsChat: boolean) => docToMarkdown(HELP_BODIES["connected-data"]!({ connectorsChat }), "https://app.example.com");

  it("takes every connector's steps, role and numbers from its manifest", () => {
    const text = md(true);
    expect(text).toMatch(/^# Connected data\n/);
    // In Browse's order, with Google Analytics named as the approved screens name it.
    const at = ["## Google Search Console", "## Google Analytics 4", "## Cloudflare"].map((name) => text.indexOf(name));
    expect(at.every((i) => i > 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(text).toContain("Give the token three permissions: Zone Read, so YouGrow can list your zones; Zone Analytics Read, so it can read their numbers; and Account Analytics Read, asked for now so later features don't need a new token. Nothing reads with it today.");
    expect(text).toContain("Paste the token here and press Check. Pick your site's zone from the list, then press Connect.");
    // The Zone ID line fits both ways to it: the token can't list zones, or yours isn't among those listed.
    expect(text).toContain("**Zone ID**: Typed only when Check doesn't list your zone. Find it on your site's Overview page in Cloudflare, in the API box on the right.");
    expect(text).not.toContain("Only when the token can't list your zones");
    expect(text).toContain("This token can't list your zones (that needs Zone Read), so type your site's Zone ID instead.");
    expect(text).toContain("Type the Zone ID, or make the token again with Zone Read, Zone Analytics Read and Account Analytics Read to pick from a list.");
    // The link fills in all three permissions, so the words say permissions.
    expect(text).toContain("Your account's analytics | Read only. Asked for now so later features don't need a new token. Nothing is read with it today.");
    expect(text).toContain("The link on the Cloudflare page opens Cloudflare's token form with the permissions filled in: [make a token](https://dash.cloudflare.com/profile/api-tokens?");
  });

  it("says where Accounts and Sending are, and quotes a turned down token in its tool's own words", () => {
    const text = md(true);
    expect(text).toContain("Your accounts for code and posts (GitHub, GitLab, LinkedIn and X) stay under **Accounts**");
    expect(text).toContain("Email sending is set up under [Settings › Sending]");
    expect(text).not.toMatch(/Mailchimp/);
    expect(text).toContain("Cloudflare turned the token down. Vizzy can't read it until you reconnect.");
    expect(md(false)).toContain("Cloudflare turned the token down. Nobody can read it until you reconnect.");
    // With two connections to one tool, Connected says which one.
    expect(text).toContain('each banner and activity line on Connected says which one, as in "Cloudflare for acme.example paused".');
    expect(text).toContain(tokenRefusedMessage("Cloudflare", "connecting", true));
    // Only token connectors can have a token turned down.
    expect(text).not.toContain("Google Search Console turned the token down");
    expect(text).toContain("Open Google Search Console under Settings › Connections › Browse, then press Sign in with Google.");
    expect(text).toContain("The address gets the **Restricted** role");
    expect(text).toContain("The address gets the **Viewer** role");
    expect(text).toContain("**Analytics sessions**");
    expect(text).toContain("at most 100 sign ins for one Google account");
    expect(text).toContain("myaccount.google.com/permissions");
  });

  it("lists only the statuses Connected shows, and says where a disconnected connection goes", () => {
    const text = md(true);
    for (const label of STATE_LABELS) expect(text, label).toMatch(new RegExp(`^\\| ${label} \\|`, "m"));
    // Connected lists only connections still connected, so Disconnected is never a status there.
    expect(text).not.toMatch(/^\| Disconnected \|/m);
    expect(text).toContain(HEALTH_HELP.disconnected);
  });

  it("says which days a read covers for each tool, as its own report counts them", () => {
    const text = md(false);
    expect(text).toContain("the same days as Search Console's own report: complete days in Pacific time, ending on its last complete day");
    expect(text).toContain("end yesterday in the property's own time zone, as Google Analytics reports do");
    expect(text).toContain("Set Cloudflare's dashboard to UTC to compare them with its Traffic tab.");
    expect(text).toContain("**Cloudflare unique visitors**");
    expect(md(true)).toContain("YouGrow reads the same days as the tool's own report, in its time zone, and Vizzy says which days those are.");
  });

  it("says the chat names the tool the numbers came from, only while Vizzy reads connected data", () => {
    const line = "Under an answer that read a connection, the chat says which tool the numbers came from, with a link to that tool, so you can check them there.";
    expect(md(true)).toContain(line);
    expect(md(false)).not.toContain(line);
  });

  it("puts each connector's mark beside its heading on the page, and keeps the Markdown words only", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const page = renderToStaticMarkup(HELP_BODIES["connected-data"]!({ connectorsChat: true }) as never);
    for (const c of allConnectors()) {
      const heading = page.match(new RegExp(`<h2 id="${c.id}"[^>]*>((?:(?!</h2>).)*)</h2>`))![1]!;
      expect(heading, c.id).toContain(`<img src="${c.icon!.light}" alt=""`);
      expect(heading.replace(/<[^>]+>/g, ""), c.id).toBe(c.name);
    }
    const text = md(true);
    for (const c of allConnectors()) expect(text, c.id).toMatch(new RegExp(`^## ${c.name}$`, "m"));
    expect(text).not.toContain("![");
    expect(text).not.toContain("/marks/");
  });

  it("explains letting Vizzy read only while Vizzy reads connected data", () => {
    expect(md(true)).toContain("## Letting Vizzy read it");
    expect(md(true)).toContain("Vizzy can read it when someone asks");
    expect(md(false)).not.toContain("Letting Vizzy read it");
    expect(md(false)).not.toContain("Vizzy can read it when someone asks");
  });

  it("says what is collected, when, for how long and what erases it, only while collected numbers are on", () => {
    const collected = (on: boolean) => docToMarkdown(HELP_BODIES["connected-data"]!({ connectorsChat: true, connectorsCollect: on }), "https://app.example.com");
    const text = collected(true);
    expect(text).toContain("## Collected numbers");
    expect(text).toContain("keeps them 90 days in your brand's region");
    expect(text).toContain("Collected once a day and kept 90 days in your brand's region; Disconnect deletes them. Search Console finishes a day 2 to 3 days later. Each day keeps the top 500 pages and the top 500 searches.");
    expect(text).toContain("Each day keeps the zone's totals. Visits by people reach back about 31 days, and older days count all traffic.");
    expect(text).toMatch(/^\| Filling 90 days: 34 of 90 \|/m);
    expect(text).toContain("Disconnect deletes everything YouGrow collected for a connection, at once, whatever any switch says.");
    expect(text).toContain("Data sources that need you");
    const off = collected(false);
    expect(off).not.toContain("Collected numbers");
    expect(off).not.toContain("kept 90 days");
    // Lost access is quoted whatever collect says: Check access can find it too.
    expect(off).toContain(CONNECTOR_ERRORS.share_access_lost);
  });

  it("explains Vizzy and collected numbers only while Vizzy reads connected data and numbers are collected", () => {
    const page = (connectorsChat: boolean, connectorsCollect: boolean) => docToMarkdown(HELP_BODIES["connected-data"]!({ connectorsChat, connectorsCollect }), "https://app.example.com");
    const text = page(true, true);
    expect(text).toContain("## Vizzy and your collected numbers");
    expect(text).toContain(VIZZY_COLLECTED_HELP.what);
    expect(text).toContain("Collected numbers, 24 Oct to 20 Nov 2026, Pacific time. Search Console finishes a day 2 to 3 days later, so 21 and 22 Nov aren't in yet.");
    expect(text).toContain("Active users and unique visitors can't be added across days, so for more than a day Vizzy reads those live too.");
    // The source line's own words, and the grant that allows it, as Connected names it.
    expect(text).toContain(`the chat puts ${SOURCE_COPY.collected} after the tool's name`);
    expect(text).toContain("tick **Vizzy can read it when someone asks**");
    expect(text).toContain("as [Who can read it](https://app.example.com/help/connected-data.md) explains.");
    for (const [chat, collect] of [
      [false, true],
      [true, false],
      [false, false],
    ] as const) {
      expect(page(chat, collect), `${chat} ${collect}`).not.toContain("Vizzy and your collected numbers");
    }
    for (const line of Object.values(VIZZY_COLLECTED_HELP)) {
      expect(dashesIn(line), line).toEqual([]);
      expect(aiTellsIn(line), line).toEqual([]);
    }
  });

  it("says what Search Console puts into brand search, who finds it and what removes it, only while both switches are on", () => {
    const page = (connectorsChat: boolean, connectorsCollect: boolean, connectorsSearchText: boolean) =>
      docToMarkdown(HELP_BODIES["connected-data"]!({ connectorsChat, connectorsCollect, connectorsSearchText }), "https://app.example.com");
    const text = page(true, true, true);
    expect(text).toContain("## Google searches in brand search");
    expect(text).toContain("puts the top 200 searches of its last 28 collected days into brand search");
    expect(text).toContain("labelled Research");
    expect(text).toContain(SEARCH_TEXT_HELP.why);
    expect(text).toContain(SEARCH_TEXT_HELP.vizzy);
    expect(text).toContain("Disconnect and Change property take them out of brand search at once, whatever any switch says.");
    expect(text).toContain("[What search covers](https://app.example.com/help/search.md)");
    // Vizzy's line only while Vizzy reads connected data.
    expect(page(false, true, true)).not.toContain(SEARCH_TEXT_HELP.vizzy);
    expect(page(false, true, true)).toContain(SEARCH_TEXT_HELP.who);
    for (const [collect, searchText] of [
      [true, false],
      [false, true],
    ] as const) {
      expect(page(true, collect, searchText), `${collect} ${searchText}`).not.toContain("Google searches in brand search");
    }
    for (const line of Object.values(SEARCH_TEXT_HELP)) {
      expect(dashesIn(line), line).toEqual([]);
      expect(aiTellsIn(line), line).toEqual([]);
    }
  });

  it("is listed after Connected accounts, and Connected accounts points to it", () => {
    const slugs = shownHelpPages().map((p) => p.slug);
    expect(slugs.indexOf("connected-data")).toBe(slugs.indexOf("connected-accounts") + 1);
    expect(helpPageMarkdown("connected-accounts", "https://app.example.com")).toContain("[Connected data](https://app.example.com/help/connected-data.md)");
  });
});

describe("Search", () => {
  it("lists Search Console's searches under What search covers, and who finds them, only while they go into brand search", () => {
    const md = (connectorsSearchText: boolean) => docToMarkdown(HELP_BODIES.search!({ connectorsSearchText }), "https://app.example.com");
    const on = md(true);
    expect(on).toContain("Google searches from your [Search Console connection](https://app.example.com/help/connected-data.md)");
    expect(on).toContain(SEARCH_TEXT_HELP.why);
    expect(on).toContain(SEARCH_TEXT_HELP.who);
    // People's own words stay out either way.
    expect(on).toContain("It leaves out people's own words");
    const off = md(false);
    expect(off).not.toContain("Google searches");
    expect(off).not.toContain(SEARCH_TEXT_HELP.why);
  });
});

describe("What your numbers suggest (CONNECTOR_SIGNALS_ENABLED)", () => {
  const connected = (connectorsCollect: boolean, connectorSignals: boolean, connectorsChat = true) =>
    docToMarkdown(HELP_BODIES["connected-data"]!({ connectorsChat, connectorsCollect, connectorSignals }), "https://app.example.com");
  const review = (connectorsCollect: boolean, connectorSignals: boolean) =>
    docToMarkdown(HELP_BODIES["review-and-approvals"]!({ connectorsCollect, connectorSignals }), "https://app.example.com");

  it("says on Connected data what the numbers suggest, from which connections, and what ends them, only while collect and signals are on", () => {
    const text = connected(true, true);
    expect(text).toContain("## What your numbers suggest");
    for (const line of [SIGNALS_HELP.what, ...SIGNALS_HELP.rules, SIGNALS_HELP.planning, SIGNALS_HELP.strict, SIGNALS_HELP.review, SIGNALS_HELP.map, SIGNALS_HELP.nextUp, SIGNALS_HELP.vizzy, SIGNALS_HELP.erase]) {
      expect(text, line).toContain(line);
    }
    expect(connected(true, true, false)).not.toContain(SIGNALS_HELP.vizzy);
    expect(connected(true, false)).not.toContain("What your numbers suggest");
    expect(connected(false, true)).not.toContain("What your numbers suggest");
  });

  it("lists What your numbers suggest in Review, with Plan an article and Dismiss, only while both are on", () => {
    const text = review(true, true);
    expect(text).toContain("**What your numbers suggest**: searches and pages from Search Console worth an article");
    expect(text).toContain("## Plan or dismiss what your numbers suggest");
    expect(text).toContain("It won't come back for 30 days.");
    expect(review(true, false)).not.toContain("What your numbers suggest");
    expect(review(false, true)).not.toContain("What your numbers suggest");
  });

  it("explains questions from Google searches on the brand map, Edit included, and the Search Console chip in Next up", () => {
    const text = helpPageMarkdown("brand-map", "https://app.example.com")!;
    expect(text).toContain("## Questions from Google searches");
    expect(text).toContain("Press **Edit** to put the search into your own words");
    expect(text).toContain('a **Search Console** chip gives the numbers for the search with the question\'s own words, such as "880 impressions, position 11.3"');
    expect(helpPageMarkdown("write-and-schedule", "https://app.example.com")).toContain("Writing next from your numbers: fewer Google clicks to /pricing.");
  });

  it("keeps the section other pages link to with the brand map's scale switch off, sending rising searches to Review", () => {
    const was = process.env.BRAND_MAP_SCALE_ENABLED;
    process.env.BRAND_MAP_SCALE_ENABLED = "false";
    try {
      const text = helpPageMarkdown("brand-map", "https://app.example.com")!;
      expect(text).toContain("## Questions from Google searches");
      expect(text).toContain("it waits in Review under **What your numbers suggest**");
      expect(text).not.toContain("Press **Edit**");
    } finally {
      process.env.BRAND_MAP_SCALE_ENABLED = was;
    }
  });

  it("uses no dashes as punctuation and none of the AI tells", () => {
    for (const line of [SIGNALS_HELP.what, ...SIGNALS_HELP.rules, SIGNALS_HELP.planning, SIGNALS_HELP.strict, SIGNALS_HELP.review, SIGNALS_HELP.map, SIGNALS_HELP.nextUp, SIGNALS_HELP.vizzy, SIGNALS_HELP.erase]) {
      expect(dashesIn(line), line).toEqual([]);
      expect(aiTellsIn(line), line).toEqual([]);
    }
  });
});

