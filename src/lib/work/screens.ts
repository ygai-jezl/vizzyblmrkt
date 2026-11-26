import { forTenant, peekWorkRefs, type TenantContext } from "@/lib/tenant";
import type { FirestoreLike } from "@/lib/tenant/types";
import type { MeaningKey } from "@/lib/metrics/meanings";
import { isIdeaWordsEnabled } from "@/lib/ideas/flags";
import { loopsSourceRepo } from "@/lib/loops/operators";
import { teamMemberNames } from "@/lib/team/names";
import type { Region } from "@/lib/types/tenant";
import { isWorkVizzyEnabled } from "./flags";
import { filtersOf, type WorkFilters } from "./inputs";
import { anyFilter, rowOf, type WorkRow } from "./list";
import { logDay, type LogDayView } from "./log";
import { meaningChoices, typedLinkWords } from "./form";
import { dayIn, partOf } from "./schedule";
import { countsProductEvent, eventLabelOf, eventLabelsFor } from "./counted";
import { brandChoices, checkLineOf, countShownChecks, listTasks, loadTasks, taskPage, type WorkTaskPage } from "./service";
import { brandForTask, brandIn, mapLimit, nowOf, workScopeFor, zoneForTask, type WorkBrand, type WorkDeps, type WorkScope } from "./scope";
import { partLine, SUGGESTED_FIELD_LABEL, WORK_COPY } from "./screenWords";
import { getAgentAction } from "@/lib/ontology/agentActions";
import { stageLabel } from "./stages";
import { suggestedMeasureText, suggestionOf } from "./suggestion";
import { onOpenList, SET_BY_MEASURE, type WorkStatus, type WorkTask } from "./types";
import { WORK_MESSAGES } from "./words";
import { suggestionForForm } from "./suggestions";
import type { SuggestedTask } from "./suggestion";
import type { AgentActionId } from "@/lib/types/agentAction";
import { DRAFT_COPY, logDraftLine, type DecisionDraft } from "./draft";
import { readDecisionDraft, readLogDraft } from "./drafts";
import type { EntryState, WorkLink } from "./types";

/**
 * What Work's four screens show (ADR-0020), read on the server and handed to the pages as plain
 * data: the list, one task, the add page and the Log. Who sees what, the filters, the order and
 * every rule come from the service (src/lib/work/service.ts); this adds what only a screen needs,
 * such as idea names, the connected products a measure can count, the open tasks a blocker can
 * name, and whether Vizzy's Work tools are on. Server only: it reads switches, settings and
 * Firestore. Nothing here is read from the request but the filters, a ref and a day.
 */

export type ScreenGate = { ok: true; scope: WorkScope } | { ok: false; message: string };

/** Who the person is in Work, or the words for why Work can't show anything. */
export async function screenScope(ctx: TenantContext, deps: WorkDeps = {}): Promise<ScreenGate> {
  const r = await workScopeFor(ctx, deps);
  if (r.ok) return r;
  return { ok: false, message: r.why === "no_organisation" ? WORK_MESSAGES.no_organisation : WORK_COPY.noBrand };
}

/** What every Work screen's header knows. */
export interface WorkChrome {
  /** The organisation's name, or the brand's when it is on its own. */
  name: string;
  view: WorkScope["view"];
  owner: boolean;
  oneBrand: boolean;
  /** The person sees more than one brand: the list has a Brand column and filter. */
  multiBrand: boolean;
  /** Not an admin of the brand and not an owner: reads the member note. */
  member: boolean;
  sessionBrand: { id: string; name: string };
  canImport: boolean;
  canDelete: boolean;
  /** Vizzy's Work tools are on (WORK_VIZZY_ENABLED): the screens may offer them. */
  workVizzy: boolean;
  /** Launches are called ideas (isIdeaWordsEnabled()). */
  ideaWords: boolean;
  me: string;
}

function chromeOf(scope: WorkScope): WorkChrome {
  return {
    name: scope.organisationName ?? scope.session.name,
    view: scope.view,
    owner: scope.owner,
    oneBrand: scope.oneBrand,
    multiBrand: scope.view === "organisation" && scope.brands.length > 1,
    member: !scope.owner && scope.ctx.role !== "admin",
    sessionBrand: { id: scope.session.id, name: scope.session.name },
    canImport: scope.canImport,
    canDelete: scope.canDelete,
    workVizzy: isWorkVizzyEnabled(),
    ideaWords: isIdeaWordsEnabled(),
    me: scope.userId,
  };
}

const regionDbOf = (deps: WorkDeps, region: Region): FirestoreLike | undefined => deps.regionDb?.(region);
const brandRepo = (b: WorkBrand, deps: WorkDeps) => forTenant({ tenantId: b.id, region: b.region, source: "system" }, regionDbOf(deps, b.region));

/** Idea names by "brandId:ideaId", read one by one in the brands the person sees (at most 60). */
async function ideaNames(scope: WorkScope, pairs: Iterable<[string, string]>, deps: WorkDeps): Promise<Record<string, string>> {
  const wanted = [...new Map([...pairs].map(([b, i]) => [`${b}:${i}`, [b, i] as const])).values()].slice(0, 60);
  const out: Record<string, string> = {};
  await mapLimit(wanted, 6, async ([brandId, ideaId]) => {
    const b = brandIn(scope, brandId);
    if (!b) return;
    try {
      const c = await brandRepo(b, deps).campaigns.getById(ideaId);
      if (c) out[`${brandId}:${ideaId}`] = c.waitlistName;
    } catch {
      // Unread: the row says "An idea" (or "A launch").
    }
  });
  return out;
}

const ideasOf = (t: WorkTask): Array<[string, string]> => [
  ...(t.ideaId && t.ideaBrandId ? [[t.ideaBrandId, t.ideaId] as [string, string]] : []),
  ...t.typedLinks.flatMap((l) => (l.kind === "idea" ? [[l.brandId, l.ideaId] as [string, string]] : [])),
];

// --- The list ----------------------------------------------------------------------------------

export interface ListScreen extends WorkChrome {
  filters: WorkFilters;
  brands: Array<{ id: string; name: string }>;
  rows: WorkRow[];
  counts: { open: number; mustHave: number; due: number };
  regionsDown: string[];
  unreadable: number;
  /** No task at all yet: the first visit. */
  empty: boolean;
}

/** The one list with the filters in the address. A brand filter the person can't use is dropped, so a stale link still opens. */
export async function listScreen(scope: WorkScope, params: URLSearchParams, deps: WorkDeps = {}): Promise<ListScreen> {
  let filters = filtersOf(params);
  if (filters.brand && filters.brand !== "none" && !brandIn(scope, filters.brand)) filters = { ...filters, brand: null };
  if (scope.view === "brand") filters = { ...filters, brand: null };
  let r = await listTasks(scope, filters, deps);
  if (!r.ok) {
    filters = { ...filters, brand: null };
    r = await listTasks(scope, filters, deps);
  }
  if (!r.ok) throw new Error(`[work] the list refused: ${r.error}`);
  const list = r.value;
  let empty = false;
  if (list.tasks.length === 0 && list.counts.open === 0 && !anyFilter(filters)) {
    const all = await listTasks(scope, { ...filters, status: "all" }, deps);
    empty = all.ok && all.value.tasks.length === 0 && all.value.regionsDown.length === 0;
  }
  const names = await ideaNames(scope, list.tasks.flatMap((v) => ideasOf(v.task)), deps);
  const now = nowOf(deps);
  return {
    ...chromeOf(scope),
    filters,
    brands: list.brands.map((b) => ({ id: b.id, name: b.name })),
    rows: list.tasks.map((v) => rowOf(v, { timeZone: zoneForTask(scope, v.task), now, ideaName: (b, i) => names[`${b}:${i}`], ideaWords: isIdeaWordsEnabled() })),
    counts: list.counts,
    regionsDown: list.regionsDown.map((d) => d.name),
    unreadable: list.unreadable,
    empty,
  };
}

// --- What a form can name ----------------------------------------------------------------------

export interface OpenTaskOption {
  ref: number;
  title: string;
  status: WorkStatus;
}

export interface ProductOption {
  id: string;
  name: string;
  /** The events its catalog names. Others can be typed. */
  events: Array<{ name: string; label: string }>;
}

export interface BrandOption {
  id: string;
  name: string;
  region: Region;
  timeZone: string;
  /** Today in the brand's zone, for the check's quick picks. */
  today: string;
  repos: Array<{ provider: "github" | "gitlab"; fullPath: string }>;
  products: ProductOption[];
  /** The brand's word for conversions, from its newest task that has one. */
  word: string | null;
}

/** What the add page and the task page offer: brands, ideas, products, repos, open tasks and meanings. */
export interface FormOptions {
  brands: BrandOption[];
  /** Whole business is a choice (owners, and a one brand organisation). */
  wholeBusiness: boolean;
  ideas: Array<{ value: string; label: string }>;
  openTasks: OpenTaskOption[];
  meanings: MeaningKey[];
  operator: boolean;
  /** This copy's own repo, for the loop line (operators only, else null). */
  loopsRepo: string | null;
}

async function productsOf(b: WorkBrand, deps: WorkDeps): Promise<ProductOption[]> {
  try {
    const rows = await brandRepo(b, deps).productConnections.find({ limit: 50 });
    return rows
      .filter((c) => c.status !== "revoked")
      .map((c) => ({ id: c.id, name: c.name, events: (c.catalog?.events ?? []).slice(0, 100).map((e) => ({ name: e.name, label: e.label || e.name })) }));
  } catch {
    return [];
  }
}

async function ideaChoicesOf(scope: WorkScope, brands: readonly WorkBrand[], deps: WorkDeps): Promise<FormOptions["ideas"]> {
  const per = await mapLimit(brands.slice(0, 5), 3, async (b) => {
    try {
      const rows = await brandRepo(b, deps).campaigns.find({ orderBy: [["createdAt", "desc"]], limit: 100 });
      return rows.filter((c) => !c.archivedAt).map((c) => ({ value: `${b.id}:${c.id}`, label: scope.brands.length > 1 ? `${c.waitlistName} (${b.name})` : c.waitlistName }));
    } catch {
      return [];
    }
  });
  return per.flat();
}

/** The brand's word for conversions on its newest task that keeps one. */
function wordsOf(tasks: readonly WorkTask[]): Map<string, string> {
  const out = new Map<string, string>();
  const newest = [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const t of newest) {
    const brand = t.brandId;
    if (!brand || out.has(brand) || !t.measure || t.measure.kind === "done") continue;
    const word = [t.measure, t.measure.then].find((p) => p && p.kind === "moves" && p.meaning === "conversions" && p.word);
    if (word && word.kind === "moves" && word.word) out.set(brand, word.word);
  }
  return out;
}

async function formOptions(scope: WorkScope, deps: WorkDeps, o: { self?: WorkTask; current?: MeaningKey | null } = {}): Promise<FormOptions> {
  const choices = brandChoices(scope);
  const now = nowOf(deps);
  const [loaded, ideas, products] = await Promise.all([
    loadTasks(scope, { brandId: scope.view === "brand" ? scope.session.id : undefined, allClosed: false }, deps),
    ideaChoicesOf(scope, choices.brands, deps),
    mapLimit(choices.brands.slice(0, 5), 3, (b) => productsOf(b, deps)),
  ]);
  const words = wordsOf(loaded.tasks);
  const openTasks = loaded.tasks
    .filter((t) => t.status !== "done" && t.status !== "dropped" && t.id !== o.self?.id)
    .sort((a, b) => a.ref - b.ref)
    .slice(0, 1000)
    .map((t) => ({ ref: t.ref, title: t.title, status: t.status }));
  const own = loopsSourceRepo();
  return {
    brands: choices.brands.map((b, i) => ({
      id: b.id,
      name: b.name,
      region: b.region,
      timeZone: b.timeZone,
      today: dayIn(now, b.timeZone),
      repos: b.repos,
      products: products[i] ?? [],
      word: words.get(b.id) ?? null,
    })),
    wholeBusiness: choices.wholeBusiness,
    ideas,
    openTasks,
    meanings: meaningChoices({ operator: scope.operator, current: o.current ?? null }),
    operator: scope.operator,
    loopsRepo: scope.operator ? own : null,
  };
}

// --- The add page ------------------------------------------------------------------------------

export interface AddScreen extends WorkChrome {
  nextRef: number;
  /** The brand a new task starts tagged with: the session brand. */
  defaultBrandId: string;
  options: FormOptions;
}

export async function addScreen(scope: WorkScope, deps: WorkDeps = {}): Promise<AddScreen> {
  const [nextRef, options] = await Promise.all([peekWorkRefs(scope.organisationId, deps.controlDb), formOptions(scope, deps)]);
  return { ...chromeOf(scope), nextRef, defaultBrandId: scope.session.id, options };
}

/** Edit then add (from Review): the add page filled with Vizzy's suggestion. */
export interface SuggestionScreen extends AddScreen {
  suggestion: {
    actionId: AgentActionId;
    rev: number;
    title: string;
    description: string;
    stage: SuggestedTask["stage"];
    brandId: string | null;
    typedLinks: SuggestedTask["typedLinks"];
    proposed: SuggestedTask["proposed"];
    measure: SuggestedTask["measure"];
    from: string;
  };
}

/**
 * The add page for Edit then add, or the words for why the suggestion can't be added (gone,
 * decided, or for a brand the person can't see). The task and the suggestion's result are written
 * in one transaction, so the brand picker offers only brands kept in the session brand's region,
 * and the whole business where the person may choose it.
 */
export async function suggestionScreen(scope: WorkScope, id: AgentActionId, deps: WorkDeps = {}): Promise<{ ok: true; screen: SuggestionScreen } | { ok: false; message: string }> {
  const r = await suggestionForForm(scope, id, deps);
  if (!r.ok) return { ok: false, message: r.message };
  const base = await addScreen(scope, deps);
  const s = r.value.suggestion;
  const brands = base.options.brands.filter((b) => b.region === scope.session.region);
  return {
    ok: true,
    screen: {
      ...base,
      defaultBrandId: s.brandId ?? scope.session.id,
      options: { ...base.options, brands },
      suggestion: { actionId: r.value.actionId, rev: r.value.rev, title: s.title, description: s.description, stage: s.stage, brandId: s.brandId, typedLinks: s.typedLinks, proposed: s.proposed, measure: s.measure, from: s.from },
    },
  };
}

// --- One task ----------------------------------------------------------------------------------

export interface TaskScreen extends WorkChrome {
  page: WorkTaskPage;
  /** Today in the task's zone. */
  today: string;
  /** Idea names by "brandId:ideaId". */
  ideaNames: Record<string, string>;
  options: FormOptions;
  /** The brands its Brand picker offers: the task never moves region, so only brands kept where it is. */
  brandChoices: Array<{ id: string; name: string }>;
  /** The brand a measure counts for, and its connected products. */
  measureBrand: { id: string; name: string; products: ProductOption[] } | null;
  /** Make it an idea: the New idea page, filled in, when the idea would be in the session brand. */
  makeIdeaHref: string | null;
  /** The part of the measure a due measure's check asks about, in words. */
  checkPartLine: string | null;
  /** The ref of the task an after_task check waits for, when the person sees it. */
  afterRef: number | null;
  /** On a task added from a Vizzy suggestion: where Vizzy wrote it from, and what it suggested for each field the person changed. */
  suggested: { from: string; edited: Array<{ label: string; was: string }> } | null;
  /** Opened from a decision Vizzy drafted in chat (`?decision=aa_…`): the draft to choose on, or why it can't be. */
  draftedDecision: DraftedDecision | { gone: string } | null;
}

/** A decision Vizzy drafted, as the task page offers it: the person chooses, and it saves. */
export interface DraftedDecision {
  id: AgentActionId;
  rev: number;
  question: string;
  options: DecisionDraft["options"];
  recommended: DecisionDraft["recommended"];
}

/**
 * What Vizzy suggested for a task added from its suggestion, read from the suggestion (kept in
 * the agent_actions of the brand it was added from, in the task's region), or null when it can't
 * be read. Only for someone who sees that brand: a suggestion made in another brand's chat stays
 * that brand's (decision 7), as does one from before the brand moved organisation.
 */
async function suggestedOf(scope: WorkScope, task: WorkTask, deps: WorkDeps): Promise<TaskScreen["suggested"]> {
  if (task.origin.kind !== "suggestion" || !brandIn(scope, task.addedFrom)) return null;
  try {
    const a = await getAgentAction({ tenantId: task.addedFrom, region: task.region, source: "system" }, task.origin.agentActionId, { db: deps.regionDb?.(task.region) });
    const s = a ? suggestionOf(a) : null;
    if (!a || !s || a.target.id !== task.id) return null;
    const raw = (a.result as { edited?: unknown } | null)?.edited;
    const edited = Array.isArray(raw) ? raw.filter((f): f is string => typeof f === "string" && Object.hasOwn(SUGGESTED_FIELD_LABEL, f)) : [];
    const was = (field: string): string => {
      if (field === "title") return s.title;
      if (field === "description") return s.description || WORK_COPY.noMeasure;
      if (field === "stage") return s.stage ? stageLabel(s.stage) : WORK_COPY.noStage;
      if (field === "brandId") return brandIn(scope, s.brandId)?.name ?? WORK_COPY.wholeBusinessLabel;
      if (field === "typedLinks") return s.typedLinks.length ? s.typedLinks.map((l) => typedLinkWords(l, { ideaWords: isIdeaWordsEnabled() }).label).join(", ") : WORK_COPY.noMeasure;
      return suggestedMeasureText(s) ?? WORK_COPY.noMeasure;
    };
    return { from: s.from, edited: edited.map((f) => ({ label: SUGGESTED_FIELD_LABEL[f]!, was: was(f) })) };
  } catch {
    return null;
  }
}

/** A drafted decision for this task, or the words for why it can't be chosen on. */
async function draftedDecisionOf(scope: WorkScope, task: WorkTask, id: string | null | undefined, deps: WorkDeps): Promise<TaskScreen["draftedDecision"]> {
  if (!id) return null;
  const r = await readDecisionDraft(scope, id, deps);
  if (!r.ok) return { gone: r.error === "draft_decided" ? DRAFT_COPY.decisionDraftGone : r.message };
  const d = r.value.draft;
  if (d.taskId !== task.id) return { gone: WORK_MESSAGES.draft_missing };
  return { id: r.value.actionId, rev: r.value.rev, question: d.question, options: d.options, recommended: d.recommended };
}

/** One task the person sees, with what its forms offer, or null (not found, never forbidden). */
export async function taskScreen(scope: WorkScope, ref: number, deps: WorkDeps = {}, opts: { decisionDraft?: string | null } = {}): Promise<TaskScreen | null> {
  const r = await taskPage(scope, ref, deps);
  if (!r.ok) return null;
  const page = r.value;
  const task = page.task;
  const current = [task.measure, task.measure && task.measure.kind !== "done" ? task.measure.then : null].find((p) => p && p.kind === "moves");
  const [names, options, suggested, draftedDecision] = await Promise.all([
    ideaNames(scope, ideasOf(task), deps),
    formOptions(scope, deps, { self: task, current: current && current.kind === "moves" ? current.meaning : null }),
    suggestedOf(scope, task, deps),
    draftedDecisionOf(scope, task, opts.decisionDraft, deps),
  ]);
  const brand = brandForTask(scope, task);
  const choices = brandChoices(scope);
  const sameRegion = choices.brands.filter((b) => b.region === task.region);
  const part = partOf(task.measure, task.check?.setBy === SET_BY_MEASURE ? (task.check.which ?? null) : null);
  const product = brand ? (options.brands.find((b) => b.id === brand.id)?.products ?? (await productsOf(brand, deps))) : [];
  const event = eventLabelOf(product);
  const canIdea = task.brandId === null || task.brandId === scope.session.id;
  return {
    ...chromeOf(scope),
    // The check's line names an event as the picker does.
    page: { ...page, checkLine: checkLineOf(scope, task, event) },
    today: dayIn(nowOf(deps), page.timeZone),
    ideaNames: names,
    options,
    brandChoices: sameRegion.map((b) => ({ id: b.id, name: b.name })),
    measureBrand: brand ? { id: brand.id, name: brand.name, products: product } : null,
    makeIdeaHref: canIdea && task.ideaId === null ? `/admin/launches/new?name=${encodeURIComponent(task.title)}&task=${task.ref}` : null,
    checkPartLine: part ? partLine(part, { connection: (id) => product.find((p) => p.id === id)?.name, event }) : null,
    afterRef: page.checkTask && "ref" in page.checkTask ? page.checkTask.ref : null,
    suggested,
    draftedDecision,
  };
}

// --- The Log -----------------------------------------------------------------------------------

/** A check due today, as the Log draws it. */
export interface LogCheck {
  ref: number;
  title: string;
  brandName: string | null;
  byMeasure: boolean;
  /** The measure it asks about and what Work counted, or the note on a person's check. */
  line: string;
}

export interface LogScreen extends WorkChrome {
  day: Omit<LogDayView, "checks">;
  /** Open tasks, for the Tasks tab's label. */
  openCount: number;
  checks: LogCheck[];
  names: Record<string, string>;
  brandNames: Record<string, string>;
  /** For the Log box: the open tasks an entry can name, and the brands it can be for. */
  openTasks: OpenTaskOption[];
  logBrands: Array<{ id: string; name: string }>;
  wholeBusiness: boolean;
  /** Opened from a note Vizzy drafted in chat (`?draft=aa_…`), today only: the Log box filled with it, or why it can't be. */
  draft: DraftedNote | { gone: string } | null;
}

/** A note Vizzy drafted, as the Log box takes it: the person can change it, then saves it. */
export interface DraftedNote {
  id: AgentActionId;
  rev: number;
  /** "Workstream: note", as the box reads a line. */
  line: string;
  state: EntryState;
  ref: number | null;
  brandId: string | null;
  links: WorkLink[];
}

async function draftedNoteOf(scope: WorkScope, id: string | null | undefined, today: boolean, deps: WorkDeps): Promise<LogScreen["draft"]> {
  if (!id || !today) return null;
  const r = await readLogDraft(scope, id, deps);
  if (!r.ok) return { gone: r.error === "draft_decided" ? DRAFT_COPY.logDraftGone : r.message };
  const d = r.value.draft;
  return { id: r.value.actionId, rev: r.value.rev, line: logDraftLine(d), state: d.state, ref: d.ref, brandId: d.brandId, links: d.links };
}

/** One day of the Log, today unless a day is given, or the words for why it can't be shown. */
export async function logScreen(scope: WorkScope, day: string | null, deps: WorkDeps = {}, opts: { draft?: string | null } = {}): Promise<{ ok: true; screen: LogScreen } | { ok: false; message: string }> {
  const r = await logDay(scope, day, deps);
  if (!r.ok) return { ok: false, message: r.message };
  const draft = await draftedNoteOf(scope, opts.draft, r.value.today, deps);
  const { checks: due, ...rest } = r.value;
  // A due measure's check is counted once, when it first shows, as on the task page.
  const counted = await countShownChecks(scope, due.map((v) => v.task), deps);
  const event = await eventLabelsFor(counted.flatMap((t) => (countsProductEvent(t) ? [brandForTask(scope, t)].filter((b): b is WorkBrand => !!b) : [])), deps);
  const checks: LogCheck[] = counted.map((t, i) => {
    const byMeasure = t.check?.setBy === SET_BY_MEASURE;
    const part = partOf(t.measure, byMeasure ? (t.check?.which ?? null) : null);
    const line = byMeasure && part ? `${partLine(part, { event })} ${checkLineOf(scope, t, event) ?? ""}`.trim() : t.check?.note || (t.check?.kind === "after_task" ? WORK_COPY.afterTaskDone : WORK_COPY.checkDueText);
    return { ref: t.ref, title: t.title, brandName: due[i]!.brandName, byMeasure, line };
  });
  const who = [
    ...rest.inFlight.map((f) => f.by.id),
    ...rest.entries.map((e) => e.source.who.id),
    ...rest.decisions.flatMap((d) => [d.source.who.id, d.decision.chosen?.by]),
    ...rest.moved.flatMap((m) => m.rows.map((row) => row.source.who.id)),
  ];
  const names: Record<string, string> = {};
  for (const b of scope.brands.slice(0, 5)) {
    Object.assign(names, await teamMemberNames({ tenantId: b.id, region: b.region, source: "system" }, who, { db: deps.controlDb, lookup: deps.lookup }));
  }
  const choices = brandChoices(scope);
  const loaded = await loadTasks(scope, { brandId: scope.view === "brand" ? scope.session.id : undefined, allClosed: false }, deps);
  return {
    ok: true,
    screen: {
      ...chromeOf(scope),
      day: rest,
      openCount: loaded.tasks.filter((t) => onOpenList(t, nowOf(deps))).length,
      checks,
      names,
      brandNames: Object.fromEntries(scope.brands.map((b) => [b.id, b.name])),
      openTasks: loaded.tasks
        .filter((t) => t.status !== "done" && t.status !== "dropped")
        .sort((a, b) => a.ref - b.ref)
        .map((t) => ({ ref: t.ref, title: t.title, status: t.status })),
      logBrands: choices.brands.map((b) => ({ id: b.id, name: b.name })),
      wholeBusiness: choices.wholeBusiness,
      draft,
    },
  };
}
