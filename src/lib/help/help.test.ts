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
import { helpLlmsTxt, helpPageMarkdown } from "./agentFiles";
import { HELP_PAGES } from "./pages";
import { HELP_PLACES, helpFor, parseHelpPath } from "./places";


/**
 * Keeps the help pages true to the app: every link and section exists, every
 * route a page sends you to is real, every message a page quotes is still one
 * the app shows, and the copy keeps to house style (no dashes as punctuation).
 */

// The pages are read with every switched section shown (Brand › What we've seen points at one), so
// their links and copy are checked too.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_BRAND_NOTES_ENABLED = "true";
  process.env.NEXT_PUBLIC_BRAND_NOTES_QUESTIONS_ENABLED = "true";
  process.env.NEXT_PUBLIC_BRAND_NOTES_REST_ENABLED = "true";
  process.env.NEXT_PUBLIC_BRAND_MAP_SITUATION_ASK_ENABLED = "true";
  process.env.NEXT_PUBLIC_BLOG_AI_SUMMARY_LINKS_ENABLED = "true";
  process.env.LAUNCH_SITE_SIGNUPS_ENABLED = "true";
  process.env.AUDIENCE_PERSON_LINKS_ENABLED = "true";
  process.env.AUDIENCE_ONE_VIEW_ENABLED = "true";
  process.env.NEXT_PUBLIC_EDIT_MODE_ENABLED = "true";
  process.env.NEXT_PUBLIC_EDIT_MODE_EMAILS_ENABLED = "true";
  process.env.NEXT_PUBLIC_NEWSLETTER_MARKDOWN_EMAIL_ENABLED = "true";
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
});
