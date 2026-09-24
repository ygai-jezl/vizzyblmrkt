import { createHash } from "node:crypto";
import { validateJourneyGraph } from "@/lib/email/delivery";
import type { Journey, JourneyBranch, JourneyCondition, JourneyNode } from "@/lib/types/journey";
import {
  LifecycleDraftSchema,
  MAX_WAIT_HOURS,
  type ContentPool,
  type LifecycleBranch,
  type LifecycleDraft,
  type LifecycleEdge,
  type LifecycleNode,
  type PoolItem,
} from "@/lib/types/lifecycle";
import { NO_CATALOG, validateLifecycleDraft } from "../graph";
import { waitlistSettings } from "../service";

/**
 * The CONVERTER (engine move D3): a launch's journey on the original engine →
 * a lifecycle draft that sends the same emails, to the same people, at the same
 * times. Pure — the preview and the switch both call it.
 *
 *   trigger   → trigger
 *   email     → an email with the SAME id, backed by a pool: its copy is the
 *               `control` item; a running A/B test adds its variants (same ids)
 *               with the same split; a promoted test is already the winner
 *   waits     → one wait of the total length, counted from the previous step
 *               (a wait before a plain end does nothing, so it's dropped)
 *   condition → the same branches on `signup.*` fields; a branch with nothing
 *               connected (and a missing default) ENDS the journey, as today
 *   exit      → an exit; a weekly exit stays weekly; a "sequence" exit never
 *               ran its hand-off, so it becomes a plain end
 *
 * Node, branch and variant ids are kept, so each email's history continues
 * across engines. Blocked (no draft) by: an original journey that wouldn't
 * publish, a loop, an empty or oversized email, an unsupported id, or more than
 * 60 emails.
 */

export interface ConversionIssue {
  code: string;
  nodeId?: string;
  /** A machine-readable detail, e.g. why the original journey wouldn't publish. */
  detail?: string;
  message: string;
}

export interface ConversionReport {
  ok: boolean;
  blocking: ConversionIssue[];
  notes: ConversionIssue[];
  stats: { emails: number; abTests: number; conditions: number; waits: number; exits: number };
}

const MAX_EMAILS = 60;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const NODE_ID = /^.{1,64}$/;

/** A pool id per email node: stable, and always a valid slug. */
export function poolIdFor(nodeId: string): string {
  return `p_${createHash("sha256").update(nodeId).digest("hex").slice(0, 12)}`;
}

function rulesOf(b: JourneyBranch): JourneyCondition[] {
  return b.conditions && b.conditions.length > 0 ? b.conditions : b.condition ? [b.condition] : [];
}

/**
 * `lenient` (Vizzy's drafts for a moved launch): a draft may be unfinished, so
 * what would block a switch — an original that wouldn't publish, an empty email,
 * problems in the converted draft — is only noted; publishing checks it all.
 */
export function convertLegacyJourney(
  journey: Pick<Journey, "graph">,
  opts: { lenient?: boolean } = {},
): { draft: LifecycleDraft | null; report: ConversionReport } {
  const blocking: ConversionIssue[] = [];
  const notes: ConversionIssue[] = [
    { code: "publish_to_change", message: "After the switch, edits to this journey take effect when you publish them." },
    { code: "versions", message: "People already in the journey keep the version they started on." },
  ];
  const stats: ConversionReport["stats"] = { emails: 0, abTests: 0, conditions: 0, waits: 0, exits: 0 };
  const done = (draft: LifecycleDraft | null) => ({
    draft: blocking.length === 0 ? draft : null,
    report: { ok: blocking.length === 0, blocking, notes, stats },
  });

  const { graph } = journey;
  const original = validateJourneyGraph(graph);
  if (!original.ok && !opts.lenient) {
    blocking.push({ code: "invalid_original", detail: original.reason, message: `The journey can't be published as it is (${original.reason}). Fix it first.` });
    return done(null);
  }
  if (!original.ok) notes.push({ code: "incomplete", detail: original.reason, message: `Not ready to publish yet (${original.reason}).` });

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  // Connections exactly as the original engine follows them: the first one out
  // (or the branch's), even when it points at a step that's gone (= the end).
  const outs = (id: string) => graph.edges.filter((e) => e.source === id);
  for (const e of graph.edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) {
      notes.push({ code: "dangling_edge", message: `A connection to a missing step was ignored (${e.id}).` });
    }
  }

  // The entry, as the original engine finds it: the trigger, else the first node nobody points at.
  const trigger = graph.nodes.find((n) => n.type === "trigger");
  const targets = new Set(graph.edges.map((e) => e.target));
  const entry = trigger ?? graph.nodes.find((n) => !targets.has(n.id)) ?? null;
  if (!entry) {
    blocking.push({ code: "no_entry", message: "The journey has no starting point." });
    return done(null);
  }

  const nodes: LifecycleNode[] = [];
  const edges: LifecycleEdge[] = [];
  const pools: ContentPool[] = [];
  const made = new Set<string>();
  const endFor = new Map<string, string>();
  let edgeCount = 0;
  const edge = (source: string, target: string, sourceHandle: string | null = null) =>
    edges.push({ id: `e${(edgeCount += 1)}`, source, target, sourceHandle });
  /** A plain end, added where the original engine would simply stop. */
  const endAfter = (fromId: string, position: { x: number; y: number }): string => {
    const id = `end_${createHash("sha256").update(fromId).digest("hex").slice(0, 12)}`;
    if (!endFor.has(id)) {
      endFor.set(id, id);
      nodes.push({ id, type: "exit", position: { x: position.x + 40, y: position.y + 120 }, data: { label: "End" } });
      stats.exits += 1;
    }
    return id;
  };

  /**
   * Follow the original engine's route from `fromId` (through waits, summing
   * them) to the next real step, returning the lifecycle node to connect to —
   * a wait (counted from the previous step) then the step, or an end.
   */
  const route = (fromId: string, handle: string | null, position: { x: number; y: number }): string => {
    const first = handle === null ? outs(fromId)[0] : outs(fromId).find((e) => (e.sourceHandle ?? null) === handle);
    if (handle === null && outs(fromId).length > 1) {
      notes.push({ code: "extra_connections", nodeId: fromId, message: "Only the first connection from this step was ever followed; the others are dropped." });
    }
    let hours = 0;
    let waitId: string | null = null;
    let cursor = first && byId.has(first.target) ? first.target : null;
    const seen = new Set<string>([fromId]);
    while (cursor) {
      const n = byId.get(cursor)!;
      if (seen.has(cursor)) {
        blocking.push({ code: "cycle", nodeId: cursor, message: "The journey loops back on itself." });
        return endAfter(fromId, position);
      }
      seen.add(cursor);
      if (n.type !== "wait") break;
      hours += n.data.waitHours ?? 0;
      waitId ??= n.id;
      const next = outs(n.id)[0]?.target;
      cursor = next && byId.has(next) ? next : null;
    }
    const target = cursor ? byId.get(cursor)! : null;
    // Nothing after it, or a plain end: the original engine just stops here.
    if (!target || (target.type === "exit" && target.data.exitTargetKind !== "weekly")) {
      if (hours > 0) notes.push({ code: "wait_before_end", nodeId: waitId ?? fromId, message: "A wait just before the end did nothing, so it's dropped." });
      if (target) {
        convertNode(target);
        return target.id;
      }
      return endAfter(fromId, position);
    }
    convertNode(target);
    if (waitId === null) return target.id;
    if (hours > MAX_WAIT_HOURS) {
      blocking.push({ code: "wait_too_long", nodeId: waitId, message: "A wait is longer than two years." });
    }
    const id = `wait_${createHash("sha256").update(`${fromId}\n${handle ?? ""}`).digest("hex").slice(0, 12)}`;
    if (!made.has(id)) {
      made.add(id);
      const w = byId.get(waitId)!;
      nodes.push({
        id,
        type: "wait",
        position: w.position,
        data: { label: w.data.label ?? `Wait ${hours} h`, wait: { minHours: hours, after: "previous_step" } },
      });
      stats.waits += 1;
      edge(id, target.id);
    }
    return id;
  };

  const convertNode = (n: JourneyNode): void => {
    if (made.has(n.id)) return;
    made.add(n.id);
    if (!NODE_ID.test(n.id)) blocking.push({ code: "unsupported_id", nodeId: n.id, message: "A step's id is too long to keep." });
    switch (n.type) {
      case "trigger": {
        nodes.push({ id: n.id, type: "trigger", position: n.position, data: { label: n.data.label ?? "Joined" } });
        edge(n.id, route(n.id, null, n.position));
        return;
      }
      case "email": {
        stats.emails += 1;
        const subject = (n.data.subject ?? "").trim();
        const body = n.data.body ?? "";
        if (!subject || !body.trim()) {
          (opts.lenient ? notes : blocking).push({ code: "email_empty", nodeId: n.id, message: "An email has no subject or no body." });
        }
        const item = (id: string, label: string, s: string, b: string, hero: string | null | undefined): PoolItem => {
          if (s.length > 200 || b.length > 20_000) blocking.push({ code: "email_too_long", nodeId: n.id, message: "An email's subject or body is too long." });
          return {
            id,
            label: label.slice(0, 120) || "Email",
            subject: s.slice(0, 200),
            body: b.slice(0, 20_000),
            heroImageUrl: hero ?? null,
            format: "branded",
            messageClass: "marketing",
            personalization: "none",
          };
        };
        const label = n.data.label?.trim() || subject || "Email";
        const items = [item("control", label, n.data.subject ?? "", body, n.data.heroImageUrl)];
        const ab = n.data.abTest;
        let abTest: ContentPool["abTest"];
        if (ab?.enabled && ab.status === "running" && ab.variants.length > 0) {
          stats.abTests += 1;
          abTest = { splitPercent: ab.splitPercent };
          ab.variants.forEach((v, i) => {
            if (!SLUG.test(v.variantId)) {
              blocking.push({ code: "unsupported_id", nodeId: n.id, message: `An A/B variant's id can't be kept (${v.variantId}).` });
            }
            items.push(item(v.variantId, `Variant ${String.fromCharCode(66 + i)}`, v.subject, v.body, v.heroImageUrl));
          });
        } else if (ab?.status === "promoted") {
          notes.push({ code: "ab_promoted", nodeId: n.id, message: "This email's A/B test was already decided: the winner carries on." });
        }
        const poolId = poolIdFor(n.id);
        pools.push({ id: poolId, label: label.slice(0, 120), items, ...(abTest ? { abTest } : {}) });
        nodes.push({ id: n.id, type: "email", position: n.position, data: { label: label.slice(0, 120), poolId } });
        edge(n.id, route(n.id, null, n.position));
        return;
      }
      case "condition": {
        stats.conditions += 1;
        const branches: LifecycleBranch[] = [];
        for (const b of n.data.branches ?? []) {
          const rules = rulesOf(b);
          if (rules.length === 0) {
            notes.push({ code: "empty_branch", nodeId: n.id, message: "A branch with no rules never matched anyone, so it's dropped." });
            continue;
          }
          branches.push({
            id: b.id,
            ...(b.label ? { label: b.label.slice(0, 80) } : {}),
            match: b.match ?? "all",
            conditions: rules.map((c) => ({
              field: `signup.${c.field}`,
              operator: c.operator,
              ...(c.value !== undefined ? { value: c.value } : {}),
              ...(c.questionValue ? { questionValue: c.questionValue } : {}),
            })),
          });
        }
        nodes.push({ id: n.id, type: "condition", position: n.position, data: { ...(n.data.label ? { label: n.data.label } : {}), branches } });
        for (const b of branches) {
          const wired = outs(n.id).some((e) => (e.sourceHandle ?? null) === b.id);
          if (!wired) notes.push({ code: "branch_ends", nodeId: n.id, message: "A branch with nothing connected ends the journey for the people who take it, as it does today." });
          edge(n.id, wired ? route(n.id, b.id, n.position) : endAfter(`${n.id}\n${b.id}`, n.position), b.id);
        }
        const hasDefault = outs(n.id).some((e) => e.sourceHandle === "default");
        edge(n.id, hasDefault ? route(n.id, "default", n.position) : endAfter(`${n.id}\ndefault`, n.position), "default");
        return;
      }
      case "exit": {
        stats.exits += 1;
        const weekly = n.data.exitTargetKind === "weekly";
        if (n.data.exitTargetKind === "sequence") {
          notes.push({ code: "sequence_exit", nodeId: n.id, message: "The hand-off to an email sequence never ran, so this is a plain end." });
        }
        nodes.push({
          id: n.id,
          type: "exit",
          position: n.position,
          data: { label: n.data.label ?? (weekly ? "Weekly newsletter" : "End"), ...(weekly ? { exitTarget: "weekly" as const } : {}) },
        });
        return;
      }
      case "wait":
        // Waits are folded into the step after them (see route).
        return;
    }
  };

  if (entry.type === "trigger") convertNode(entry);
  else {
    // No trigger: start from the entry the original engine uses.
    const t = { id: "trigger", position: { x: entry.position.x, y: entry.position.y - 120 } };
    nodes.push({ id: t.id, type: "trigger", position: t.position, data: { label: "Joined" } });
    made.add(t.id);
    if (entry.type === "wait") {
      // The original engine starts after any waits at the entry.
      edge(t.id, route(entry.id, null, entry.position));
    } else {
      convertNode(entry);
      edge(t.id, entry.id);
    }
  }

  const unreachable = graph.nodes.filter((n) => n.type !== "wait" && !made.has(n.id));
  if (unreachable.length > 0) {
    notes.push({ code: "unreachable", message: `${unreachable.length} step${unreachable.length === 1 ? "" : "s"} no one could reach ${unreachable.length === 1 ? "is" : "are"} left out.` });
  }
  if (stats.emails > MAX_EMAILS) blocking.push({ code: "too_many_emails", message: `More than ${MAX_EMAILS} emails.` });
  if (blocking.length > 0) return done(null);

  const parsed = LifecycleDraftSchema.safeParse({ graph: { nodes, edges }, pools, settings: waitlistSettings() });
  if (!parsed.success) {
    blocking.push({ code: "unsupported_shape", message: `The converted journey isn't valid: ${parsed.error.issues[0]?.message ?? "unknown"}.` });
    return done(null);
  }
  for (const issue of validateLifecycleDraft(parsed.data, NO_CATALOG, { audience: "waitlist" }).issues) {
    (opts.lenient ? notes : blocking).push({
      code: `converted_${issue.code}`,
      nodeId: issue.nodeId,
      message: `The converted journey has a problem (${issue.code}${issue.detail ? `: ${issue.detail}` : ""}).`,
    });
  }
  return done(parsed.data);
}
