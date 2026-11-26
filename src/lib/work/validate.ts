import { findWorkTaskByRef, forTenant } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import { typeById } from "@/lib/ontology/registry";
import { isLoopsSourceRepo } from "@/lib/loops/operators";
import { EVENT_TTL_MS } from "@/lib/connect/ingest";
import type { Region } from "@/lib/types/tenant";
import { proposedByRule } from "./measureKind";
import { invalidInput, refuse, type WorkRefused } from "./result";
import { brandIn, seesTask, type WorkBrand, type WorkDeps, type WorkScope } from "./scope";
import { MeasureSchema, startingDirection, type Measure, type TypedLink, type WorkTask } from "./types";
import type { MeasureInput, ThenInput } from "./inputs";
import type { CompanyStage } from "./stages";

/**
 * What Work checks before it keeps a task's brand, typed links, measure, blockers and check
 * (ADR-0018). Everything that names something else is read live: a repo the brand selected, an
 * idea that exists, a connected product that isn't disconnected, a type YouGrow keeps, a task the
 * person can see. Operators (LOOPS_OPERATOR_EMAILS) alone may name this copy's own loop.
 */

/** The longest a product event measure may look: events are kept for 90 days. */
export const PRODUCT_EVENT_MAX_DAYS = Math.floor(EVENT_TTL_MS / 86_400_000);

const regionDbOf = (deps: WorkDeps, region: Region): FirestoreLike | undefined => deps.regionDb?.(region);
const brandRepo = (b: WorkBrand, deps: WorkDeps) => forTenant({ tenantId: b.id, region: b.region, source: "system" }, regionDbOf(deps, b.region));

// --- Where a task lives ------------------------------------------------------------------------

export interface TaskPlace {
  brandId: string | null;
  region: Region;
}

/**
 * The brand a task is tagged with and the region it is kept in, for a new task:
 * - left out: the session brand in the brand view or a one brand organisation, else the whole business;
 * - null (the whole business): owners and one brand organisations only, kept in the session brand's region;
 * - a brand: the session brand in the brand view, else any brand of the organisation, in its own region.
 */
export function placeForNew(scope: WorkScope, brandId: string | null | undefined): TaskPlace | WorkRefused {
  if (brandId === undefined) {
    return scope.view === "brand" || scope.oneBrand ? { brandId: scope.session.id, region: scope.session.region } : { brandId: null, region: scope.session.region };
  }
  if (brandId === null) return scope.view === "brand" ? refuse("whole_business_owners") : { brandId: null, region: scope.session.region };
  if (scope.view === "brand" && brandId !== scope.session.id) return refuse("brand_not_yours");
  const b = brandIn(scope, brandId);
  return b ? { brandId: b.id, region: b.region } : refuse("brand_unknown");
}

/**
 * A change of brand on an existing task: the same rules as a new task, and the task never moves
 * database (ADR-0002 runs no transaction across two), so a brand in another region is refused.
 */
export function placeForChange(scope: WorkScope, task: Pick<WorkTask, "region">, brandId: string | null): TaskPlace | WorkRefused {
  const place = placeForNew(scope, brandId);
  if ("ok" in place) return place;
  if (brandId !== null && place.region !== task.region) return refuse("other_region");
  return { brandId: place.brandId, region: task.region };
}

// --- Typed links -------------------------------------------------------------------------------

/** One typed link's identity, so a list keeps each once and an old link isn't checked again. */
export function typedLinkKey(l: TypedLink): string {
  switch (l.kind) {
    case "pull_request":
      return `pr:${l.provider}:${l.repo.toLowerCase()}#${l.number}`;
    case "switch":
      return `switch:${l.name ?? `none:${l.none}`}`;
    case "idea":
      return `idea:${l.brandId}:${l.ideaId}`;
    case "loop_line":
      return `loop:${l.loopKind ?? `none:${l.none}`}`;
    case "plan":
      return `plan:${l.url}@${l.version ?? ""}`;
  }
}

/** The repos a task may link a pull request from: its brand's, or for a whole business task any brand's of the organisation. */
export function reposFor(scope: WorkScope, brand: WorkBrand | undefined): WorkBrand["repos"] {
  if (brand) return brand.repos;
  return scope.brands.flatMap((b) => b.repos);
}

/** An idea (a launch, ADR-0016) in a brand the person sees, read live. */
export async function ideaExists(scope: WorkScope, brandId: string, ideaId: string, deps: WorkDeps): Promise<boolean> {
  const b = brandIn(scope, brandId);
  if (!b) return false;
  try {
    return (await brandRepo(b, deps).campaigns.getById(ideaId)) !== null;
  } catch {
    return false;
  }
}

/**
 * The typed links to keep, each once, or why not. Links already on the task are kept as they are;
 * new ones are checked:
 * - a pull request: from a repo the task's brand selected (any brand's for a whole business task),
 *   kept with the repo's own spelling;
 * - a pull request or a switch: only with a connected repo;
 * - an idea: one that exists, in a brand the person sees;
 * - a loop line: operators only, and only beside a pull request from LOOPS_SOURCE_REPO.
 */
export async function checkTypedLinks(
  scope: WorkScope,
  next: readonly TypedLink[],
  ctx: { brand: WorkBrand | undefined; current: readonly TypedLink[] },
  deps: WorkDeps,
): Promise<{ ok: true; links: TypedLink[] } | WorkRefused> {
  const kept = new Set(ctx.current.map(typedLinkKey));
  const repos = reposFor(scope, ctx.brand);
  const out: TypedLink[] = [];
  const seen = new Set<string>();
  let newLoopLine = false;
  for (const raw of next) {
    const key = typedLinkKey(raw);
    if (seen.has(key)) continue;
    seen.add(key);
    if (kept.has(key)) {
      out.push(ctx.current.find((l) => typedLinkKey(l) === key)!);
      continue;
    }
    let link = raw;
    if (raw.kind === "pull_request" || raw.kind === "switch") {
      if (!repos.length) return refuse("no_repo");
    }
    if (raw.kind === "pull_request") {
      const repo = repos.find((r) => r.provider === raw.provider && r.fullPath.toLowerCase() === raw.repo.toLowerCase());
      if (!repo) return refuse("repo_not_selected");
      link = { ...raw, repo: repo.fullPath };
    }
    if (raw.kind === "idea" && !(await ideaExists(scope, raw.brandId, raw.ideaId, deps))) return refuse("idea_missing");
    if (raw.kind === "loop_line") {
      if (!scope.operator) return refuse("loop_line_operators");
      newLoopLine = true;
    }
    out.push(link);
  }
  if (newLoopLine && !out.some((l) => l.kind === "pull_request" && isLoopsSourceRepo(l.repo))) return refuse("loop_line_repo");
  return { ok: true, links: out };
}

// --- How we'll know it worked ------------------------------------------------------------------

/** What the rule reads to propose a kind (src/lib/work/measureKind.ts). */
export interface MeasureContext {
  title: string;
  description: string;
  stage: CompanyStage | null;
  brandId: string | null;
  ideaId: string | null;
  typedLinks: readonly TypedLink[];
  /** The brand the task counts as, for a product event. */
  brand: WorkBrand | undefined;
  current: Measure | null;
}

/** JSON with sorted keys at every level, leaving out undefined and treating a missing then as null. */
export function stableJson(v: unknown): string {
  if (v === undefined || v === null) return "null";
  if (typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined && o[k] !== null)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(",")}}`;
}

/** A measure's own content, without who set it, when, or what was proposed. */
function contentOf(m: Measure | null): string {
  if (!m) return "null";
  const rest: Record<string, unknown> = { ...m };
  delete rest.setBy;
  delete rest.setAt;
  delete rest.proposed;
  return stableJson(rest);
}

async function checkPart(scope: WorkScope, part: ThenInput | Exclude<MeasureInput, { kind: "done" }>, brand: WorkBrand | undefined, deps: WorkDeps): Promise<WorkRefused | null> {
  if (part.kind !== "used") return null;
  const c = part.counts;
  if ("purpose" in c || "type" in c || "loopKind" in c) {
    if (!scope.operator) return refuse("measure_operators");
    if ("type" in c && typeById(c.type)?.status !== "built") return refuse("type_not_built");
    return null;
  }
  if ("productEvent" in c) {
    if (!brand) return refuse("product_whole_business");
    if (!("days" in part.look) || part.look.days > PRODUCT_EVENT_MAX_DAYS) return refuse("product_look");
    try {
      const conn = await brandRepo(brand, deps).productConnections.getById(c.productEvent.connectionId);
      if (!conn || conn.status === "revoked") return refuse("product_missing");
    } catch {
      return refuse("product_missing");
    }
  }
  return null;
}

/** A then or a first measure's fields as kept: a Moves a number direction starts from the meaning's better. */
function partOfInput(p: ThenInput | Exclude<MeasureInput, { kind: "done" }>): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...p };
  delete rest.then;
  if (p.kind === "moves") rest.direction = p.direction ?? startingDirection(p.meaning);
  return rest;
}

/**
 * The measure to keep, or why not. The server sets who set it, when, and the kind the rule
 * proposes (never the request); a measure the same as the one kept is kept as it was, so setting
 * it again changes nothing.
 * - Done is the win has no look and no then; a then is never Done is the win, and looks later
 *   when both look by days (the shape, src/lib/work/types.ts).
 * - Used counts exactly one thing; a purpose, a type or a LOOPS kind for operators only, a type
 *   only when YouGrow keeps it; a product event only for one brand's connected product, over 90
 *   days at most.
 * - Moves a number never names a provider's number or a date, and takes the brand's word only for
 *   conversions.
 */
export async function checkMeasure(scope: WorkScope, input: MeasureInput | null, ctx: MeasureContext, deps: WorkDeps, now: Date): Promise<{ ok: true; measure: Measure | null } | WorkRefused> {
  if (input === null) return { ok: true, measure: null };
  if (input.kind !== "done") {
    for (const part of [input, ...(input.then ? [input.then] : [])]) {
      const problem = await checkPart(scope, part, ctx.brand, deps);
      if (problem) return problem;
    }
  }
  const proposed = proposedByRule({ title: ctx.title, description: ctx.description, stage: ctx.stage, brandId: ctx.brandId, ideaId: ctx.ideaId, typedLinks: ctx.typedLinks, oneBrand: scope.oneBrand });
  const fields = input.kind === "done" ? { kind: "done" as const } : { ...partOfInput(input), then: input.then ? partOfInput(input.then) : null };
  const parsed = MeasureSchema.safeParse({ ...fields, setBy: scope.userId, setAt: now.toISOString(), proposed });
  if (!parsed.success) return invalidInput(parsed.error.issues.map((i) => ({ path: ["measure", ...i.path], message: i.message })));
  if (ctx.current && contentOf(ctx.current) === contentOf(parsed.data)) return { ok: true, measure: ctx.current };
  return { ok: true, measure: parsed.data };
}

// --- Other tasks -------------------------------------------------------------------------------

/** The tasks these refs name, each one the person sees; `refusal` says why not (one missing, or the task itself). */
export async function tasksByRef(
  scope: WorkScope,
  refs: readonly number[],
  self: string | null,
  deps: WorkDeps,
  refusal: "blocker_missing" | "check_task_missing" = "blocker_missing",
): Promise<{ ok: true; tasks: WorkTask[] } | WorkRefused> {
  const out: WorkTask[] = [];
  for (const ref of [...new Set(refs)]) {
    const { task } = await findWorkTaskByRef(scope.organisationId, ref, deps);
    if (task && task.id === self) return refuse("blocker_self");
    if (!task || !seesTask(scope, task)) return refuse(refusal);
    out.push(task);
  }
  return { ok: true, tasks: out };
}
