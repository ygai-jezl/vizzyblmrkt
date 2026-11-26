import { z } from "zod";
import { readFieldList } from "@/lib/audience/fieldList";
import { setFieldValues } from "@/lib/audience/fields";
import { fieldTag } from "@/lib/audience/fieldTags";
import { forTenant, getTenantById, isRateLimited, type RateLimitConfig, type SetFieldValuesError, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { CONTACT_PERSON_ID } from "@/lib/ontology/person";
import type { Tenant } from "@/lib/types/tenant";
import { OPTION_ID, optionLabel, type RecordField } from "@/lib/types/recordField";
import { dueReasons, dueTallies, quietDays, QUIET_AFTER_DAYS, todayFor, type DueReason } from "./due";
import { boardKind, raiseFieldsOf, type RaiseFields, type StageOption } from "./fields";
import { isRaiseFollowupsEnabled } from "./flags";
import { clearFollowUpsAfterWrite, openFollowUpPeople } from "./followups";
import type { FieldPresetKey, RaiseKit, StageRole } from "./presets";
import { BOARD_CAP, BOARD_WORDS, NOUNS } from "./words";

/**
 * The investor and funding board's data (RAISE_PIPELINE_ENABLED): People by Stage, read through
 * forTenant(ctx) with indexes firestore.indexes.json already has. For each Stage option one count
 * of its `field:<stage>:<option>` tag (tenantId, memberOf CONTAINS), then, for each option with
 * people, its most recently active people by (tenantId, memberOf CONTAINS, sortKey DESC), with a
 * projection of only their names, address, order and the board's six values. Archived options that
 * still hold people share one trailing column. Only someone in Everyone has field tags, as with the
 * People list's field filters.
 *
 * Moves change Stage (and Pass reason) through the one field writer, with the stage the card showed
 * as `expect`, so a move made from a stale board answers `stale` and writes nothing.
 */

export type ApiResult = { status: number; body: unknown };

export const BOARD_LIMITS = {
  board: { prefix: "raise_board", burstLimit: 20, hourlyLimit: 600 },
  move: { prefix: "raise_move", burstLimit: 30, hourlyLimit: 600 },
} as const satisfies Record<string, RateLimitConfig>;

export interface BoardCard {
  id: string;
  name: string | null;
  /** Only when there is no name, as the People list shows them. */
  email: string | null;
  firm: string | null;
  tier: string | null;
  nextStepDate: string | null;
  lastTouch: string | null;
  stageOptionId: string | null;
  passReason: { optionId: string; key: string | null; label: string } | null;
  due: DueReason[];
  quietDays: number | null;
  followUp: boolean;
}

export type ColumnRole = StageRole | "archived";

export interface BoardColumn {
  optionId: string;
  label: string;
  preset: string | null;
  role: ColumnRole;
  /** Everyone at this stage now. */
  count: number;
  /** More people than were read. */
  capped: boolean;
  cards: BoardCard[];
}

export interface PipelineRead {
  setUp: true;
  fields: RaiseFields;
  kind: RaiseKit;
  today: string;
  columns: BoardColumn[];
  totals: { people: number; quiet: number; nextStepPast: number; overdue: number; capped: boolean };
}

export interface BoardDeps {
  db?: FirestoreLike;
  loadTenant?: (id: string) => Promise<Tenant | null>;
  now?: () => Date;
  /** The people with an open follow-up (follow-ups on). */
  openFollowUps?: (ctx: TenantContext) => Promise<ReadonlySet<string>>;
}

/** The trailing column's id. */
export const ARCHIVED_COLUMN = "archived";

/** A field value's path for a projection: read only (src/lib/tenant/recordFieldWrites.ts is the one writer). */
const valuePath = (fieldId: string) => ["fields", fieldId].join(".");

const CARD_PRESETS = ["raise.stage", "raise.pass_reason", "raise.firm", "raise.tier", "raise.last_touch", "raise.next_step_date"] as const satisfies readonly FieldPresetKey[];

/** What a board read takes of each person: names, address, order, tags and the six values. */
export function boardPaths(rf: RaiseFields): string[] {
  const out = ["firstName", "lastName", "email", "sortKey", "memberOf"];
  for (const p of CARD_PRESETS) {
    const f = rf.byPreset[p];
    if (f) out.push(valuePath(f.key));
  }
  return out;
}

type PersonRow = { id: string; firstName?: unknown; lastName?: unknown; email?: unknown; sortKey?: unknown; fields?: Record<string, unknown> };

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const day = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

/** One person as a card. Pure. */
export function cardOf(p: PersonRow, rf: RaiseFields, today: string, followUps: ReadonlySet<string> = new Set()): BoardCard {
  const values = p.fields ?? {};
  const value = (preset: FieldPresetKey) => {
    const f = rf.byPreset[preset];
    return f ? values[f.key] : undefined;
  };
  const name = [text(p.firstName), text(p.lastName)].filter(Boolean).join(" ") || null;
  const stageId = text(value("raise.stage"));
  const role: StageRole = rf.stage?.options.find((o) => o.optionId === stageId)?.role ?? "active";
  const tierField = rf.byPreset["raise.tier"];
  const tierId = text(value("raise.tier"));
  const reasonId = text(value("raise.pass_reason"));
  const reason = reasonId ? rf.passReason?.options.find((o) => o.optionId === reasonId) : undefined;
  const lastTouch = day(value("raise.last_touch"));
  const nextStepDate = day(value("raise.next_step_date"));
  return {
    id: p.id,
    name,
    email: name ? null : text(p.email),
    firm: text(value("raise.firm")),
    tier: tierField && tierId ? optionLabel(tierField, tierId) : null,
    nextStepDate,
    lastTouch,
    stageOptionId: stageId,
    passReason: reason ? { optionId: reason.optionId, key: reason.key, label: reason.label } : null,
    due: dueReasons({ lastTouch, nextStepDate }, role, today),
    quietDays: quietDays(lastTouch, today),
    followUp: followUps.has(p.id),
  };
}

/** Soonest Next step date first, none last; ties keep the list's order (most recently active first). */
export function sortCards(cards: readonly BoardCard[]): BoardCard[] {
  return cards
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const x = a.c.nextStepDate;
      const y = b.c.nextStepDate;
      if (x !== y) {
        if (!x) return 1;
        if (!y) return -1;
        return x < y ? -1 : 1;
      }
      return a.i - b.i;
    })
    .map(({ c }) => c);
}

/**
 * Read the board: every Stage option's count, and cards for the options whose role is in `roles`
 * (all of them when not given), up to `cap` people each. Not set up: `{ setUp: false }`.
 */
export async function readPipeline(
  ctx: TenantContext,
  opts: { cap: number; roles?: ReadonlySet<ColumnRole>; items?: readonly RecordField[]; timeZone?: string | null },
  deps: BoardDeps = {},
): Promise<PipelineRead | { setUp: false }> {
  const items = opts.items ?? (await readFieldList(ctx, "person", deps.db)).items;
  const rf = raiseFieldsOf(items);
  if (!rf.setUp || !rf.stage) return { setUp: false };
  const stage = rf.stage;
  const timeZone = opts.timeZone !== undefined ? opts.timeZone : ((await (deps.loadTenant ?? getTenantById)(ctx.tenantId).catch(() => null))?.timeZone ?? null);
  const today = todayFor(timeZone, deps.now?.() ?? new Date());
  const contacts = forTenant(ctx, deps.db).contacts;
  const select = boardPaths(rf);
  const tagOf = (o: StageOption) => fieldTag(stage.field.key, o.optionId);
  const [counts, followUps] = await Promise.all([
    Promise.all(stage.options.map((o) => contacts.count([["memberOf", "array-contains", tagOf(o)]]))),
    deps.openFollowUps ? deps.openFollowUps(ctx).catch(() => new Set<string>()) : Promise.resolve(new Set<string>()),
  ]);
  const wants = (role: ColumnRole) => !opts.roles || opts.roles.has(role);
  const read = async (o: StageOption) =>
    (await contacts.find({ where: [["memberOf", "array-contains", tagOf(o)]], orderBy: [["sortKey", "desc"]], limit: opts.cap, select })) as unknown as PersonRow[];

  const columns: BoardColumn[] = [];
  const seen = new Set<string>();
  const cardsFrom = (rows: PersonRow[]) =>
    rows.flatMap((r) => {
      if (seen.has(r.id)) return [];
      seen.add(r.id);
      return [cardOf(r, rf, today, followUps)];
    });
  const live = stage.options.map((o, i) => ({ o, count: counts[i]! })).filter((x) => !x.o.archived);
  const liveRows = await Promise.all(live.map((x) => (x.count > 0 && wants(x.o.role) ? read(x.o) : Promise.resolve([] as PersonRow[]))));
  live.forEach((x, i) => {
    const cards = sortCards(cardsFrom(liveRows[i]!));
    columns.push({ optionId: x.o.optionId, label: x.o.label, preset: x.o.preset, role: x.o.role, count: x.count, capped: x.count > opts.cap, cards });
  });
  const archived = stage.options.map((o, i) => ({ o, count: counts[i]! })).filter((x) => x.o.archived && x.count > 0);
  if (archived.length) {
    const count = archived.reduce((n, x) => n + x.count, 0);
    const rows = wants(ARCHIVED_COLUMN) ? (await Promise.all(archived.map((x) => read(x.o)))).flat() : [];
    const cards = sortCards(cardsFrom(rows)).slice(0, opts.cap);
    columns.push({ optionId: ARCHIVED_COLUMN, label: BOARD_WORDS.archivedColumn, preset: null, role: ARCHIVED_COLUMN, count, capped: count > opts.cap || archived.some((x) => x.count > opts.cap), cards });
  }
  const tallies = dueTallies(columns.flatMap((c) => c.cards));
  return {
    setUp: true,
    fields: rf,
    kind: boardKind(rf.kinds),
    today,
    columns,
    totals: {
      people: columns.reduce((n, c) => n + c.count, 0),
      quiet: tallies.quiet,
      nextStepPast: tallies.nextStepPast,
      overdue: tallies.overdue,
      capped: columns.some((c) => c.capped),
    },
  };
}

// --- Requests ----------------------------------------------------------------------------------

/** The deps with the Follow up chips read from open follow-ups while they are on. */
function withFollowUps<D extends BoardDeps>(deps: D, on: boolean): D {
  return on && !deps.openFollowUps ? { ...deps, openFollowUps: (c: TenantContext) => openFollowUpPeople(c, deps.db) } : deps;
}

const memberKey = (ctx: TenantContext) => `user:${ctx.tenantId}:${ctx.userId ?? "anon"}`;
const LIMITED: ApiResult = { status: 429, body: { error: "rate_limited" } };
const labelled = (f: RecordField | undefined) => (f ? { id: f.key, label: f.label } : undefined);

/** GET the board. Anyone on the team; only admins move people. */
export async function boardRequest(ctx: TenantContext, deps: BoardDeps = {}): Promise<ApiResult> {
  if (await isRateLimited(memberKey(ctx), BOARD_LIMITS.board, { db: deps.db })) return LIMITED;
  const followUps = isRaiseFollowupsEnabled();
  const board = await readPipeline(ctx, { cap: BOARD_CAP }, withFollowUps(deps, followUps));
  if (!board.setUp) return { status: 200, body: { setUp: false } };
  const rf = board.fields;
  const by = rf.byPreset;
  return {
    status: 200,
    body: {
      setUp: true,
      kinds: rf.kinds,
      kind: board.kind,
      tab: NOUNS[board.kind].tab,
      noun: { one: NOUNS[board.kind].one, many: NOUNS[board.kind].many },
      today: board.today,
      quietAfterDays: QUIET_AFTER_DAYS,
      canMove: ctx.role === "admin",
      followUps,
      fields: {
        stage: labelled(by["raise.stage"]),
        passReason: labelled(by["raise.pass_reason"]),
        firm: labelled(by["raise.firm"]),
        tier: labelled(by["raise.tier"]),
        lastTouch: labelled(by["raise.last_touch"]),
        nextStepDate: labelled(by["raise.next_step_date"]),
      },
      reasonOptions: (rf.passReason?.options ?? []).filter((o) => !o.archived).map((o) => ({ optionId: o.optionId, label: o.label, key: o.key, area: o.area })),
      columns: board.columns,
      totals: { people: board.totals.people, quiet: board.totals.quiet, nextStepPast: board.totals.nextStepPast, capped: board.totals.capped },
    },
  };
}

const OptionIn = z.string().regex(OPTION_ID);
const MoveBody = z
  .object({
    personId: z.string().regex(CONTACT_PERSON_ID),
    to: OptionIn,
    from: OptionIn.nullable(),
    reason: OptionIn.nullable().optional(),
  })
  .strict();

const MOVE_STATUS: Partial<Record<SetFieldValuesError, [number, string]>> = {
  not_found: [404, "not_found"],
  stale: [409, "stale"],
};

/** The person's open follow-ups cleared after a move commits (follow-ups on); never throws. */
export type AfterMove = (ctx: TenantContext, personId: string, changed: readonly string[]) => Promise<unknown>;

/**
 * POST a card move: Stage set from `from` to `to` (a live option), with `expect` on `from`. Onto
 * Passed sets Pass reason to `reason`, or clears it for Leave it blank; leaving Passed clears it.
 * Admins only (the gate). Answers the card as it is now.
 */
export async function moveRequest(ctx: TenantContext, raw: unknown, deps: BoardDeps & { afterMove?: AfterMove } = {}): Promise<ApiResult> {
  const body = MoveBody.safeParse(raw);
  if (!body.success) return { status: 400, body: { error: "invalid_input" } };
  if (await isRateLimited(memberKey(ctx), BOARD_LIMITS.move, { db: deps.db })) return LIMITED;
  const { personId, to, from, reason } = body.data;
  const [list, person] = await Promise.all([readFieldList(ctx, "person", deps.db), forTenant(ctx, deps.db).contacts.getById(personId)]);
  // Another brand's person, or someone erased: nobody, never an error.
  if (!person) return { status: 404, body: { error: "not_found" } };
  const rf = raiseFieldsOf(list.items);
  if (!rf.stage) return { status: 400, body: { error: "not_set_up" } };
  const stageId = rf.stage.field.key;
  const target = rf.stage.options.find((o) => o.optionId === to && !o.archived);
  if (!target) return { status: 400, body: { error: "invalid_value" } };
  const was = from ? rf.stage.options.find((o) => o.optionId === from) : undefined;
  const changes: Record<string, unknown> = { [stageId]: to };
  if (rf.passReason) {
    const reasonId = rf.passReason.field.key;
    if (target.role === "passed") {
      if (reason && !rf.passReason.options.some((o) => o.optionId === reason && !o.archived)) return { status: 400, body: { error: "invalid_value" } };
      changes[reasonId] = reason ?? null;
    } else if (was?.role === "passed") changes[reasonId] = null;
  }
  const r = await setFieldValues(
    ctx,
    { object: "person", recordId: personId, changes, by: { type: "member", id: ctx.userId ?? null }, source: "editor", expect: { [stageId]: from } },
    { db: deps.db },
  );
  if (!r.ok) {
    const [status, error] = MOVE_STATUS[r.error] ?? [400, "invalid_value"];
    return { status, body: { error } };
  }
  // The person's open follow-ups clear at once: a new Stage sets them aside (follow-ups on; never throws).
  const by = { type: "member" as const, id: ctx.userId ?? null };
  const afterMove: AfterMove = deps.afterMove ?? ((c, id, changed) => clearFollowUpsAfterWrite(c, id, changed, by, { db: deps.db }));
  if (r.changed.length) await afterMove(ctx, personId, r.changed).catch(() => null);
  const timeZone = (await (deps.loadTenant ?? getTenantById)(ctx.tenantId).catch(() => null))?.timeZone ?? null;
  const chips = withFollowUps(deps, isRaiseFollowupsEnabled()).openFollowUps;
  const followUps = chips ? await chips(ctx).catch(() => new Set<string>()) : new Set<string>();
  const now = (await forTenant(ctx, deps.db).contacts.getById(personId)) as unknown as PersonRow | null;
  const card = cardOf(now ?? { id: personId, fields: r.values }, rf, todayFor(timeZone, deps.now?.() ?? new Date()), followUps);
  return { status: 200, body: { card } };
}
