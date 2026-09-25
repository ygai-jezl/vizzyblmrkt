import type { ProductConnection } from "@/lib/types/productConnection";
import { isInvitesEnabled } from "@/lib/invites/flags";
import type { RepoAnalysis } from "@/lib/types/repoAnalysis";
import type { ProductMap } from "./productMapSchema";
import { RESERVED_EVENTS } from "./protocol";
import { buildAgentPrompt } from "./agentPrompt";
import { buildIntegrationTasks, type IntegrationTask } from "./integrationTasks";

/**
 * The per-connection INTEGRATION GUIDE: exactly what this customer's developers
 * need to build on their side, using their own step ids, events and facts —
 * generated from the connection's catalog and, when they've run "Learn from
 * repo", what we learned from their code (how each step can be detected, their
 * deletion / consent / timezone handling, and gaps). Documentation only: we never
 * write to their repository.
 */

export type GuideStatus = "done" | "todo" | "info";

export interface GuideEvent {
  name: string;
  when: string;
  properties?: Record<string, string>;
  /** How to detect it: at a clear server moment, or by a scheduled reconcile. */
  how?: "server_event" | "reconcile" | "client_only" | null;
}

export interface IntegrationGuide {
  keyId: string;
  eventsUrl: string;
  /** Null when this YouGrow doesn't publish /developers. */
  docsUrl: string | null;
  status: { eventsReceived: GuideStatus; contextEndpoint: GuideStatus; webhookEndpoint: GuideStatus; catalog: GuideStatus };
  identify: { traits: Array<{ key: string; note: string }> };
  events: GuideEvent[];
  context: {
    steps: Array<{ id: string; label: string; completion: string }>;
    facts: Array<{ id: string; label: string; unit: string | null; source: string }>;
    exitRules: string[];
  };
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
  const detection = new Map((map?.onboardingSteps ?? []).map((s) => [s.id, s.detection] as const));
  const reserved = new Set<string>(Object.values(RESERVED_EVENTS));

  const timezoneGap = mapHooks(map, "timezone");
  const traits: IntegrationGuide["identify"]["traits"] = [
    { key: "email", note: "Required to email them." },
    { key: "firstName", note: "Used in greetings (falls back to “there”)." },
    { key: "timezone", note: timezoneGap.length ? `IANA name, e.g. Europe/London. From your code: ${timezoneGap[0]}` : "IANA name, e.g. Europe/London — emails go out in each person's morning." },
    ...cat.traits.map((t) => ({ key: t.key, note: [t.label, t.description].filter(Boolean).join(" — ") || `${t.type} — journeys can branch on it.` })),
  ];

  const events: GuideEvent[] = [
    { name: RESERVED_EVENTS.signedUp, when: "Once, when an account is created — send an identify with it." },
    ...steps.map((s) => ({
      name: RESERVED_EVENTS.stepCompleted,
      properties: { step: s.id },
      when: s.completion ? `When ${s.completion.charAt(0).toLowerCase()}${s.completion.slice(1)}` : `When “${s.label}” is done.`,
      how: detection.get(s.id) ?? null,
    })),
    ...(steps.length ? [{ name: RESERVED_EVENTS.onboardingCompleted, when: "When every onboarding step above is done." }] : []),
    ...cat.events.filter((e) => !reserved.has(e.name)).map((e) => ({ name: e.name, when: e.description || e.label || "When it happens." })),
    {
      name: RESERVED_EVENTS.userDeleted,
      when: mapHooks(map, "deletion")[0] ? `When an account is deleted. From your code: ${mapHooks(map, "deletion")[0]}` : "When an account is deleted (after any grace period).",
    },
    {
      name: RESERVED_EVENTS.preferencesUpdated,
      properties: { category: "onboarding", subscribed: "true | false" },
      when: mapHooks(map, "preferences")[0] ?? mapHooks(map, "consent")[0] ?? "When someone changes their email preferences in your product.",
    },
  ];

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
    invites: isInvitesEnabled(),
  });
  // Steps for the prompt: the accepted catalog, or — before anything's accepted — what the code suggested.
  const promptSteps = steps.length
    ? steps.map((s) => ({ id: s.id, label: s.label, completion: s.completion ?? "", how: detection.get(s.id) ?? null }))
    : (map?.onboardingSteps ?? []).map((s) => ({ id: s.id, label: s.label, completion: s.completion, how: s.detection }));
  const promptFacts = (cat.facts ?? []).length
    ? (cat.facts ?? []).map((f) => ({ id: f.id, label: f.label, unit: f.unit ?? null, source: f.source }))
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
    events: events.map((e) => ({ name: e.properties ? `${e.name} ${JSON.stringify(e.properties)}` : e.name, when: e.when })),
    warnings: map?.warnings ?? [],
  });

  return {
    keyId: connection.keyId,
    eventsUrl: `${origin}/api/v1/events`,
    docsUrl: docs ? `${origin}/developers` : null,
    status,
    identify: { traits },
    events,
    context: {
      steps: steps.map((s) => ({ id: s.id, label: s.label, completion: s.completion ?? "" })),
      facts: (cat.facts ?? []).map((f) => ({ id: f.id, label: f.label, unit: f.unit ?? null, source: f.source })),
      exitRules: mapHooks(map, "exit_rule"),
    },
    notes,
    tasks,
    agentPrompt,
    warnings: map?.warnings ?? [],
    fromRepo: Boolean(map),
  };
}
