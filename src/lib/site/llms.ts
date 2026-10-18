import { llmsTxt } from "@/lib/developers/agentDocs";
import { isDevelopersDocsEnabled } from "@/lib/developers/flags";
import { FEATURES, FEATURE_ORDER, STAGES, STAGE_IDS, type FeatureSlug, type StageId } from "./content";
import { isSiteLanguagesEnabled, isSiteLoopEnabled } from "./flags";
import { GITHUB_URL, LINKEDIN_URL } from "./home";
import { sitePath } from "./langs";

/**
 * The site's llms.txt (https://llmstxt.org): what YouGrow is and where each page is,
 * for AI assistants and agents, merged with the developer index coding agents start
 * from (its sections are kept as they are). One line per page, written to be quoted.
 */

const STAGE_LINE: Record<StageId, string> = {
  understand: "The knowledge agent reads your docs, website and code, and the brand kit takes your palette, type and voice from your guidelines.",
  plan: "Tell Vizzy your goal in plain words; specialist agents return a draft plan, journey or invite wave.",
  create: "One idea becomes a hub and its spokes, written in your voice and grounded in your knowledge.",
  launch: "Approved posts go to your LinkedIn page; waitlists turn signups into recruiters; invite waves let the top of the list in first.",
  engage: "Each signup gets an email journey that branches on what they did, and can talk to a voice agent after joining.",
  learn: "Insights shows where signups come from, how emails perform and how the waitlist turns into active users.",
};

const FEATURE_LINE: Record<FeatureSlug, string> = {
  knowledge: "Grounds every draft in your docs, website and code repositories (read-only), stored in your own data region.",
  brand: "Extracts palette, fonts and voice from your brand guidelines and learns an image style from your ratings.",
  vizzy: "The chat that takes a request on any page and returns a draft for you to approve.",
  canvas: "Maps one idea into a campaign of channel-native pieces, then writes and schedules them.",
  ebook: "Outlines, writes and illustrates an eBook chapter by chapter, then turns it into a campaign.",
  waitlists: "A waitlist with email verification, referral links and a public leaderboard.",
  invites: "Invites the top of a verified waitlist with signed links and traces signups and activation back to each wave.",
  distribute: "Schedules approved posts, previews them per network, scores them before publishing and posts to LinkedIn pages.",
  journeys: "Welcome journeys that branch on behaviour, with A/B tests and one-click promotion of the winner.",
  voice: "A voice conversation right after signup, in 23 languages, saved with the signup.",
  insights: "Signups, sources, email results and the waitlist-to-product funnel in one place.",
};

/** The developer index, split into its intro (after the title) and its "## " sections. */
function developerParts(): { intro: string[]; sections: string[]; optional: string[] } {
  const txt = llmsTxt().trimEnd();
  const at = txt.indexOf("\n## ");
  const head = txt.slice(0, at).split("\n").filter((l) => !l.startsWith("# "));
  const intro = head.map((l) => (l.startsWith("> ") ? `For developers: ${l.slice(2)}` : l)).join("\n").trim().split("\n");
  const blocks = txt.slice(at + 1).split(/\n(?=## )/);
  return {
    intro,
    sections: blocks.filter((b) => !b.startsWith("## Optional")),
    optional: blocks.filter((b) => b.startsWith("## Optional")),
  };
}

export function siteLlmsTxt(origin: string): string {
  const loop = isSiteLoopEnabled();
  const dev = isDevelopersDocsEnabled() ? developerParts() : null;
  const lines: string[] = [
    "# YouGrow",
    "",
    "> YouGrow is an agentic marketing platform. AI agents plan, create, launch and learn around one shared growth memory, and a person approves what is published or sent.",
    "",
    "YouGrow runs go-to-market as a loop of six stages, not a funnel. What each lap produces (signups, referrals, opens, clicks, product events) goes back into the growth memory, so the next lap starts with more to work from. The first three stages (Understand, Plan, Create) are called Make; the last three (Launch, Engage, Learn) are called Grow.",
    "",
  ];
  if (isSiteLanguagesEnabled()) {
    lines.push("Pages are available in English (default), Spanish (/es), French (/fr), German (/de), Japanese (/ja) and Arabic (/ar).", "");
  }
  if (dev) lines.push(...dev.intro, "");
  if (loop) {
    lines.push("## The loop", "");
    for (const id of STAGE_IDS) lines.push(`- [${STAGES[id].name}](${origin}${sitePath("en", { kind: "stage", id })}): ${STAGE_LINE[id]}`);
    lines.push("", "## Features", "");
    for (const f of FEATURE_ORDER) lines.push(`- [${FEATURES[f].name}](${origin}${sitePath("en", { kind: "feature", slug: f })}): ${FEATURE_LINE[f]}`);
    lines.push("");
  } else {
    lines.push("## Site", "", `- [Home](${origin}/): What YouGrow does and how to join the waitlist.`, "");
  }
  if (dev) for (const s of dev.sections) lines.push(s.trimEnd(), "");
  lines.push(
    "## Elsewhere",
    "",
    `- [GitHub](${GITHUB_URL}): The YouGrow source code.`,
    `- [LinkedIn](${LINKEDIN_URL}): Company page and updates.`,
    "",
    "## Use of this content",
    "",
    `Search engines, AI assistants, AI agents and AI training crawlers may read, quote, cite and learn from every public page. See [robots.txt](${origin}/robots.txt) and [sitemap.xml](${origin}/sitemap.xml).`,
    "",
  );
  if (dev) for (const s of dev.optional) lines.push(s.trimEnd(), "");
  return `${lines.join("\n").trimEnd()}\n`;
}
