import type { GrowthSignals } from "@/lib/nav/growth";
import type { TenantRole } from "@/lib/types/tenantUser";
import { ASK_ACTION_IDS, PAGE_ACTION_IDS, type ActionId, type AskActionId, type PageActionId } from "@/lib/types/nextAction";

/**
 * The server allowlist for Your next action's buttons (ADR-0022). A button carries only an id from
 * here: "open this admin page" (a path from a fixed list, built from the routes and sections that
 * exist) or "ask Vizzy this" (one of our own prompts). Never a free URL or a free path: the model
 * picks an id, and this file alone turns it into a path or a prompt.
 *
 * Which ids a brand may use depends on what it has switched on (each page's own switch, as the page
 * checks it: lifecycle, invites, Email style, the brand map, logos, brand voice, Review) and what
 * exists (a page about the newest launch needs a launch), and only admins get the card at all. Pure,
 * and client safe.
 */

/** What the allowlist reads about the brand and the person. */
export interface ActionEnv {
  role: TenantRole | undefined;
  signals: Pick<GrowthSignals, "firstLaunchId" | "firstWorkspaceId" | "firstProductId" | "lifecycle" | "activeLaunches">;
  /**
   * Areas this copy has on, each as its page checks it (a page that is off answers 404): Email
   * style, the brand map, invites, About your business, logos, brand voice, and Review (nav v2's
   * Review, or lifecycle's approval queue).
   */
  areas: { emailStyle: boolean; brandMap: boolean; invites: boolean; about: boolean; logos: boolean; voice: boolean; review: boolean };
}

interface PageAction {
  /** What it does, for the model. */
  what: string;
  /** Its button's words when the model gives none that fit. */
  label: string;
  /** The admin page, or null when this brand can't use it now. */
  path: (env: ActionEnv) => string | null;
}

interface AskAction {
  what: string;
  label: string;
  /** What the chat asks Vizzy, in the founder's voice. */
  prompt: string;
  /** Whether this brand can use it now (default: always). */
  when?: (env: ActionEnv) => boolean;
}

const launchPage = (tab: string) => (env: ActionEnv) => (env.signals.firstLaunchId ? `/admin/launches/${encodeURIComponent(env.signals.firstLaunchId)}/${tab}` : null);
const programmePage = (tab: string) => (env: ActionEnv) => (env.signals.firstWorkspaceId ? `/admin/workspace/${encodeURIComponent(env.signals.firstWorkspaceId)}/${tab}` : null);
const always = (path: string) => () => path;
const withLifecycle = (path: string) => (env: ActionEnv) => (env.signals.lifecycle ? path : null);

export const PAGE_ACTIONS: Record<PageActionId, PageAction> = {
  "page.create_launch": { what: "create a launch: an idea with its own waitlist page", label: "Create it", path: always("/admin/launches/new") },
  "page.welcome_email": { what: "turn on the welcome email of the newest launch", label: "Open the welcome email", path: launchPage("journey") },
  "page.share_waitlist": { what: "get the newest launch's waitlist page and sign-up form to share", label: "Share it", path: launchPage("widget") },
  "page.invite_waitlist": {
    what: "invite people on the newest launch's waitlist into the product",
    label: "Invite them",
    path: (env) => (env.areas.invites && env.signals.lifecycle ? launchPage("invites")(env) : null),
  },
  "page.sending": { what: "verify the sending domain and add the sender details", label: "Set up sending", path: always("/admin/account") },
  "page.logo": { what: "add the brand's logo", label: "Add your logo", path: (env) => (env.areas.logos ? "/admin/brand-kit/logos" : null) },
  "page.voice": { what: "set the brand voice", label: "Set your voice", path: (env) => (env.areas.voice ? "/admin/brand-kit/voice" : null) },
  "page.email_style": { what: "style the brand's emails", label: "Style your emails", path: (env) => (env.areas.emailStyle ? "/admin/brand-kit/email-style" : null) },
  "page.brand_map": { what: "save the brand map that blog articles are written from", label: "Open the brand map", path: (env) => (env.areas.brandMap ? "/admin/brand-kit/map" : null) },
  "page.start_programme": { what: "start a content programme for posts, newsletters and articles", label: "Start it", path: always("/admin/workspace") },
  "page.knowledge": { what: "add the brand's website to its content programme's knowledge", label: "Add your website", path: programmePage("curate/grounding") },
  "page.schedule_post": { what: "schedule a post from the content programme's calendar", label: "Open the calendar", path: programmePage("distribute") },
  "page.newsletter": { what: "send a newsletter to the waitlist from the content programme", label: "Open the newsletter", path: programmePage("weekly") },
  "page.connect_accounts": { what: "connect LinkedIn, X or GitHub", label: "Connect accounts", path: always("/admin/account/connections") },
  "page.connect_product": { what: "connect the brand's app or software", label: "Connect your product", path: withLifecycle("/admin/products") },
  "page.learn_product": {
    what: "learn the connected product from its repo",
    label: "Learn your product",
    path: (env) => (env.signals.lifecycle && env.signals.firstProductId ? `/admin/products/${encodeURIComponent(env.signals.firstProductId)}?tab=learn` : null),
  },
  "page.journeys": { what: "build an onboarding journey for the product's users", label: "Open Journeys", path: withLifecycle("/admin/lifecycle") },
  "page.people": { what: "see the people who signed up", label: "See who joined", path: always("/admin/crm") },
  "page.review": { what: "decide what waits in Review", label: "Open Review", path: (env) => (env.areas.review ? "/admin/approvals" : null) },
  "page.about": { what: "check the answers and facts in About your business", label: "Open About your business", path: (env) => (env.areas.about ? "/admin/account/settings#about" : null) },
};

const hasLaunch = (env: ActionEnv) => env.signals.activeLaunches > 0;

export const ASK_ACTIONS: Record<AskActionId, AskAction> = {
  "ask.plan_idea": { what: "Vizzy helps plan and test the idea", label: "Plan it with Vizzy", prompt: "Help me plan and test my idea" },
  "ask.waitlist_page": { what: "Vizzy drafts a waitlist page", label: "Draft it with Vizzy", prompt: "Draft a waitlist page for my idea" },
  "ask.welcome_email": { what: "Vizzy drafts the waitlist's welcome email", label: "Draft it with Vizzy", prompt: "Draft the welcome email for my waitlist", when: hasLaunch },
  "ask.share_post": { what: "Vizzy drafts a post that shares the waitlist page", label: "Draft a post", prompt: "Draft a post that shares my waitlist page", when: hasLaunch },
  "ask.plan_posts": { what: "Vizzy plans next week's posts", label: "Plan it with Vizzy", prompt: "Plan next week's posts" },
  "ask.newsletter": { what: "Vizzy drafts the first newsletter", label: "Draft it with Vizzy", prompt: "Draft my first newsletter" },
  "ask.brand_voice": {
    what: "Vizzy writes the brand voice from the website",
    label: "Write it with Vizzy",
    prompt: "Write my brand voice from my website",
    when: (env) => env.areas.voice,
  },
  "ask.in_person_signups": {
    what: "Vizzy plans a sign-up card or QR code for where the brand meets people in person",
    label: "Plan it with Vizzy",
    prompt: "Plan a sign-up card or QR code for the places I meet customers in person",
  },
  "ask.own_form": { what: "Vizzy helps send sign-ups from the brand's own form to YouGrow", label: "Set it up with Vizzy", prompt: "Help me send sign-ups from my own form to YouGrow" },
  "ask.nudge_emails": { what: "Vizzy drafts emails that nudge new sign-ups to their next step", label: "Draft the emails", prompt: "Draft emails that nudge new sign-ups to take the next step" },
  "ask.first_steps": { what: "Vizzy says what to set up first", label: "Ask Vizzy", prompt: "What should I set up first?" },
};

export function isPageAction(id: ActionId): id is PageActionId {
  return (PAGE_ACTION_IDS as readonly string[]).includes(id);
}

export function isAskAction(id: ActionId): id is AskActionId {
  return (ASK_ACTION_IDS as readonly string[]).includes(id);
}

/** What a button does, resolved on the server: a page path, or one of our prompts. */
export type ResolvedAction = { id: ActionId; kind: "page"; href: string } | { id: ActionId; kind: "ask"; prompt: string };

/** Only an admin path from the list: "/admin" or "/admin/...", no scheme, host, dots or spaces. */
const ADMIN_PATH = /^\/admin(?:\/[A-Za-z0-9_%-]+)*(?:\?tab=[a-z]+)?(?:#[a-z-]+)?$/;

/**
 * What an id does for this brand and person now, or null when it is not on their list. Every path
 * is checked again here, so nothing but an admin path from the list can come out.
 */
export function resolveAction(id: unknown, env: ActionEnv): ResolvedAction | null {
  if (env.role !== "admin" || typeof id !== "string") return null;
  if (Object.prototype.hasOwnProperty.call(PAGE_ACTIONS, id)) {
    const href = PAGE_ACTIONS[id as PageActionId].path(env);
    return href && ADMIN_PATH.test(href) ? { id: id as PageActionId, kind: "page", href } : null;
  }
  if (Object.prototype.hasOwnProperty.call(ASK_ACTIONS, id)) {
    const a = ASK_ACTIONS[id as AskActionId];
    return a.when && !a.when(env) ? null : { id: id as AskActionId, kind: "ask", prompt: a.prompt };
  }
  return null;
}

/** The ids this brand and person may use now, in the list's order. None for anyone but an admin. */
export function allowedActions(env: ActionEnv): ActionId[] {
  return [...PAGE_ACTION_IDS, ...ASK_ACTION_IDS].filter((id) => resolveAction(id, env) !== null);
}

/** What an id does, and its default button, for the model's list and the screens. */
export function actionSpec(id: ActionId): { what: string; label: string } {
  return isPageAction(id) ? PAGE_ACTIONS[id] : ASK_ACTIONS[id as AskActionId];
}
