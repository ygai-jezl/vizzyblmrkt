import type { ProductMap } from "./productMapSchema";

/**
 * The customer's side of the integration as a PRIORITISED TO-DO LIST — what to
 * build, where in their own code (from "Learn from repo"), and what happens if
 * they skip it. Browser-safe (the Learn from repo screen uses it); the prompt
 * for their coding agent is built server-side in agentPrompt.ts.
 *
 * Only sign-up events are required for a journey to run at all; everything else
 * makes it personal, or keeps it compliant. Saying that plainly is the point.
 */

export type TaskSeverity = "required" | "compliance" | "personalisation" | "recommended";
export type TaskId = "signup" | "steps" | "context" | "deletion" | "preferences" | "timezone" | "exit" | "invite";

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
    action: "Where a new account is created, send an identify (email, first name, timezone, consent) and a user.signed_up event.",
    ifSkipped: "Nobody is ever enrolled — the journey sends no emails at all.",
  },
  steps: {
    severity: "personalisation",
    title: "Report onboarding steps",
    action: "Send onboarding.step_completed with the step id when each step becomes done (at the server moment, or from a scheduled check of stored state).",
    ifSkipped: "Everyone takes the reminder branch, and people get nudged to do steps they've already done.",
  },
  context: {
    severity: "personalisation",
    title: "Build the context endpoint",
    action: "Answer our signed request for one user with their live steps, next step, facts and insight sentences, and hold/exit when needed.",
    ifSkipped: "Emails still send, but without the person's own facts and insights, and branching relies on events alone.",
  },
  deletion: {
    severity: "compliance",
    title: "Handle account deletion",
    action: "Return exit from the context endpoint while deletion is pending, and send user.deleted when the account is erased.",
    ifSkipped: "We keep a deleted person's profile and may keep emailing someone who asked to delete their account.",
  },
  preferences: {
    severity: "compliance",
    title: "Sync email preferences",
    action: "Send email_preferences.updated when someone changes preferences in your product, and apply the unsubscribes our webhook sends you.",
    ifSkipped: "Someone who opts out in your product still gets lifecycle emails (our own unsubscribe links always work).",
  },
  timezone: {
    severity: "recommended",
    title: "Send each user's timezone",
    action: "Include the user's IANA timezone (e.g. Europe/London) in identify — from the browser at sign-up if you don't store one.",
    ifSkipped: "Emails arrive at the default timezone's morning, not each person's.",
  },
  exit: {
    severity: "recommended",
    title: "Exclude people who shouldn't get onboarding email",
    action: "Return exit from the context endpoint for staff, invited teammates and any special accounts.",
    ifSkipped: "Staff and invited teammates get onboarding emails meant for new customers.",
  },
  invite: {
    severity: "recommended",
    title: "Keep the waitlist invite code at sign-up",
    action:
      "Invite links land on your sign-up page with ?yg_invite=…; keep it through sign-up and send it back as a trait (yg_invite) or a user.signed_up property.",
    ifSkipped: "Invited people who sign up with a different email aren't counted as signed up from their invite.",
  },
};

const ORDER: TaskId[] = ["signup", "steps", "context", "deletion", "preferences", "timezone", "exit"];
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
  const order: TaskId[] = input.invites ? [...ORDER, "invite"] : ORDER;
  return order.map((id) => {
    const hooks = hooksFor(id);
    const sourceItems = id === "steps" ? (map?.onboardingSteps ?? []) : id === "context" ? (map?.facts ?? []) : hooks;
    const status: IntegrationTask["status"] =
      (id === "signup" && h.lastEventAt) || (id === "context" && input.contextEnabled && h.lastContextOkAt && !h.lastContextError) ? "done" : "todo";
    return { id, ...META[id], fromCode: hooks.map((x) => x.description), files: files(sourceItems), status };
  });
}
