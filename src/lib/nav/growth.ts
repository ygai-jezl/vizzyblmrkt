/**
 * The growth path (nav v2 phase 2): how far a brand has got through the four
 * stages a customer walks — launch a waitlist, grow an audience with content,
 * connect the product, then onboard and retain its users. Pure: the signals
 * come from growthSignals.ts, so this is unit-tested on its own.
 *
 * A stage is "done" when its outcome exists (not when a page was visited), so a
 * customer who connects a product before starting content sees Products done and
 * Content still current. Stages 3–4 exist only where lifecycle journeys do.
 *
 * The setup guide (NEXT_PUBLIC_SETUP_GUIDE_ENABLED, when `signals.setup` is
 * present) makes this the one ordered setup list: a "Get ready" stage first
 * (sending, brand, email style), the steps the other stages were missing, what
 * each step needs first, the help page that explains it, and a warning where the
 * order matters. Without `setup` the path is exactly as before.
 */

import { programmeWord } from "./terms";

export type StageKey = "ready" | "launch" | "grow" | "product" | "retain";
export type StageStatus = "done" | "current" | "next";

/** Facts about the brand, read by loadGrowthSignals. Counts are never negative. */
export interface GrowthSignals {
  /** Launches not archived. */
  activeLaunches: number;
  /** The newest active launch, for deep links. */
  firstLaunchId: string | null;
  /** Any launch's welcome (nurture) journey is active. */
  welcomeEmailLive: boolean;
  /** Verified + unverified signups across launches; null when unknown. */
  signups: number | null;
  /** Content workspaces not archived. */
  workspaces: number;
  firstWorkspaceId: string | null;
  /** Posts ever scheduled for publishing (any status). */
  postsScheduled: number;
  /** Weekly newsletters sent to a launch's audience. */
  newslettersSent: number;
  /** Lifecycle journeys exist in this environment (stages 3–4). */
  lifecycle: boolean;
  /** Connected products (custom, not revoked; sandboxes don't count). */
  products: number;
  firstProductId: string | null;
  /** A connected product has onboarding steps in its catalog. */
  catalogReady: boolean;
  /** A connected product has sent at least one event. */
  eventsReceived: boolean;
  /** Lifecycle journeys not archived. */
  journeys: number;
  firstJourneyId: string | null;
  /** A lifecycle journey has a published version (any delivery mode). */
  journeyPublished: boolean;
  /** A lifecycle journey is active in live mode. */
  journeyLive: boolean;
  /** Waitlist members invited into the product (nav v2 phase 4); absent while invites are off. */
  invited?: number | null;
  /** The setup guide's extra facts; absent while the setup guide is off. */
  setup?: SetupSignals;
}

/** What the setup guide adds to the growth path's facts. */
export interface SetupSignals {
  /** A sending domain is verified. */
  domainVerified: boolean;
  /** The From address is on a verified domain, and the privacy policy link and postal address are set. */
  senderDetails: boolean;
  /** A logo is uploaded. */
  logo: boolean;
  /** A brand voice is written or generated. */
  voice: boolean;
  /** An Email style is saved; null while Email style is off. */
  emailStyle: boolean | null;
  /** A programme has a knowledge source that finished reading. */
  knowledge: boolean;
  /** The brand map is saved; null while the brand map is off. */
  brandMapSaved: boolean | null;
  /** LinkedIn or X is connected for posting. */
  social: boolean;
  /** GitHub or GitLab is connected, for private repos. */
  git: boolean;
}

export interface NextStep {
  label: string;
  /** Short progress note, e.g. "4 of 10". */
  detail?: string;
  done: boolean;
  href: string;
  /** The help page section that explains this step, e.g. "/help/email-sending#domain". */
  howTo?: string;
  /** Steps that have to be done first and aren't yet. A step that needs something is shown locked. */
  needs?: Array<{ label: string; href: string }>;
  /** Never holds its stage back, and is suggested only once the required steps are done. */
  optional?: boolean;
  /** One line on why the order matters here, shown until the step is done. */
  warning?: string;
}

export interface StageView {
  key: StageKey;
  label: string;
  status: StageStatus;
  /** One line for the track, e.g. "412 signups" or "When your app is ready". */
  summary: string;
  steps: NextStep[];
}

export interface Growth {
  stages: StageView[];
  /** The first stage not done; null once every stage is running. */
  current: StageKey | null;
  /** Nothing set up yet: Home shows the first-run version. */
  firstRun: boolean;
  allRunning: boolean;
}

/** "Get your first N signups" — the launch stage's traction step. */
export const SIGNUP_GOAL = 10;

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;

/** The first-needed steps that aren't done yet, or undefined when nothing blocks the step. */
function needing(...prereqs: Array<NextStep | false | undefined>): NextStep["needs"] {
  const open = prereqs.filter((p): p is NextStep => !!p && !p.done).map((p) => ({ label: p.label, href: p.href }));
  return open.length ? open : undefined;
}

/** Settings › Sending, Brand and Settings › Integrations, as the setup guide links them. */
export const SETUP_HREF = {
  sending: "/admin/account",
  integrations: "/admin/account/connections",
  logos: "/admin/brand-kit/logos",
  voice: "/admin/brand-kit/voice",
  emailStyle: "/admin/brand-kit/email-style",
  brandMap: "/admin/brand-kit/map",
} as const;

function readyStage(s: GrowthSignals, setup: SetupSignals): Omit<StageView, "status"> {
  const domain: NextStep = {
    label: "Verify your sending domain",
    detail: setup.domainVerified ? undefined : "Until then, your emails come from a shared default address.",
    done: setup.domainVerified,
    href: SETUP_HREF.sending,
    howTo: "/help/email-sending#domain",
  };
  const sender: NextStep = {
    label: "Add your sender details",
    detail: "From address, privacy policy link and postal address",
    done: setup.senderDetails,
    href: SETUP_HREF.sending,
    howTo: "/help/email-sending#sender",
    needs: needing(domain),
  };
  const logo: NextStep = { label: "Add your logo", done: setup.logo, href: SETUP_HREF.logos, howTo: "/help/your-brand#logo" };
  const voice: NextStep = { label: "Set your brand voice", done: setup.voice, href: SETUP_HREF.voice, howTo: "/help/your-brand#voice" };
  const style: NextStep[] =
    setup.emailStyle === null
      ? []
      : [{ label: "Style your emails", done: setup.emailStyle, href: SETUP_HREF.emailStyle, howTo: "/help/email-style" }];
  const steps = [domain, sender, logo, voice, ...style];
  const done = steps.filter((st) => st.done).length;
  return {
    key: "ready",
    label: "Get ready",
    summary: done === steps.length ? "Ready" : `${done} of ${steps.length} done`,
    steps,
  };
}

function launchStage(s: GrowthSignals): Omit<StageView, "status"> {
  const launchHref = (tab: string) => (s.firstLaunchId ? `/admin/launches/${s.firstLaunchId}/${tab}` : "/admin/launches");
  const signups = s.signups ?? 0;
  return {
    key: "launch",
    label: "Launch",
    summary: s.activeLaunches === 0 ? "Start with a waitlist" : s.signups === null ? "Live" : plural(signups, "signup"),
    steps: s.setup ? withSetup() : plain(),
  };

  function plain(): NextStep[] {
    return [
      { label: "Create a launch", done: s.activeLaunches > 0, href: "/admin/launches/new" },
      { label: "Turn on the welcome email", done: s.welcomeEmailLive, href: launchHref("journey") },
      {
        label: `Get your first ${SIGNUP_GOAL} signups`,
        detail: `${Math.min(signups, SIGNUP_GOAL)} of ${SIGNUP_GOAL}`,
        done: signups >= SIGNUP_GOAL,
        href: launchHref("widget"),
      },
    ];
  }

  function withSetup(): NextStep[] {
    const [create, welcome, traction] = plain() as [NextStep, NextStep, NextStep];
    return [
      { ...create, howTo: "/help/launch-and-waitlist#create" },
      {
        ...welcome,
        howTo: "/help/launch-and-waitlist#welcome",
        needs: needing(create),
        warning: "Turn it on before you share your page: the first time, it goes to everyone already signed up.",
      },
      { ...traction, howTo: "/help/launch-and-waitlist#share", needs: needing(create) },
    ];
  }
}

function growStage(s: GrowthSignals): Omit<StageView, "status"> {
  const wsHref = (tab: string) => (s.firstWorkspaceId ? `/admin/workspace/${s.firstWorkspaceId}/${tab}` : "/admin/workspace");
  return {
    key: "grow",
    label: "Grow audience",
    summary:
      s.workspaces === 0
        ? "Grow the list with content"
        : s.postsScheduled > 0
          ? `${plural(s.postsScheduled, "post")} scheduled`
          : "No posts scheduled yet",
    steps: s.setup ? withSetup(s.setup) : plain(),
  };

  function plain(): NextStep[] {
    return [
      { label: `Start a content ${programmeWord().one}`, done: s.workspaces > 0, href: "/admin/workspace" },
      { label: "Schedule your first post", done: s.postsScheduled > 0, href: wsHref("distribute") },
      { label: "Send a newsletter to your waitlist", done: s.newslettersSent > 0, href: wsHref("weekly") },
    ];
  }

  function withSetup(setup: SetupSignals): NextStep[] {
    const [programme, post, newsletter] = plain() as [NextStep, NextStep, NextStep];
    const start = { ...programme, howTo: "/help/programmes-and-knowledge#start" };
    const knowledge: NextStep = {
      label: "Add your website to its knowledge",
      done: setup.knowledge,
      href: wsHref("curate/grounding"),
      howTo: "/help/programmes-and-knowledge#knowledge",
      needs: needing(start),
    };
    const map: NextStep[] =
      setup.brandMapSaved === null
        ? []
        : [
            {
              label: "Save your brand map",
              done: setup.brandMapSaved,
              href: SETUP_HREF.brandMap,
              howTo: "/help/brand-map",
              optional: true,
              warning: "Blog articles use your brand map only once it's saved.",
            },
          ];
    const social: NextStep = {
      label: "Connect LinkedIn or X",
      done: setup.social,
      href: SETUP_HREF.integrations,
      howTo: "/help/connected-accounts#social",
      optional: true,
    };
    const launch = { label: "Create a launch", done: s.activeLaunches > 0, href: "/admin/launches/new" };
    return [
      start,
      knowledge,
      ...map,
      social,
      {
        ...post,
        howTo: "/help/write-and-schedule#schedule",
        needs: needing(start, social),
        warning: "Connect the account first: a post scheduled without one fails when it's due.",
      },
      { ...newsletter, howTo: "/help/write-and-schedule#newsletter", needs: needing(start, launch) },
    ];
  }
}

function productStage(s: GrowthSignals): Omit<StageView, "status"> {
  const productHref = (suffix = "") => (s.firstProductId ? `/admin/products/${s.firstProductId}${suffix}` : "/admin/products");
  const setUp = [s.products > 0, s.catalogReady, s.eventsReceived].filter(Boolean).length;
  return {
    key: "product",
    label: "Launch product",
    summary: s.products === 0 ? "When your app is ready" : s.eventsReceived && s.catalogReady ? "Receiving events" : `${setUp} of 3 set up`,
    steps: s.setup ? withSetup(s.setup) : plain(),
  };

  function plain(): NextStep[] {
    return [
      { label: "Connect your product", done: s.products > 0, href: "/admin/products" },
      { label: "Learn it from your repo", done: s.catalogReady, href: productHref("?tab=learn") },
      { label: "Receive your first event", done: s.eventsReceived, href: productHref() },
      // Nav v2 phase 4: bring the waitlist in. A step only — the stage's done rule is unchanged.
      ...(s.invited != null
        ? [
            {
              label: "Invite your waitlist",
              done: s.invited > 0,
              href: s.firstLaunchId ? `/admin/launches/${s.firstLaunchId}/invites` : "/admin/launches",
            },
          ]
        : []),
    ];
  }

  function withSetup(setup: SetupSignals): NextStep[] {
    const [connect, learn, events, ...invite] = plain() as [NextStep, NextStep, NextStep, ...NextStep[]];
    const git: NextStep = {
      label: "Connect GitHub",
      detail: "Only for a private repo",
      done: setup.git,
      href: SETUP_HREF.integrations,
      howTo: "/help/connected-accounts#github",
      optional: true,
    };
    return [
      { ...connect, howTo: "/help/connect-your-product#connect" },
      git,
      { ...learn, howTo: "/help/connect-your-product#learn", needs: needing(connect) },
      {
        ...events,
        detail: events.done ? undefined : "Your developer sends it. Share the developer docs with them.",
        howTo: "/help/connect-your-product#developer",
        needs: needing(connect),
      },
      ...invite.map((st) => ({ ...st, howTo: "/help/invite-your-waitlist", needs: needing(connect) })),
    ];
  }
}

function retainStage(s: GrowthSignals): Omit<StageView, "status"> {
  const journeyHref = s.firstJourneyId ? `/admin/lifecycle/${s.firstJourneyId}` : "/admin/lifecycle";
  return {
    key: "retain",
    label: "Onboard & retain",
    summary:
      s.journeyLive
        ? "Live"
        : s.journeyPublished
          ? "In test mode"
          : s.journeys > 0
            ? "Draft journey"
            : s.products === 0
              ? "After your product is connected"
              : "Build an onboarding journey",
    steps: s.setup ? withSetup(s.setup) : plain(),
  };

  function plain(): NextStep[] {
    return [
      { label: "Build an onboarding journey", done: s.journeys > 0, href: "/admin/lifecycle" },
      { label: "Publish it in test mode", done: s.journeyPublished, href: journeyHref },
      { label: "Switch it to live", done: s.journeyLive, href: journeyHref },
    ];
  }

  function withSetup(setup: SetupSignals): NextStep[] {
    const [build, publish, live] = plain() as [NextStep, NextStep, NextStep];
    const product = { label: "Connect your product", done: s.products > 0, href: "/admin/products" };
    const learn = {
      label: "Learn it from your repo",
      done: s.catalogReady,
      href: s.firstProductId ? `/admin/products/${s.firstProductId}?tab=learn` : "/admin/products",
    };
    const domain = { label: "Verify your sending domain", done: setup.domainVerified, href: SETUP_HREF.sending };
    const sender = { label: "Add your sender details", done: setup.senderDetails, href: SETUP_HREF.sending };
    return [
      {
        ...build,
        howTo: "/help/onboarding-journeys#build",
        needs: needing(product),
        warning: "Publish it before your developer starts sending sign-ups: a journey only takes people who signed up in the last 3 days.",
      },
      { ...publish, howTo: "/help/onboarding-journeys#test", needs: needing(build, learn) },
      { ...live, howTo: "/help/onboarding-journeys#live", needs: needing(publish, domain, sender) },
    ];
  }
}

const DONE: Record<StageKey, (s: GrowthSignals) => boolean> = {
  ready: (s) =>
    !!s.setup &&
    s.setup.domainVerified &&
    s.setup.senderDetails &&
    s.setup.logo &&
    s.setup.voice &&
    s.setup.emailStyle !== false,
  launch: (s) => s.activeLaunches > 0 && s.welcomeEmailLive,
  grow: (s) => s.workspaces > 0 && (s.setup?.knowledge ?? true) && (s.postsScheduled > 0 || s.newslettersSent > 0),
  product: (s) => s.products > 0 && s.catalogReady && s.eventsReceived,
  retain: (s) => s.journeyLive,
};

export function computeGrowth(s: GrowthSignals): Growth {
  const views = [
    ...(s.setup ? [readyStage(s, s.setup)] : []),
    launchStage(s),
    growStage(s),
    ...(s.lifecycle ? [productStage(s), retainStage(s)] : []),
  ];
  const current = views.find((v) => !DONE[v.key](s))?.key ?? null;
  const stages: StageView[] = views.map((v) => ({
    ...v,
    status: DONE[v.key](s) ? "done" : v.key === current ? "current" : "next",
  }));
  const firstRun = s.activeLaunches === 0 && s.workspaces === 0 && s.products === 0 && s.journeys === 0;
  return { stages, current, firstRun, allRunning: current === null };
}

/**
 * The first step still to do in a stage (the Home call to action): one that can be
 * done now and isn't optional, then any that can be done now, then the first left.
 */
export function nextStepOf(stage: StageView): NextStep | null {
  const open = stage.steps.filter((step) => !step.done);
  return open.find((st) => !st.needs && !st.optional) ?? open.find((st) => !st.needs) ?? open[0] ?? null;
}

/** Sidebar Grow items by stage, for the progress dots. Get ready has no Grow item. */
export const STAGE_NAV_KEY: Record<StageKey, "launches" | "content" | "products" | "journeys" | null> = {
  ready: null,
  launch: "launches",
  grow: "content",
  product: "products",
  retain: "journeys",
};
