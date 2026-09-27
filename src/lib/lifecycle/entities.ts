import type { ConnectionCatalog } from "@/lib/types/productConnection";
import type { ProductEntity, ProductUser } from "@/lib/types/productUser";
import type { JourneyAbout } from "@/lib/types/lifecycle";

/**
 * Which of a person's entities (API v2 `entities`: their workspaces, brands,
 * projects) an email is about. Pure — the runner, enrolment, the preview and
 * the admin share these rules.
 *
 * - The person counts as onboarded once any entity they own of the onboarding
 *   kind has every step of that kind done.
 * - `focus` follows their onboarding: a finished entity first (then the most
 *   recently active), else the one with the most steps done, then the most
 *   recent. It's re-read at every email, so it moves with them — and lands on
 *   the finished one, which ends an onboarding sequence.
 * - Every other rule picks once and the choice is kept (the runner pins it).
 * - Only entities they own count, unless the journey includes ones they joined.
 */

export type Catalog = Pick<ConnectionCatalog, "onboardingSteps"> & Partial<Pick<ConnectionCatalog, "facts" | "entityKinds">>;
export interface EntityRef {
  id: string;
  entity: ProductEntity;
}

/** The steps done per entity of `kind`; when the catalog marks none with a kind, every step. */
export function stepsFor(kind: string, catalog: Catalog): Catalog["onboardingSteps"] {
  const scoped = catalog.onboardingSteps.filter((s) => s.kind);
  return scoped.length > 0 ? catalog.onboardingSteps.filter((s) => s.kind === kind) : catalog.onboardingSteps;
}

/** The kind whose entities carry the onboarding steps, if the catalog says. */
export function onboardingKind(catalog: Catalog): string | null {
  return catalog.onboardingSteps.find((s) => s.kind)?.kind ?? null;
}

export function progressOf(e: ProductEntity, catalog: Catalog): { done: number; total: number; finished: boolean } {
  const steps = stepsFor(e.kind, catalog);
  const done = steps.filter((s) => e.steps[s.id]).length;
  return { done, total: steps.length, finished: steps.length > 0 && done === steps.length };
}

/** When the person last worked on it: what the product said, else its latest step, else when we first saw it. */
export function activityMs(e: ProductEntity): number {
  if (e.activeAt) return Date.parse(e.activeAt);
  const latest = Object.values(e.steps).reduce((m, s) => Math.max(m, Date.parse(s.doneAt) || 0), 0);
  return latest || Date.parse(e.firstSeenAt) || 0;
}

/** Their entities a journey counts: of its kind (any when it names none), owned unless it includes joined ones. */
export function entitiesFor(user: Pick<ProductUser, "entities">, about: Pick<JourneyAbout, "kind" | "includeJoined">): EntityRef[] {
  return Object.entries(user.entities ?? {})
    .filter(([, e]) => (!about.kind || e.kind === about.kind) && (about.includeJoined || e.role === "owner" || e.role === null))
    .map(([id, entity]) => ({ id, entity }));
}

function byRecent(a: EntityRef, b: EntityRef): number {
  return activityMs(b.entity) - activityMs(a.entity) || a.id.localeCompare(b.id);
}

/** The focus: a finished one (most recent), else the most steps done, then the most recent. */
export function focusOf(list: EntityRef[], catalog: Catalog): EntityRef | null {
  if (list.length === 0) return null;
  const ranked = [...list].sort((a, b) => {
    const pa = progressOf(a.entity, catalog);
    const pb = progressOf(b.entity, catalog);
    if (pa.finished !== pb.finished) return pa.finished ? -1 : 1;
    if (!pa.finished && pa.done !== pb.done) return pb.done - pa.done;
    return byRecent(a, b);
  });
  return ranked[0] ?? null;
}

/**
 * The entity an email is about, for a journey about ONE of them. `pinned` is the
 * enrolment's earlier choice (kept while it still exists, except for `focus`,
 * which is always re-read); `triggerId` is the entity the trigger happened to.
 */
export function pickEntity(
  user: Pick<ProductUser, "entities">,
  about: JourneyAbout,
  catalog: Catalog,
  opts: { pinned?: string | null; triggerId?: string | null } = {},
): EntityRef | null {
  const list = entitiesFor(user, about);
  if (list.length === 0) return null;
  const find = (id: string | null | undefined) => (id ? (list.find((x) => x.id === id) ?? null) : null);
  if (about.pick === "focus") return focusOf(list, catalog);
  const kept = find(opts.pinned);
  if (kept) return kept;
  switch (about.pick) {
    case "trigger":
      return find(opts.triggerId) ?? focusOf(list, catalog);
    case "recent":
      return [...list].sort(byRecent)[0] ?? null;
    case "fact_high":
    case "fact_low": {
      const fact = about.fact;
      const withValue = list.filter((x) => fact && typeof x.entity.facts[fact]?.value === "number");
      if (withValue.length === 0) return focusOf(list, catalog);
      const v = (x: EntityRef) => x.entity.facts[fact!]!.value as number;
      return [...withValue].sort((a, b) => (about.pick === "fact_high" ? v(b) - v(a) : v(a) - v(b)) || byRecent(a, b))[0] ?? null;
    }
  }
}

/** The person's values, less the ids the catalog keeps per entity of `kind`. */
function exceptKind<V>(values: Record<string, V>, items: Array<{ id: string; kind?: string | null }>, kind: string): Record<string, V> {
  const scoped = new Set(items.filter((x) => x.kind === kind).map((x) => x.id));
  return scoped.size ? Object.fromEntries(Object.entries(values).filter(([id]) => !scoped.has(id))) : values;
}

/**
 * The person as one entity sees them: their own steps and facts, with the
 * entity's on top. A step or fact the catalog keeps per entity of its kind comes
 * from the entity alone — a top-level copy (sent before entities were, or for
 * another of them) never makes this one look done.
 */
export function withEntity<U extends Pick<ProductUser, "steps" | "facts">>(user: U, e: ProductEntity, catalog: Catalog, opts: { facts: boolean }): U {
  return {
    ...user,
    steps: { ...exceptKind(user.steps, catalog.onboardingSteps, e.kind), ...e.steps },
    ...(opts.facts ? { facts: { ...exceptKind(user.facts ?? {}, catalog.facts ?? [], e.kind), ...e.facts } } : {}),
  };
}

/** The label for a kind: the catalog's singular, else the kind itself ("brand"). */
export function kindLabel(kind: string | null, catalog: Catalog, plural = false): string {
  const k = (catalog.entityKinds ?? []).find((x) => x.kind === kind);
  if (k) return plural ? k.plural : k.label;
  return kind ? (plural ? `${kind}s` : kind) : plural ? "items" : "item";
}

/** `entities.*` condition fields, over the entities a journey counts. Unknown (undefined) when there are none to read. */
export function entitiesField(key: string, list: EntityRef[], catalog: Catalog): string | number | boolean | undefined {
  if (key === "count") return list.length;
  if (key === "finished") return list.filter((x) => progressOf(x.entity, catalog).finished).length;
  if (key === "unfinished") return list.filter((x) => !progressOf(x.entity, catalog).finished).length;
  const m = /^(any|all|min|max)\.(step|fact)\.(.+)$/.exec(key);
  if (!m || list.length === 0) return undefined;
  const [, agg, family, id] = m as unknown as [string, "any" | "all" | "min" | "max", "step" | "fact", string];
  if (family === "step") {
    if (agg === "any") return list.some((x) => Boolean(x.entity.steps[id]));
    if (agg === "all") return list.every((x) => Boolean(x.entity.steps[id]));
    return undefined;
  }
  const values = list.map((x) => x.entity.facts[id]?.value).filter((v): v is number => typeof v === "number");
  if (values.length === 0) return undefined;
  if (agg === "min") return Math.min(...values);
  if (agg === "max") return Math.max(...values);
  return undefined;
}

/** One line per entity for a digest (`{{block.entities}}`), most recently active first. */
export function digestRows(
  list: EntityRef[],
  catalog: Catalog,
  maxListed: number,
): { rows: Array<{ name: string; done: number; total: number; facts: Array<{ label: string; value: string }> }>; more: number } {
  const facts = (catalog.facts ?? []).filter((f) => f.kind);
  const rows = [...list]
    .sort(byRecent)
    .slice(0, maxListed)
    .map(({ entity }) => {
      const p = progressOf(entity, catalog);
      return {
        name: entity.name ?? kindLabel(entity.kind, catalog),
        done: p.done,
        total: p.total,
        facts: facts
          .filter((f) => f.kind === entity.kind && entity.facts[f.id] !== undefined)
          .slice(0, 3)
          .map((f) => ({ label: f.label, value: `${entity.facts[f.id]!.value}${f.unit ?? ""}` })),
      };
    });
  return { rows, more: Math.max(0, list.length - rows.length) };
}

/**
 * When the person first counts as onboarded through an entity: the moment an
 * entity they own of the onboarding kind had every step of its kind done. Null
 * when the catalog's steps aren't per entity, or none is finished.
 */
export function entityActivationAt(user: Pick<ProductUser, "entities">, catalog: Catalog): string | null {
  const kind = onboardingKind(catalog);
  if (!kind) return null;
  const steps = stepsFor(kind, catalog);
  if (steps.length === 0) return null;
  let first: string | null = null;
  for (const { entity } of entitiesFor(user, { kind, includeJoined: false })) {
    if (!steps.every((s) => entity.steps[s.id])) continue;
    const at = steps.reduce((latest, s) => (entity.steps[s.id]!.doneAt > latest ? entity.steps[s.id]!.doneAt : latest), "");
    if (!first || at < first) first = at;
  }
  return first;
}

/** What one send knows about the person's entities. */
export interface EntityView {
  /** The entity this email is about (a journey about one, or each), or null. */
  entity: EntityRef | null;
  /** When it's about the person or all of them: the onboarding focus, which the checklist follows. */
  onboarding: EntityRef | null;
  /** The entities the journey counts: `entities.*` fields and the digest. */
  list: EntityRef[];
  /** How many a digest lists. */
  maxListed: number;
}

export function entityViewFor(
  user: Pick<ProductUser, "entities">,
  about: JourneyAbout,
  catalog: Catalog,
  opts: { pinned?: string | null; triggerId?: string | null } = {},
): EntityView {
  const list = entitiesFor(user, about);
  let entity: EntityRef | null = null;
  if (about.mode === "one") entity = pickEntity(user, about, catalog, opts);
  if (about.mode === "each") entity = list.find((x) => x.id === opts.pinned) ?? null;
  const kind = onboardingKind(catalog);
  const onboarding = entity || !kind ? null : focusOf(entitiesFor(user, { kind, includeJoined: about.includeJoined }), catalog);
  return { entity, onboarding, list, maxListed: about.maxListed };
}

/**
 * The person as this send sees them. About one entity: its steps and facts on
 * top of theirs. About the person (or all): the onboarding focus's steps, so the
 * checklist and `onboarding.*` follow what they're setting up; facts stay theirs.
 */
export function viewedUser<U extends Pick<ProductUser, "steps" | "facts">>(user: U, view: EntityView, catalog: Catalog): U {
  if (view.entity) return withEntity(user, view.entity.entity, catalog, { facts: true });
  if (view.onboarding) return withEntity(user, view.onboarding.entity, catalog, { facts: false });
  return user;
}

/** The entities a new enrolment is for: one per qualifying entity when the journey is about each; else the person (null). */
export function enrolTargets(
  user: Pick<ProductUser, "entities">,
  about: JourneyAbout,
  triggerId?: string | null,
): Array<string | null> {
  if (about.mode === "each") {
    const list = entitiesFor(user, about);
    if (triggerId) return list.some((x) => x.id === triggerId) ? [triggerId] : [];
    return list.map((x) => x.id);
  }
  if (about.mode === "one" && about.pick === "trigger" && triggerId) return [triggerId];
  return [null];
}
