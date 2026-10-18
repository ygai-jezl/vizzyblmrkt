import type { StageId } from "./content";

/**
 * The homepage's words (English; ./i18n translates them). Each chapter of "The Loop"
 * explains one stop on the loop while the pinned loop beside it lights that stop.
 * `target` is where the loop's pulse parks: a position from 0 to 1, or "core".
 * Statuses must stay true to production: "Live" only when it is live for customers.
 */

export const HERO_LABEL =
  "The agentic growth loop: a figure-eight of light. Make runs Understand, Plan and Create; Grow runs Launch, Engage and Learn; both pass through a shared growth memory at the centre.";

export interface Fact {
  term: string;
  value: string;
}

export interface Status {
  text: "Live" | "Partly live";
  note?: string;
}

export type Chapter =
  | { kind: "core"; name: string; no: string; label: string; title: string; body: string; facts: Fact[]; color: string }
  | { kind: "stage"; id: StageId; label: string; body: string; agent: string; adds: string; status: Status }
  | { kind: "cross"; name: string; no: string; label: string; glyph: "diamond" | "disc"; target: number; title: string; body: string; now?: string[]; next?: string[] };

export const CHAPTERS: Chapter[] = [
  {
    kind: "core",
    name: "The core",
    no: "00",
    label: "00 · The core",
    title: "Growth memory",
    color: "#dbeafe",
    body: "Everything the loop knows lives in one place: your product, your brand and every signal your launches produce. Every agent reads from it before it acts, and writes back what it learns.",
    facts: [
      { term: "Knowledge", value: "Your docs, website and code, read-only" },
      { term: "Brand", value: "Voice, palette, fonts and a learned image style" },
      { term: "Signals", value: "Signups, referrals, opens, clicks and product events" },
    ],
  },
  {
    kind: "stage",
    id: "understand",
    label: "01 · Make",
    body: "Before it writes a word, the knowledge agent reads your docs, your website and your code, and takes your palette and voice from your brand guidelines. It maps your product into facts you approve, so everything downstream is grounded in what’s true.",
    agent: "Knowledge agent",
    adds: "Sourced knowledge, a product map and your brand kit",
    status: { text: "Live" },
  },
  {
    kind: "stage",
    id: "plan",
    label: "02 · Make",
    body: "Tell Vizzy what you want in plain words. Its three specialist agents draft a content programme, a launch email journey, a product onboarding journey or an invite wave, on a canvas you can edit. Nothing is published from chat.",
    agent: "Vizzy, with content, campaign and lifecycle agents",
    adds: "Draft plans, journeys and invite waves",
    status: { text: "Live" },
  },
  {
    kind: "stage",
    id: "create",
    label: "03 · Make",
    body: "One idea becomes a whole campaign. The canvas architect maps a hub and its spokes, then writes every post, email and even an eBook. Images follow a style learned from your own ratings, and email copy is briefed with how your last sends performed.",
    agent: "Canvas architect and email assist",
    adds: "Drafts, and your ratings of every image",
    status: { text: "Live" },
  },
  {
    kind: "cross",
    name: "You approve",
    no: "◆",
    label: "Crossing · Make to Grow",
    glyph: "diamond",
    target: 0.55,
    title: "Agents draft. You decide what ships.",
    body: "Nothing reaches a customer until a person says yes. Plans, posts, journeys and invite waves wait in Review for you.",
  },
  {
    kind: "stage",
    id: "launch",
    label: "04 · Grow",
    body: "Approved work goes out: posts to your LinkedIn page, broadcasts and journeys by email, invite waves to the top of your waitlist. The waitlist is a loop of its own, because referral leaderboards turn every signup into a recruiter.",
    agent: "Distribute, invites and the waitlist",
    adds: "Signups, referrals and where they came from",
    status: { text: "Live", note: "X and Instagram next" },
  },
  {
    kind: "stage",
    id: "engage",
    label: "05 · Grow",
    body: "Every person gets a journey that branches on what they did: whether they referred friends, how high they rank, where they came from. After signing up, they can tell a voice agent why they joined.",
    agent: "Journeys and the voice agent",
    adds: "Opens, clicks and voice-chat answers",
    status: { text: "Partly live", note: "Per-person product emails next" },
  },
  {
    kind: "stage",
    id: "learn",
    label: "06 · Grow",
    body: "Insights shows which sources bring signups, how each email performs and which invites turn into active users, and Vizzy answers from it when you ask. Today it reports. Next, it steers.",
    agent: "Insights, read by Vizzy",
    adds: "What’s working, and where it came from",
    status: { text: "Partly live", note: "Steering the next draft next" },
  },
  {
    kind: "cross",
    name: "Back to memory",
    no: "●",
    label: "Crossing · Grow to Make",
    glyph: "disc",
    target: 0.965,
    title: "Where it compounds.",
    body: "Every result flows back into the middle. The more laps you run, the more the next one knows.",
    now: [
      "Your image ratings shape every new image",
      "Every signup recruits the next",
      "Past email results brief the next email",
    ],
    next: [
      "Post results steer the next draft",
      "Agents read Insights before they plan",
      "A weekly review proposes your next lap",
    ],
  },
];

export interface FaqEntry {
  q: string;
  a: string;
  /** A link shown after the answer: an absolute URL or a site path, and its label (translated unless it is a URL). */
  link?: { href: string; label: string };
}

/**
 * Plain answers to what people ask AI assistants about YouGrow. They are on the page
 * as text and in the FAQPage markup, so they must stay true: no pricing, no claims
 * about what is not live.
 */
export const GITHUB_URL = "https://github.com/ygai-jezl/vizzyblmrkt";
export const LINKEDIN_URL = "https://www.linkedin.com/company/yougrowai/";

export const FAQ: FaqEntry[] = [
  {
    q: "What is YouGrow?",
    a: "YouGrow is an agentic marketing platform. Agents learn your product and brand, plan campaigns, write the content, run your waitlist and launch emails, and report what worked. What they learn goes into one shared growth memory, and a person approves what ships.",
  },
  {
    q: "Does anything go out without my approval?",
    a: "No. Plans, posts, journeys and invite waves wait in Review until a person approves them. Vizzy, the chat, writes drafts but never sends anything or switches it on.",
  },
  {
    q: "What does YouGrow learn from?",
    a: "Your docs, website and code repositories, read-only, and your brand guidelines. Once you launch, it adds the signals your launches produce: signups, referrals, opens, clicks and product events.",
  },
  {
    q: "Where does it publish today?",
    a: "Posts publish to your LinkedIn company page, and email goes out as broadcasts and journeys. X and Instagram come next.",
  },
  {
    q: "Is the code public?",
    a: "Yes. YouGrow’s source code is public on GitHub.",
    link: { href: GITHUB_URL, label: "github.com/ygai-jezl/vizzyblmrkt" },
  },
  {
    q: "How do I start?",
    a: "Join the waitlist on this page. Developers can read how to connect a product in the developer docs.",
    link: { href: "/developers", label: "Developer docs" },
  },
];
