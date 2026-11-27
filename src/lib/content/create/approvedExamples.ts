import { deletePerformanceExemplars, listApprovedExemplars, writePerformanceExemplar, type ApprovedExemplarRow } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import {
  MAX_EXEMPLAR_CHARS,
  recordExemplar,
  scrubExemplarText,
  type RecordExemplarDeps,
} from "@/lib/distribute/feedback/recordExemplar";
import { htmlToText, looksHtml } from "@/lib/email/emailRender";
import { findCopyBlockIndex } from "@/lib/types/emailLayout";
import type { ContentNode, ContentPlan } from "@/lib/types/contentPlan";
import {
  APPROVED_METRIC,
  approvedExemplarId,
  approvedRefOf,
  approvedSourceId,
  pieceTag,
  type ExamplePiece,
  type ExampleRef,
} from "@/lib/types/performanceExemplar";
import { newlyApproved } from "./aiOriginals";
import { isApprovedExamplesEnabled } from "./flags";

/**
 * Approved examples (CONTENT_APPROVED_EXAMPLES_ENABLED): the workflow emails and hub pieces a person
 * on the brand approved, kept in the exemplar store (performance_exemplars) beside the proven
 * LinkedIn and X posts, on the channel their writer already asks retrieveExemplars for. Only what a
 * person approved is kept, the safe choice for any business: an email or hub approved on the canvas,
 * or a blog article found live on the brand's own site. Results play no part here.
 *
 * Each example is the piece as a person approved it: an email's subject and copy with its merge
 * values still as tags such as {{first_name}} (a recipient's copy is only ever made at send time and
 * never kept), scrubbed and embedded exactly as a proven post is (recordExemplar). One per piece,
 * the newest APPROVED_EXAMPLES_KEPT per channel and kind of piece. An example goes when its piece is
 * taken out of the workflow, or the workflow or its programme is deleted.
 */

/** Approved examples kept per brand, channel and kind of piece; the oldest go first. */
export const APPROVED_EXAMPLES_KEPT = 20;

/** Hub channels whose writer follows examples. An eBook hub holds a whole book, written in the eBook studio. */
const EXAMPLE_HUB_CHANNELS: ReadonlySet<string> = new Set(["newsletter", "blog"]);

/** Every channel an example is kept on: a workflow email is written for "newsletter", a hub for its own channel. */
const EXAMPLE_CHANNELS: readonly string[] = [...new Set(["newsletter", ...EXAMPLE_HUB_CHANNELS])];

type ExampleNode = Pick<ContentNode, "id" | "type" | "channel" | "body"> &
  Partial<Pick<ContentNode, "subject" | "layout" | "placeholderValues">>;

/** Which writer follows this piece as an example, or null when none does. */
export function examplePieceOf(node: Pick<ContentNode, "type" | "channel">): ExamplePiece | null {
  if (node.type === "email") return "email";
  if (node.type === "hub" && EXAMPLE_HUB_CHANNELS.has(node.channel)) return "hub";
  return null;
}

/** An email's own words as plain text: the copy block of its layout (what the writer fills), else its body. */
function emailCopy(node: ExampleNode): string {
  const layout = node.layout ?? null;
  const idx = layout ? findCopyBlockIndex(layout) : -1;
  const block = layout && idx >= 0 ? layout.blocks[idx] : undefined;
  const raw = block && block.kind === "text" ? block.html : node.body;
  return looksHtml(raw) ? htmlToText(raw) : raw;
}

/**
 * The text kept for a piece: an email's subject and copy, or a hub's body. The plan's own link was
 * filled in when the piece was written, so it goes back to {{hub_url}} and never reaches another plan.
 */
export function exampleTextOf(node: ExampleNode): string {
  const body = (node.type === "email" ? emailCopy(node) : node.body).trim();
  const subject = node.type === "email" ? (node.subject ?? "").trim() : "";
  let text = subject ? `Subject: ${subject}\n\n${body}` : body;
  const link = node.placeholderValues?.hub_url;
  if (link && link.length >= 8) text = text.split(link).join("{{hub_url}}");
  return text.trim();
}

export interface ExampleDeps extends RecordExemplarDeps {
  db?: FirestoreLike;
}

export type KeepOutcome = "off" | "skipped" | "unchanged" | "kept";

/**
 * Keep one approved piece as an example. Approving the same copy again embeds nothing; new copy
 * replaces the piece's example, and the oldest beyond APPROVED_EXAMPLES_KEPT go. With embeddings off
 * or failing it keeps nothing, as the proven posts do.
 */
export async function keepApprovedExample(
  ctx: TenantContext,
  args: { workspaceId: string; planId: string; node: ExampleNode },
  deps: ExampleDeps = {},
): Promise<KeepOutcome> {
  if (!isApprovedExamplesEnabled()) return "off";
  // Vizzy writes drafts and never approves, so nothing it does is kept as the brand's own.
  if (ctx.source === "agent") return "skipped";
  const piece = examplePieceOf(args.node);
  const source = approvedSourceId({ workspaceId: args.workspaceId, planId: args.planId, nodeId: args.node.id });
  const text = piece ? exampleTextOf(args.node) : "";
  if (!piece || !source || !text) return "skipped";

  const channel = args.node.channel;
  const id = approvedExemplarId(ctx.tenantId, source);
  const tag = pieceTag(piece);
  const kept = (await listApprovedExemplars(ctx, channel, deps.db).catch(() => [])).filter((r) => r.tags.includes(tag));
  if (kept.some((r) => r.id === id && r.text === scrubExemplarText(text).slice(0, MAX_EXEMPLAR_CHARS))) return "unchanged";

  const write: NonNullable<RecordExemplarDeps["write"]> =
    deps.write ?? ((c, doc, vector) => writePerformanceExemplar(c, doc, vector, deps.db));
  const recorded = await recordExemplar(
    ctx,
    { channel, text, tags: [tag], metric: { name: APPROVED_METRIC, value: 1 }, sourcePostId: source },
    { embed: deps.embed, write },
  );
  if (recorded !== "recorded") return "skipped";

  const older = kept.filter((r) => r.id !== id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const extra = older.slice(APPROVED_EXAMPLES_KEPT - 1).map((r) => r.id);
  if (extra.length) await deletePerformanceExemplars(ctx, extra, deps.db).catch(() => 0);
  return "kept";
}

/** Keep each workflow email and hub piece a plan save approved (the canvas Approve). Never fails the save. */
export async function keepApprovedExamples(
  ctx: TenantContext,
  args: { workspaceId: string; before: ContentPlan; after: ContentPlan | null },
  deps: ExampleDeps = {},
): Promise<number> {
  if (!isApprovedExamplesEnabled()) return 0;
  let n = 0;
  for (const node of newlyApproved(args.before, args.after)) {
    if (!examplePieceOf(node)) continue;
    const outcome = await keepApprovedExample(ctx, { workspaceId: args.workspaceId, planId: args.before.id, node }, deps).catch(
      (err: unknown) => {
        console.error("[approved examples] keeping an example failed:", err instanceof Error ? err.message.slice(0, 200) : "error");
        return "skipped" as const;
      },
    );
    if (outcome === "kept") n += 1;
  }
  return n;
}

/** The id each example piece in this graph would be kept under, whether one was kept or not. */
function graphExampleIds(
  ctx: TenantContext,
  args: { workspaceId: string; planId: string; nodes: readonly Pick<ContentNode, "id" | "type" | "channel">[] },
): string[] {
  const ids: string[] = [];
  for (const node of args.nodes) {
    if (!examplePieceOf(node)) continue;
    const source = approvedSourceId({ workspaceId: args.workspaceId, planId: args.planId, nodeId: node.id });
    if (source) ids.push(approvedExemplarId(ctx.tenantId, source));
  }
  return ids;
}

/**
 * The brand's kept examples whose piece matches, read from the store itself rather than from a
 * graph, so a piece a person removed before is found too. Equality filters only (no new index).
 */
async function storedExampleIds(
  ctx: TenantContext,
  matches: (ref: ExampleRef) => boolean,
  db?: FirestoreLike,
): Promise<string[]> {
  const ids: string[] = [];
  for (const channel of EXAMPLE_CHANNELS) {
    let rows: ApprovedExemplarRow[] = [];
    try {
      rows = await listApprovedExemplars(ctx, channel, db);
    } catch {
      rows = [];
    }
    for (const row of rows) {
      const ref = approvedRefOf(row.sourcePostId);
      if (ref && matches(ref)) ids.push(row.id);
    }
  }
  return ids;
}

/**
 * A deleted plan's examples go with it, whether the switch is on now or not, so a piece kept while
 * it was on never outlives its plan. It deletes what the store holds for the plan, including pieces
 * already taken off the canvas, and what the graph names. Never fails the delete. Returns how many
 * ids were removed.
 */
export async function forgetPlanExamples(
  ctx: TenantContext,
  args: { workspaceId: string; plan: Pick<ContentPlan, "id" | "graph"> },
  deps: { db?: FirestoreLike } = {},
): Promise<number> {
  try {
    const named = graphExampleIds(ctx, { workspaceId: args.workspaceId, planId: args.plan.id, nodes: args.plan.graph?.nodes ?? [] });
    const stored = await storedExampleIds(ctx, (r) => r.workspaceId === args.workspaceId && r.planId === args.plan.id, deps.db);
    const ids = [...new Set([...named, ...stored])];
    return ids.length ? await deletePerformanceExemplars(ctx, ids, deps.db) : 0;
  } catch {
    return 0;
  }
}

/**
 * A piece a save takes out of the workflow (deleted on the canvas) takes its example with it, switch
 * on or not, so a piece nobody can open any more never guides a writer. Never fails the save.
 */
export async function forgetRemovedExamples(
  ctx: TenantContext,
  args: { workspaceId: string; before: Pick<ContentPlan, "id" | "graph">; after: Pick<ContentPlan, "graph"> | null },
  deps: { db?: FirestoreLike } = {},
): Promise<number> {
  if (!args.after) return 0;
  try {
    const left = new Set((args.after.graph?.nodes ?? []).map((n) => n.id));
    const removed = (args.before.graph?.nodes ?? []).filter((n) => !left.has(n.id));
    const ids = graphExampleIds(ctx, { workspaceId: args.workspaceId, planId: args.before.id, nodes: removed });
    return ids.length ? await deletePerformanceExemplars(ctx, ids, deps.db) : 0;
  } catch {
    return 0;
  }
}

/**
 * A deleted programme's examples go with it, switch on or not. Its plans stay in their subcollections
 * (a known gap), but nothing from them guides the brand's other programmes. Never fails the delete.
 */
export async function forgetWorkspaceExamples(
  ctx: TenantContext,
  workspaceId: string,
  deps: { db?: FirestoreLike } = {},
): Promise<number> {
  try {
    const ids = await storedExampleIds(ctx, (r) => r.workspaceId === workspaceId, deps.db);
    return ids.length ? await deletePerformanceExemplars(ctx, ids, deps.db) : 0;
  } catch {
    return 0;
  }
}
