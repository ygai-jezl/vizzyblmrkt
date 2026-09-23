import type { ProductMap } from "./productMapSchema";

/**
 * The customer's side of the integration as a PRIORITISED TO-DO LIST — what to
 * build, where in their own code (from "Learn from repo"), and what happens if
 * they skip it — plus a ready-to-paste prompt for their coding agent.
 *
 * Only sign-up events are required for a journey to run at all; everything else
 * makes it personal, or keeps it compliant. Saying that plainly is the point.
 */

export type TaskSeverity = "required" | "compliance" | "personalisation" | "recommended";
export type TaskId = "signup" | "steps" | "context" | "deletion" | "preferences" | "timezone" | "exit";

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
  return out.slice(0, 5);
}

export function buildIntegrationTasks(input: {
  map: ProductMap | null;
  health: { lastEventAt?: string | null; lastContextOkAt?: string | null; lastContextError?: string | null } | null;
  contextEnabled: boolean;
}): IntegrationTask[] {
  const { map } = input;
  const h = input.health ?? {};
  const hooksFor = (id: TaskId) => (map?.hooks ?? []).filter((x) => HOOK_TASK[x.kind] === id);
  return ORDER.map((id) => {
    const hooks = hooksFor(id);
    const sourceItems = id === "steps" ? (map?.onboardingSteps ?? []) : id === "context" ? (map?.facts ?? []) : hooks;
    const status: IntegrationTask["status"] =
      (id === "signup" && h.lastEventAt) || (id === "context" && input.contextEnabled && h.lastContextOkAt && !h.lastContextError) ? "done" : "todo";
    return { id, ...META[id], fromCode: hooks.map((x) => x.description), files: files(sourceItems), status };
  });
}

// ---- The prompt for their coding agent ----------------------------------------

export interface AgentPromptInput {
  productName: string;
  keyId: string;
  origin: string;
  tasks: IntegrationTask[];
  steps: Array<{ id: string; label: string; completion: string; how?: string | null }>;
  facts: Array<{ id: string; label: string; unit: string | null; source: string }>;
  events: Array<{ name: string; when: string }>;
  warnings: string[];
}

const HOW: Record<string, string> = {
  server_event: "send it where the server makes this happen",
  reconcile: "derive it from stored state in a scheduled job, with a stable messageId like `{userId}:step:{stepId}`",
  client_only: "it's only computed in the browser today — derive it from stored state in a scheduled job",
};

/**
 * Markdown instructions a coding agent (Claude Code, Cursor, …) can follow in the
 * customer's repo. Contains no secrets — only env var names and the public key id.
 */
export function buildAgentPrompt(p: AgentPromptInput): string {
  const lines: string[] = [];
  const push = (...l: string[]) => lines.push(...l);
  push(
    `# Connect ${p.productName} to YouGrow lifecycle email`,
    "",
    `You're working in the ${p.productName} codebase. Implement our side of the YouGrow integration below, in priority order. YouGrow analysed this repository (read-only) to find where each piece belongs — verify each location before changing it, and ask me if something doesn't match.`,
    "",
    "## Ground rules",
    `- Server-side only. Read credentials from environment variables: \`YOUGROW_KEY_ID\` (public, value \`${p.keyId}\`) and \`YOUGROW_SECRET\` (secret — it's in our secret manager; never commit, log or send it to a browser).`,
    `- Follow the docs: ${p.origin}/developers/events, ${p.origin}/developers/context-endpoint, ${p.origin}/developers/webhooks, ${p.origin}/developers/security.`,
    "- Give every event a unique `messageId` — deterministic where you can, so retries and repeats are harmless.",
    "- Never let a YouGrow call break our own flows: send events asynchronously, and catch and log failures.",
    "- Add tests for each part, and keep changes small and reviewable.",
    "",
    "## Tasks",
  );
  p.tasks.forEach((t, i) => {
    push("", `### ${i + 1}. [${SEVERITY_LABEL[t.severity]}] ${t.title}${t.status === "done" ? " — already working, just check it" : ""}`, `Do: ${t.action}`, `If skipped: ${t.ifSkipped}`);
    if (t.fromCode.length) push("Found in our code:", ...t.fromCode.map((c) => `- ${c}`));
    if (t.files.length) push("Look at:", ...t.files.map((f) => `- \`${f.path}${f.line ? `:${f.line}` : ""}\``));
    if (t.id === "steps" && p.steps.length) {
      push("Steps (use these exact ids):", ...p.steps.map((s) => `- \`${s.id}\` — ${s.label}${s.completion ? `; done when ${s.completion}` : ""}${s.how && HOW[s.how] ? ` (${HOW[s.how]})` : ""}`));
    }
    if (t.id === "context") {
      if (p.steps.length) push(`Return \`steps\` with these ids: ${p.steps.map((s) => `\`${s.id}\``).join(", ")}, and \`nextStep\` = the first not done.`);
      if (p.facts.length) push("Return these `facts` (ids must match exactly):", ...p.facts.map((f) => `- \`${f.id}\` — ${f.label}${f.unit ? ` (${f.unit})` : ""}${f.source ? `; from ${f.source}` : ""}`));
      push("Verify our request first: `Authorization: Bearer <JWT>`, ES256, keys at `" + p.origin + "/.well-known/jwks.json`, audience = `YOUGROW_KEY_ID`, direction `context`, and the body hash — the Node SDK's `createVerifier` does all of this.");
    }
  });
  if (p.events.length) {
    push("", "## Events to send (exact names)", ...p.events.map((e) => `- \`${e.name}\` — ${e.when}`));
  }
  if (p.warnings.length) push("", "## Gaps YouGrow noticed in our code", ...p.warnings.map((w) => `- ${w}`));
  push(
    "",
    "## Done when",
    `- YouGrow → Products → ${p.productName} → **Events** shows \`identify\` and \`user.signed_up\` arriving (and step events as steps are completed).`,
    "- **Test connection** on the same page passes, showing the steps and facts above.",
    "- Deleting a test account sends `user.deleted`; changing its email preferences sends `email_preferences.updated`.",
  );
  return lines.join("\n");
}
