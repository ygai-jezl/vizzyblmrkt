import type { ProductMap } from "./productMapSchema";

/**
 * The customer's side of the integration as a PRIORITISED TO-DO LIST — what to
 * build, where in their own code (from "Learn from repo"), and what happens if
 * they skip it. Browser-safe (the Learn from repo screen uses it); the prompt
 * for their coding agent is built server-side in agentPrompt.ts.
 *
 * API v2: their server sends each user's STATE (PATCH /api/v2/users/{userId}).
 * Only the sign-up write is required for a journey to run at all; everything
 * else makes it personal, or keeps it compliant. Saying that plainly is the
 * point. Texts may use `backticks` for code.
 */

export type TaskSeverity = "required" | "compliance" | "personalisation" | "recommended";
export type TaskId = "signup" | "entities" | "steps" | "context" | "deletion" | "preferences" | "timezone" | "exit" | "invite";

export interface IntegrationTask {
  id: TaskId;
  severity: TaskSeverity;
  title: string;
  /** What to build, in one or two sentences. */
  action: string;
  /** What happens to the journeys if it isn't done. */
  ifSkipped: string;
  /** What "Learn from repo" found about this in their code (may contain `code`). */
  fromCode: string[];
  /** Where in their code — verified evidence only. */
  files: Array<{ path: string; line: number | null }>;
  /** done when we can see it working; otherwise todo. */
  status: "done" | "todo";
}

export const SEVERITY_LABEL: Record<TaskSeverity, string> = {
  required: "Required",
  compliance: "Compliance",
  personalisation: "Personalisation",
  recommended: "Recommended",
};

const META: Record<TaskId, { severity: TaskSeverity; title: string; action: string; ifSkipped: string }> = {
  signup: {
    severity: "required",
    title: "Send sign-ups",
    action:
      "Where a new account is created, PATCH the user with `signedUpAt` (when the account was created), `email`, `firstName`, `timezone` and `consent`.",
    ifSkipped: "Nobody is ever enrolled — the journey sends no emails at all.",
  },
  entities: {
    severity: "personalisation",
    title: "Send what people have several of",
    action:
      "One person can have several workspaces, brands or projects: send them all as `entities` in the same PATCH — your id → `kind`, `name`, `role` (`owner`, `member` or `invited`), and their own `steps` and `facts`; `null` removes one. Send every one — each journey chooses which of them its emails are about.",
    ifSkipped: "Emails can't tell their workspaces or brands apart: someone with one finished and one half done is nudged as if they'd done nothing.",
  },
  steps: {
    severity: "personalisation",
    title: "Report onboarding steps and facts",
    action:
      "Include `steps` (step id → when it was done) and `facts` (fact id → latest value) in the PATCH when they change — at the server moment, or from a small scheduled sync of stored state.",
    ifSkipped: "Everyone takes the reminder branch, and people get nudged to do steps they've already done.",
  },
  context: {
    severity: "personalisation",
    title: "Build the context endpoint — for emails that show people their results",
    action:
      "Answer our signed request for one user — or, when the email is about one of their entities, that one — with insight sentences (true sentences about their own results: the only way an email says what their numbers mean), their live steps and facts, and hold or exit when needed.",
    ifSkipped:
      "Emails still send, but never tell anyone what their own results mean: no insight sentences, no personal line built on them, and no holding an email until there's something to say.",
  },
  deletion: {
    severity: "compliance",
    title: "Handle account deletion",
    action:
      "When an account is erased, send `DELETE /api/v2/users/{userId}`. While deletion is pending, set `excluded` so they get no more email.",
    ifSkipped: "We keep a deleted person's profile and may keep emailing someone who asked to delete their account.",
  },
  preferences: {
    severity: "compliance",
    title: "Sync email preferences",
    action:
      "When someone opts out of this email in your product, PATCH `subscribed: false` (`true` when they opt back in). Apply what our webhook sends you: unsubscribes from our emails, and bounces or spam complaints.",
    ifSkipped: "Someone who opts out in your product still gets lifecycle emails (our own unsubscribe links always work).",
  },
  timezone: {
    severity: "recommended",
    title: "Send each user's timezone",
    action: "Include `timezone` (an IANA name, e.g. Europe/London) in the PATCH — from the browser at sign-up if you don't store one.",
    ifSkipped: "Emails arrive at the default timezone's morning, not each person's.",
  },
  exit: {
    severity: "recommended",
    title: "Exclude people who shouldn't get onboarding email",
    action: 'Set `excluded` (e.g. `{"reason": "staff"}`) for staff, test accounts, invited teammates and any special accounts.',
    ifSkipped: "Staff and invited teammates get onboarding emails meant for new customers.",
  },
  invite: {
    severity: "recommended",
    title: "Keep the waitlist invite code at sign-up",
    action:
      "Invite links land on your sign-up page with ?yg_invite=…; keep it through sign-up and send it back in the sign-up PATCH as `traits.yg_invite`. Carry it in the URL through your sign-in redirect if storing it in the browser would need cookie consent.",
    ifSkipped: "Invited people who sign up with a different email aren't counted as signed up from their invite.",
  },
};

/**
 * Phase 1: what a journey needs to run lawfully — the sign-up PATCH (with its
 * timezone), opt-outs, exclusions and deletion. Personalisation waits until it's live.
 */
export const PHASE_1: ReadonlySet<TaskId> = new Set<TaskId>(["signup", "deletion", "preferences", "timezone", "exit"]);

/** Phase 1 first, then personalisation. `entities` only when the product lets people have several of something. */
const ORDER: TaskId[] = ["signup", "deletion", "preferences", "timezone", "exit", "entities", "steps", "context"];
const HOOK_TASK: Record<string, TaskId> = {
  signup: "signup",
  deletion: "deletion",
  consent: "preferences",
  preferences: "preferences",
  timezone: "timezone",
  exit_rule: "exit",
};

type Evidence = { path: string; line?: number | null; verified: boolean };

/** Tests, docs and plans are fine as evidence, but the wrong place to send a developer. */
const NOT_SOURCE = /(^|\/)(__tests__|__mocks__|tests?|spec|docs?|plans?|examples?)\/|\.(test|spec|stories)\.[cm]?[jt]sx?$|\.(md|mdx|txt|rst)$/i;

function files(items: Array<{ evidence: Evidence[] }>): IntegrationTask["files"] {
  const seen = new Set<string>();
  const out: IntegrationTask["files"] = [];
  for (const it of items) {
    for (const e of it.evidence) {
      if (!e.verified) continue;
      const key = `${e.path}:${e.line ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ path: e.path, line: e.line ?? null });
    }
  }
  // Point at real source first; fall back to docs/tests only if that's all there is.
  const source = out.filter((f) => !NOT_SOURCE.test(f.path));
  return (source.length ? source : out).slice(0, 5);
}

export function buildIntegrationTasks(input: {
  map: ProductMap | null;
  health: { lastEventAt?: string | null; lastContextOkAt?: string | null; lastContextError?: string | null } | null;
  contextEnabled: boolean;
  /** Nav v2 phase 4: add the optional "keep the invite code" task while waitlist invites are on. */
  invites?: boolean;
}): IntegrationTask[] {
  const { map } = input;
  const h = input.health ?? {};
  const hooksFor = (id: TaskId) => (map?.hooks ?? []).filter((x) => HOOK_TASK[x.kind] === id);
  const several = (map?.entityKinds ?? []).filter((k) => k.multiple);
  const order: TaskId[] = (input.invites ? [...ORDER, "invite" as const] : ORDER).filter((id) => id !== "entities" || several.length > 0);
  return order.map((id) => {
    const hooks = hooksFor(id);
    const sourceItems =
      id === "steps"
        ? [...(map?.onboardingSteps ?? []), ...(map?.facts ?? [])]
        : id === "context"
          ? (map?.facts ?? [])
          : id === "entities"
            ? several
            : hooks;
    if (id === "entities") {
      const found = several.map((k) => `People can have several ${k.plural} (\`${k.kind}\`${k.parent ? `, inside a ${k.parent}` : ""})${k.membership ? `: ${k.membership}` : ""}.`);
      return { id, ...META[id], fromCode: found, files: files(sourceItems), status: "todo" as const };
    }
    const status: IntegrationTask["status"] =
      (id === "signup" && h.lastEventAt) || (id === "context" && input.contextEnabled && h.lastContextOkAt && !h.lastContextError) ? "done" : "todo";
    return { id, ...META[id], fromCode: hooks.map((x) => x.description), files: files(sourceItems), status };
  });
}
