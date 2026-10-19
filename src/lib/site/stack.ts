import type { StageId } from "./content";

/**
 * "The stack" on the homepage: what the loop learns from, the agents at each stage, where
 * the work goes out and what keeps a person in charge. English (./i18n translates it).
 * Everything here must be true of production today; anything not yet live is `soon`.
 */

/** Line icons (lucide-react) and brand logos (src/components/site/BrandIcons.tsx). */
export type StackIcon =
  | "file-text" | "globe" | "palette" | "braces" | "plug-zap" | "webhook" | "users" | "megaphone"
  | "book-open" | "activity" | "circle-check" | "map-pin" | "lock" | "key-round" | "shield-check"
  | "mail-x" | "mail" | "message-square-text" | "pen-line" | "rocket" | "message-circle" | "chart-line"
  | "linkedin" | "github" | "gitlab" | "mailchimp" | "gemini" | "x" | "instagram" | "node";

export interface StackChip {
  label: string;
  icon: StackIcon;
  /** Not live yet: shows a "soon" tag. */
  soon?: boolean;
  /** Show the logo alone; the label is for screen readers and the tooltip. */
  logoOnly?: boolean;
}

export interface StackStage {
  id: StageId;
  icon: StackIcon;
  /** Tile colour, a touch deeper than the stage colour so the icon reads on light pages. */
  color: string;
  sub: string;
}

export const STACK = {
  learnsFrom: [
    { label: "Docs and pages", icon: "file-text" },
    { label: "Websites", icon: "globe" },
    { label: "GitHub", icon: "github" },
    { label: "GitLab", icon: "gitlab" },
    { label: "Brand guidelines", icon: "palette" },
  ] as StackChip[],
  connectsThrough: [
    { label: "API", icon: "braces" },
    { label: "Node SDK", icon: "node" },
    { label: "Context endpoint", icon: "plug-zap" },
    { label: "Signed webhooks", icon: "webhook" },
  ] as StackChip[],
  team: { title: "You and your team", sub: "Ask Vizzy", icon: "users" as StackIcon },
  make: [
    { id: "understand", icon: "book-open", color: "#a78bfa", sub: "Knowledge agent, brand kit" },
    { id: "plan", icon: "message-square-text", color: "#8b7cf6", sub: "Vizzy and three specialist agents" },
    { id: "create", icon: "pen-line", color: "#5b8def", sub: "Content canvas, eBook studio" },
  ] as StackStage[],
  gate: { title: "You approve", sub: "Review" },
  grow: [
    { id: "launch", icon: "rocket", color: "#06b6d4", sub: "Distribute, waitlists, invite waves" },
    { id: "engage", icon: "message-circle", color: "#14b8a6", sub: "Email journeys, voice chat" },
    { id: "learn", icon: "chart-line", color: "#10b981", sub: "Insights" },
  ] as StackStage[],
  audience: { title: "Your audience", sub: "Signups, subscribers and product users", icon: "megaphone" as StackIcon },
  memory: [
    { label: "Knowledge", icon: "book-open" },
    { label: "Brand kit", icon: "palette" },
    { label: "Signals", icon: "activity" },
  ] as StackChip[],
  inCharge: [
    { label: "Nothing ships without approval", icon: "circle-check" },
    { label: "Your own data region", icon: "map-pin" },
    { label: "Read-only code access", icon: "lock" },
    { label: "Signed links and webhooks", icon: "key-round" },
    { label: "Bots filtered at signup", icon: "shield-check" },
    { label: "Unsubscribe links in emails", icon: "mail-x" },
  ] as StackChip[],
  connectsTo: [
    { label: "LinkedIn pages", icon: "linkedin" },
    { label: "Email journeys and broadcasts", icon: "mail" },
    { label: "Mailchimp newsletter", icon: "mailchimp" },
    { label: "GitHub", icon: "github" },
    { label: "GitLab", icon: "gitlab" },
    { label: "Gemini", icon: "gemini" },
    { label: "X", icon: "x", soon: true, logoOnly: true },
    { label: "Instagram", icon: "instagram", soon: true },
  ] as StackChip[],
};

/** The section's own words (headings and labels), for the translation check. */
export const STACK_WORDS = [
  "The stack", "Everything the loop runs on", "Everything in one place.",
  "What it learns from, the agents at every stage, where the work goes out, and what keeps you in charge.",
  "Learns from", "Your product connects through", "Make", "Grow", "Growth memory", "You stay in charge", "Connects to", "soon",
];
