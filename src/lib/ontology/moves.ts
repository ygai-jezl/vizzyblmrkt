import { createHash } from "node:crypto";
import { forTenant, TenantIsolationError } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { ProductConnection } from "@/lib/types/productConnection";
import type { ProductUser } from "@/lib/types/productUser";
import { enqueueEmailJob } from "@/lib/email/jobs";
import { isPeopleConnection, personIdOf, personKeyOf, PRODUCT_USER_KEY_PREFIX } from "@/lib/audience/personSync";
import { isOntologyPersonIdsEnabled } from "./flags";
import { isContactPersonId, type ContactPersonId } from "./person";
import { personIdForProductUser } from "./personRef";

/**
 * Person moves (ONTOLOGY_PERSON_IDS_ENABLED): when a product write leaves a product user with
 * another person than before, the move is kept in `person_moves` and a person_repoint job is
 * queued to bring their rows along (./repoint.ts). The lifecycle tick re-queues any move whose job
 * was lost. Nothing here logs an address or an id: counts only.
 */

/** A move pending longer than this has lost its job, and the tick queues it again. */
export const REPAIR_AFTER_MS = 15 * 60_000;
/** Most pending moves one tick looks at per brand. */
const REPAIR_BATCH = 50;

function hash32(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
}

/** One move per write: the same change made by two writes is two moves. */
export function moveId(tenantId: string, messageId: string, productUserId: string): string {
  return `mv_${hash32(`${tenantId}\n${messageId}\n${productUserId}`)}`;
}

/**
 * The repoint job's key: per product user and the person they are moving to, so a second change
 * while the first is being worked on is never swallowed as a duplicate.
 */
export function repointJobKey(tenantId: string, productUserId: string, target: ContactPersonId): string {
  return `pr_${hash32(`${tenantId}\n${productUserId}\n${target}`)}`;
}

export interface ProductWrite {
  user: ProductUser;
  /** The person key they had before the write (src/lib/audience/personHooks.ts previousPersonKey). */
  previousKey?: string | null;
  /** The write's own message id: one move per write. */
  messageId?: string;
  quiet?: boolean;
}

/** Queue the job that brings a product user's rows to their current person. Deduped by its key. */
async function queueRepoint(ctx: TenantContext, productUserId: string, target: ContactPersonId, db?: FirestoreLike) {
  return enqueueEmailJob(
    ctx,
    { type: "person_repoint", campaignId: "", dedupeKey: repointJobKey(ctx.tenantId, productUserId, target), payload: { productUserId } },
    db,
  );
}

/**
 * After product users were written: record a move for each one whose person changed, and queue
 * the job that moves their rows. Does nothing while the switch is off or for a product whose users
 * are not people (a sandbox, a revoked product). Never throws: a failure is logged as a count, and
 * the move is either repaired by the tick (its job was lost) or corrected by the backfill (it was
 * never written).
 */
export async function ontologyAfterProductWrites(
  ctx: TenantContext,
  connection: Pick<ProductConnection, "id" | "kind" | "status">,
  writes: ReadonlyArray<ProductWrite>,
  deps: { db?: FirestoreLike; nowMs?: number } = {},
): Promise<{ moves: number; jobs: number; failed: number }> {
  const out = { moves: 0, jobs: 0, failed: 0 };
  if (!isOntologyPersonIdsEnabled() || !isPeopleConnection(connection)) return out;
  const nowIso = new Date(deps.nowMs ?? Date.now()).toISOString();
  const repo = forTenant(ctx, deps.db);
  for (const w of writes) {
    const previousKey = w.previousKey ?? null;
    if (!previousKey || previousKey === personKeyOf(w.user)) continue;
    const fromPersonId = personIdOf(ctx.tenantId, previousKey);
    const personId = personIdForProductUser(ctx.tenantId, w.user, connection);
    if (!personId || !isContactPersonId(fromPersonId) || fromPersonId === personId) continue;
    try {
      try {
        await repo.personMoves.create(moveId(ctx.tenantId, w.messageId ?? `at:${nowIso}`, w.user.id), {
          kind: previousKey.startsWith(PRODUCT_USER_KEY_PREFIX) ? "record.merged" : "record.repointed",
          fromPersonId,
          personId,
          productUserId: w.user.id,
          connectionId: connection.id,
          at: nowIso,
          repoint: "pending",
          createdAt: nowIso,
        });
        out.moves += 1;
      } catch (err) {
        // The same write seen twice: its move is already kept.
        if (!(err instanceof TenantIsolationError)) throw err;
      }
      if ((await queueRepoint(ctx, w.user.id, personId, deps.db)) === "enqueued") out.jobs += 1;
    } catch (err) {
      out.failed += 1;
      console.warn(`[ontology] person move failed tenant=${ctx.tenantId}:`, err instanceof Error ? err.message.slice(0, 120) : "error");
    }
  }
  return out;
}

/**
 * On the lifecycle tick: queue the job again for any move still pending after REPAIR_AFTER_MS (its
 * job was lost, or dropped while the switch was off). The job works out the current person when it
 * runs, so an older move's key is fine; a job still queued for it dedupes. Switch off: nothing.
 */
export async function repairPendingMoves(ctx: TenantContext, deps: { db?: FirestoreLike; now?: number } = {}): Promise<{ requeued: number }> {
  if (!isOntologyPersonIdsEnabled()) return { requeued: 0 };
  const nowMs = deps.now ?? Date.now();
  const pending = await forTenant(ctx, deps.db).personMoves.find({ where: [["repoint", "==", "pending"]], limit: REPAIR_BATCH });
  let requeued = 0;
  for (const move of pending) {
    if (nowMs - Date.parse(move.createdAt) < REPAIR_AFTER_MS) continue;
    try {
      if ((await queueRepoint(ctx, move.productUserId, move.personId, deps.db)) === "enqueued") requeued += 1;
    } catch (err) {
      console.warn(`[ontology] re-queueing a person move failed tenant=${ctx.tenantId}:`, err instanceof Error ? err.message.slice(0, 120) : "error");
    }
  }
  if (requeued > 0) console.info(`[ontology] re-queued ${requeued} person moves tenant=${ctx.tenantId}`);
  return { requeued };
}
