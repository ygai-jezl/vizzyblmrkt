import type { CatalogTrait, ProductConnection } from "@/lib/types/productConnection";
import { isInvitesEnabled } from "@/lib/invites/flags";
import type { RepoAnalysis } from "@/lib/types/repoAnalysis";
import type { ProductMap } from "./productMapSchema";
import { RESERVED_EVENTS } from "./protocol";
import { EventRequestSchema, UserPatchSchema, V2_PATHS } from "./v2/contract";
import { buildAgentPrompt } from "./agentPrompt";
import { buildIntegrationTasks, type IntegrationTask } from "./integrationTasks";

/**
 * The per-connection INTEGRATION GUIDE: exactly what this customer's developers
 * need to build on their side (API v2: each user's state, field by field), using
 * their own step ids, facts and traits — generated from the connection's catalog
 * and, when they've run "Learn from repo", what we learned from their code (how
 * each step can be detected, their deletion / consent / timezone handling, and
 * gaps). Documentation only: we never write to their repository.
 */

export type GuideStatus = "done" | "todo" | "info";

/** How a step can be detected: at a clear server moment, or from a scheduled sync of stored state. */
export type Detection = "server_event" | "reconcile" | "client_only";

/** One field of the PATCH body, as this product should fill it. */
export interface GuideField {
  /** Where it goes in the body, e.g. `email`, `steps.create_brand`, `traits.plan`. */
  field: string;
  /** The value's type, e.g. `string`, `boolean`, `ISO 8601 time`. */
  type: string;
  /**
   * A value to send as it is (JSON), only where the value is fixed — e.g. `false`.
   * Agents copy these literally, so it's never a placeholder.
   */
  example?: string;
  /** When to send it, with anything the code analysis found. */
  when: string;
  /** For steps. */
  how?: Detection | null;
}

/** What to send, grouped by when. */
export interface GuideSend {
  /** In the PATCH when an account is created (Phase 1). */
  signup: GuideField[];
  /** Opt-outs and exclusions (Phase 1). */
  compliance: GuideField[];
  /** Steps and facts, in the same PATCH whenever they change (Phase 2). */
  progress: GuideField[];
  /** When to DELETE the user (Phase 1). */
  deletion: string;
  /** Optional milestones from the catalog — POST …/events. Never sign-ups, steps, opt-outs or deletion. */
  milestones: Array<{ event: string; when: string }>;
}

export interface IntegrationGuide {
  keyId: string;
  /** Where each user's state goes: PATCH `<origin>/api/v2/users/{userId}`. */
  usersUrl: string;
  /** Null when this YouGrow doesn't publish /developers. */
  docsUrl: string | null;
  status: { eventsReceived: GuideStatus; contextEndpoint: GuideStatus; webhookEndpoint: GuideStatus; catalog: GuideStatus };
  send: GuideSend;
  /** For the optional context endpoint: the ids it returns. */
  context: {
    steps: Array<{ id: string; label: string; completion: string }>;
    facts: Array<{ id: string; label: string; unit: string | null; source: string }>;
  };
  /** Who should never get lifecycle email, from the code analysis (→ `excluded`). */
  exclusions: string[];
  notes: Array<{ kind: string; text: string }>;
  /** Their side, as a prioritised to-do list with what happens if skipped. */
  tasks: IntegrationTask[];
  /** Ready to paste into a coding agent in their repo. No secrets. */
  agentPrompt: string;
  warnings: string[];
  fromRepo: boolean;
}

function mapHooks(map: ProductMap | null, kind: string): string[] {
  return (map?.hooks ?? []).filter((h) => h.kind === kind).map((h) => h.description);
}

const TRAIT_TYPE: Record<CatalogTrait["type"], string> = { string: "string", number: "number", boolean: "boolean", timestamp: "ISO 8601 time" };

/** The contract decides: identity keys (email, names, timezone, locale) are fields of their own, not traits. */
const acceptedAsTrait = (key: string) => UserPatchSchema.safeParse({ traits: { [key]: "x" } }).success;
/** …and which events v2 records (sign-ups, steps, opt-outs and deletion are state instead). */
const acceptedAsEvent = (name: string) => EventRequestSchema.safeParse({ event: name }).success;

const lcFirst = (s: string) => `${s.charAt(0).toLowerCase()}${s.slice(1)}`;
/** Ends with a full stop (catalog labels often don't). */
const sentence = (s: string) => (/[.!?…]$/.test(s) ? s : `${s}.`);

export function buildIntegrationGuide(input: {
  connection: Pick<ProductConnection, "keyId" | "catalog" | "contextEndpoint" | "webhookEndpoint" | "health">;
  /** The latest analysis with a map (accepted or not) — adds what we learned from the code. */
  analysis?: Pick<RepoAnalysis, "map"> | null;
  origin: string;
  productName?: string;
  /** Whether this YouGrow publishes /developers (default true); the guide links nothing there when it doesn't. */
  docs?: boolean;
}): IntegrationGuide {
  const { connection, origin } = input;
  const map = input.analysis?.map ?? null;
  const cat = connection.catalog;
  const steps = [...cat.onboardingSteps].sort((a, b) => a.order - b.order);
  const facts = cat.facts ?? [];
  const detection = new Map((map?.onboardingSteps ?? []).map((s) => [s.id, s.detection] as const));
  const invites = isInvitesEnabled();

  const timezoneGap = mapHooks(map, "timezone")[0];
  const preferences = mapHooks(map, "preferences")[0] ?? mapHooks(map, "consent")[0];
  const deletionHook = mapHooks(map, "deletion")[0];
  const exclusions = mapHooks(map, "exit_rule");
  const fromCode = (finding: string | undefined) => (finding ? ` From your code: ${finding}` : "");

  const send: GuideSend = {
    signup: [
      { field: "signedUpAt", type: "ISO 8601 time", when: "When the account was created. It starts your sign-up journeys." },
      { field: "email", type: "string", when: "Required to email them." },
      { field: "firstName", type: "string", when: "Used in greetings (falls back to “there”)." },
      {
        field: "timezone",
        type: "string",
        when: `An IANA name, e.g. Europe/London — emails go out in each person's morning.${fromCode(timezoneGap)}`,
      },
      { field: "consent", type: "string", when: "Your legal basis for marketing email: consent, soft_opt_in, corporate_subscriber or none." },
      ...cat.traits
        .filter((t) => acceptedAsTrait(t.key))
        .map((t) => ({
          field: `traits.${t.key}`,
          type: TRAIT_TYPE[t.type],
          when: sentence([t.label, t.description].filter(Boolean).join(" — ") || "Journeys can branch on it"),
        })),
      ...(invites ? [{ field: "traits.yg_invite", type: "string", when: "The ?yg_invite=… code from the sign-up link, when there was one." }] : []),
    ],
    compliance: [
      {
        field: "subscribed",
        type: "boolean",
        // A real value, not a placeholder: agents copy these literally, and it must be a JSON boolean.
        example: "false",
        when: `When someone opts out of this email in your product; \`true\` when they opt back in. It never lifts an unsubscribe made in our emails.${fromCode(preferences)}`,
      },
      {
        field: "excluded",
        type: "object",
        example: '{"reason":"staff"}',
        when: `For people who must never get lifecycle email — staff, test accounts, invited teammates, accounts pending deletion. \`null\` lifts it.${exclusions.length ? fromCode(exclusions.join(" ")) : ""}`,
      },
    ],
    progress: [
      ...steps.map((s) => ({
        field: `steps.${s.id}`,
        type: "ISO 8601 time",
        when: s.completion ? sentence(`When ${lcFirst(s.completion)}`) : `When “${s.label}” is done.`,
        how: detection.get(s.id) ?? null,
      })),
      ...facts.map((f) => ({
        field: `facts.${f.id}`,
        type: f.type,
        when: `${f.label}${f.unit ? ` (${f.unit})` : ""}${f.source ? `, from ${f.source}` : ""}. Send the latest value.`,
      })),
    ],
    deletion: `When an account is erased (after any grace period).${fromCode(deletionHook)}`,
    milestones: [
      // With no step checklist, this is what marks someone activated; with one (or one proposed), the steps do it.
      ...(steps.length || map?.onboardingSteps?.length
        ? []
        : [{ event: RESERVED_EVENTS.onboardingCompleted, when: "When someone has finished getting started — it marks them activated." }]),
      ...cat.events
        .filter((e) => e.name !== RESERVED_EVENTS.onboardingCompleted && acceptedAsEvent(e.name))
        .map((e) => ({ event: e.name, when: e.description || e.label || "When it happens." })),
    ],
  };

  const h = connection.health ?? {};
  const status: IntegrationGuide["status"] = {
    eventsReceived: h.lastEventAt ? "done" : "todo",
    contextEndpoint: connection.contextEndpoint?.enabled ? (h.lastContextOkAt && !h.lastContextError ? "done" : "todo") : "todo",
    webhookEndpoint: connection.webhookEndpoint?.enabled ? "done" : "info",
    catalog: steps.length > 0 ? "done" : "todo",
  };

  const notes = (map?.hooks ?? [])
    .filter((x) => ["signup", "consent", "other"].includes(x.kind))
    .map((x) => ({ kind: x.kind, text: x.description }));

  const tasks = buildIntegrationTasks({
    map,
    health: connection.health ?? null,
    contextEnabled: Boolean(connection.contextEndpoint?.enabled),
    invites,
  });
  // Steps for the prompt: the accepted catalog, or — before anything's accepted — what the code suggested.
  const promptSteps = steps.length
    ? steps.map((s) => ({ id: s.id, label: s.label, completion: s.completion ?? "", how: detection.get(s.id) ?? null }))
    : (map?.onboardingSteps ?? []).map((s) => ({ id: s.id, label: s.label, completion: s.completion, how: s.detection }));
  const promptFacts = facts.length
    ? facts.map((f) => ({ id: f.id, label: f.label, unit: f.unit ?? null, source: f.source }))
    : (map?.facts ?? []).map((f) => ({ id: f.id, label: f.label, unit: f.unit ?? null, source: f.source }));
  const docs = input.docs ?? true;
  const agentPrompt = buildAgentPrompt({
    productName: input.productName ?? "our product",
    keyId: connection.keyId,
    origin,
    docs,
    tasks,
    steps: promptSteps,
    facts: promptFacts,
    // Ids the customer hasn't accepted yet are Learn from repo's proposals — the prompt must say so.
    proposed: { steps: !steps.length && promptSteps.length > 0, facts: !facts.length && promptFacts.length > 0 },
    send,
    warnings: map?.warnings ?? [],
  });

  return {
    keyId: connection.keyId,
    usersUrl: `${origin}${V2_PATHS.user}`,
    docsUrl: docs ? `${origin}/developers` : null,
    status,
    send,
    context: {
      steps: steps.map((s) => ({ id: s.id, label: s.label, completion: s.completion ?? "" })),
      facts: facts.map((f) => ({ id: f.id, label: f.label, unit: f.unit ?? null, source: f.source })),
    },
    exclusions,
    notes,
    tasks,
    agentPrompt,
    warnings: map?.warnings ?? [],
    fromRepo: Boolean(map),
  };
}
