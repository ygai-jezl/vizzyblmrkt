import { createHash } from "node:crypto";
import { forTenant, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { DataSignal, DataSignalKey, DataSignalRule, DataSignalShownIn, DataSignalWindow } from "@/lib/types/dataSignal";

/**
 * The signals store (Connectors 2 group 4, ADR-0012): the only code that writes `data_signals`,
 * through forTenant. One row per connection, generation, rule and key, under a fixed `dsg_` id, so
 * each detection overwrites its own row and the store stays bounded. Reads are by id, or by
 * equality on the connection (erase and Vizzy's list); no composite index.
 *
 * A row never holds a decision: its agent action does (`agentActionId`). Dismissing or planning
 * blanks it (the search's words or page path, the numbers and the window go) and sets
 * `dismissedUntil`, so the same suggestion doesn't come back before then; a row whose
 * `dismissedUntil` is still ahead is never refreshed.
 */

/** A row's numbers stand this long after detection (and the time to live with them). */
export const FRESH_DAYS = 30;
/** A dismissed or planned suggestion stays away this long. */
export const QUIET_DAYS = 30;
const DAY_MS = 86_400_000;
/** Rows read for one connection: far more than the caps let a brand have. */
const CONNECTION_ROWS = 500;

export interface SignalStoreDeps {
  db?: FirestoreLike;
  now?: Date;
}

const repoOf = (ctx: TenantContext, deps: SignalStoreDeps) => forTenant(ctx, deps.db).dataSignals;
const nowOf = (deps: SignalStoreDeps) => deps.now ?? new Date();
const plusDays = (at: Date, days: number) => new Date(at.getTime() + days * DAY_MS);

/** What a key is, as one line for the id: a search's topic key, or a page's host and path. */
function keyText(key: DataSignalKey): string {
  return key.topic !== undefined ? `topic\n${key.topic}` : `page\n${key.host ?? ""}\n${key.page ?? ""}`;
}

/** `dsg_` and 24 hex characters of a hash of the brand, connection, generation, rule and key. */
export function signalIdFor(tenantId: string, connectionId: string, gen: number, rule: DataSignalRule, key: DataSignalKey): string {
  const text = `${tenantId}\n${connectionId}\n${gen}\n${rule}\n${keyText(key)}`;
  return `dsg_${createHash("sha256").update(text).digest("hex").slice(0, 24)}`;
}

/** One row by id, or null (another brand's id reads as none). */
export async function getSignal(ctx: TenantContext, id: string, deps: SignalStoreDeps = {}): Promise<DataSignal | null> {
  return repoOf(ctx, deps).getById(id);
}

/** Whether a row is still kept away (dismissed or planned within 30 days). */
export function isQuiet(row: Pick<DataSignal, "dismissedUntil"> | null, now: Date): boolean {
  return Boolean(row?.dismissedUntil && Date.parse(row.dismissedUntil) > now.getTime());
}

export interface Detection {
  connectionId: string;
  gen: number;
  account: string;
  connectorId: string;
  rule: DataSignalRule;
  key: DataSignalKey;
  label: string;
  questionId?: string | null;
  question?: string | null;
  subjectId?: string | null;
  numbers: Record<string, number>;
  before?: Record<string, number> | null;
  atMost?: boolean;
  mayChange?: boolean;
  window: DataSignalWindow;
  shownIn: DataSignalShownIn;
}

/**
 * Write or refresh a detection's row: its numbers, its window and 30 more days. A row kept away
 * (dismissedUntil ahead) is left alone and answered as `quiet`. The agent action and round stay.
 */
export async function saveDetection(ctx: TenantContext, d: Detection, deps: SignalStoreDeps = {}): Promise<{ row: DataSignal; quiet: boolean }> {
  const now = nowOf(deps);
  const id = signalIdFor(ctx.tenantId, d.connectionId, d.gen, d.rule, d.key);
  const fresh = plusDays(now, FRESH_DAYS);
  const fields = {
    connectionId: d.connectionId,
    gen: d.gen,
    account: d.account,
    connectorId: d.connectorId,
    rule: d.rule,
    key: d.key,
    label: d.label,
    // A rising search's row keeps the question it proposed: only a rule about a question names one.
    ...(d.questionId !== undefined ? { questionId: d.questionId } : {}),
    question: d.question ?? null,
    subjectId: d.subjectId ?? null,
    numbers: d.numbers,
    before: d.before ?? null,
    atMost: d.atMost ?? false,
    mayChange: d.mayChange ?? false,
    window: d.window,
    shownIn: d.shownIn,
    detectedAt: now.toISOString(),
    freshUntil: fresh.toISOString(),
  };
  let quiet = false;
  const { doc } = await repoOf(ctx, deps).upsert(
    id,
    () => ({ questionId: null, ...fields, agentActionId: null, round: 0, dismissedUntil: null, ttlAt: fresh }) as Omit<DataSignal, "id" | "tenantId">,
    (cur) => {
      if (isQuiet(cur, now)) {
        quiet = true;
        return null;
      }
      return { ...fields, ttlAt: fresh };
    },
  );
  return { row: doc, quiet };
}

/** Name the agent action proposed for a row, with its round (and the question it proposed, if any). */
export async function linkAction(ctx: TenantContext, id: string, agentActionId: string, round: number, deps: SignalStoreDeps & { questionId?: string } = {}): Promise<void> {
  await repoOf(ctx, deps).claim(id, () => ({ agentActionId, round, ...(deps.questionId ? { questionId: deps.questionId } : {}) }));
}

/**
 * Blank a row: the words or path, the question, the numbers and the window go; its id, rule and
 * action stay. With `quietDays` (a dismissal or a plan), it is kept away that long, and its time to
 * live never ends before then. False when the brand has no such row.
 */
export async function blankSignal(ctx: TenantContext, id: string, opts: { quietDays?: number } & SignalStoreDeps = {}): Promise<boolean> {
  const now = nowOf(opts);
  const until = opts.quietDays ? plusDays(now, opts.quietDays) : null;
  const done = await repoOf(ctx, opts).claim(id, (cur) => ({
    key: null,
    label: null,
    question: null,
    numbers: null,
    before: null,
    window: null,
    ...(until ? { dismissedUntil: until.toISOString(), ttlAt: keptUntil(until, cur) } : {}),
  }));
  return done !== null;
}

/**
 * The time to live of a row kept away until `until`: the later of that and the row's own end, as
 * its ISO strings say (freshUntil, and an earlier dismissedUntil). The stored ttlAt is never read:
 * Firestore hands it back as a Timestamp, not a Date. A string that doesn't parse counts for
 * nothing, so the answer is always a valid date, `until` at the least.
 */
export function keptUntil(until: Date, row: Partial<Pick<DataSignal, "freshUntil" | "dismissedUntil">>): Date {
  const ends = [row.freshUntil, row.dismissedUntil].map((v) => (typeof v === "string" ? Date.parse(v) : Number.NaN)).filter(Number.isFinite);
  return new Date(Math.max(until.getTime(), ...ends));
}

/** A connection's rows (every generation), by equality on the connection. */
export async function signalsOfConnection(ctx: TenantContext, connectionId: string, deps: SignalStoreDeps = {}): Promise<DataSignal[]> {
  return repoOf(ctx, deps).find({ where: [["connectionId", "==", connectionId]], limit: CONNECTION_ROWS });
}

/**
 * Delete a connection's rows: every one ("all"), or those of the listed old generations. Equality
 * only. Returns how many.
 */
export async function eraseSignals(ctx: TenantContext, connectionId: string, gens: "all" | readonly number[], deps: SignalStoreDeps = {}): Promise<number> {
  const repo = repoOf(ctx, deps);
  if (gens === "all") return repo.deleteWhere([["connectionId", "==", connectionId]], { pageSize: 100 });
  let n = 0;
  for (const g of [...new Set(gens)]) {
    n += await repo.deleteWhere(
      [
        ["connectionId", "==", connectionId],
        ["gen", "==", g],
      ],
      { pageSize: 100 },
    );
  }
  return n;
}

/** How many rows a connection has (the purge's dry run). */
export async function countSignals(ctx: TenantContext, connectionId: string, deps: SignalStoreDeps = {}): Promise<number> {
  return repoOf(ctx, deps).count([["connectionId", "==", connectionId]]);
}
