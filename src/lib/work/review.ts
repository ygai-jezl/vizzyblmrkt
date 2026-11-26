import { forTenant } from "@/lib/tenant";
import type { TenantContext } from "@/lib/tenant/types";
import { agentActionReviewItem, listOpenAgentActions } from "@/lib/ontology/agentActions";
import type { ReviewItem } from "@/lib/review/summary";
import type { AgentAction } from "@/lib/types/agentAction";
import { measureCheckDetail, readyDetail, WORK_REVIEW_COPY } from "./reviewCards";
import { partOf } from "./schedule";
import { brandForTask, brandIn, mapLimit, nowOf, workScopeFor, zoneForTask, type WorkBrand, type WorkDeps, type WorkScope } from "./scope";
import { countsProductEvent, eventLabelsFor, type EventLabel } from "./counted";
import { partLine, WORK_COPY } from "./screenWords";
import { checkLineOf, countDueCheck, dueChecks, readyTasks, type WorkTaskView } from "./service";
import { stageLabel } from "./stages";
import { editThenAddHref, fromWords, ideaKeysOf, seesSuggestion, stageTag, suggestedMeasureText, suggestionOf, suggestsKindOnly, WORK_SUGGEST_ACTION, type SuggestedTask } from "./suggestion";
import { SET_BY_MEASURE, type WorkTask } from "./types";
import { dayOf } from "./words";

/**
 * Work in Review (ADR-0020, plan group 4): Checks due today (work_check_due), Ready to start
 * (work_ready) and Tasks Vizzy suggests (vizzy_chat), each section's `from` in
 * src/lib/review/summary.ts. Who sees which follows Work's view (decision 7): owners and a one
 * brand organisation's team see the whole organisation's, everyone else their own brand's. Members
 * see all three and act on them; nothing here is for admins only.
 *
 * The builders are pure; workReviewItems reads. Every read is soft: a region or a source that
 * doesn't answer leaves its rows out and never fails Review. A due measure's check is counted once,
 * when it first shows, as on the task page (not on the sidebar's count).
 */

/** The most rows each Work section shows. */
export const MAX_WORK_ITEMS = 10;
/** The most due measure checks one read counts. */
const COUNT_ON_READ = 10;

async function soft<T>(label: string, p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (err) {
    console.warn(`[review] work ${label} failed:`, err instanceof Error ? err.message.slice(0, 200) : "unknown");
    return fallback;
  }
}

const brandWords = (multiBrand: boolean, brandName: string | null): string | null => (multiBrand ? (brandName ?? WORK_REVIEW_COPY.wholeBusiness) : null);

/** A due check: a measure's asks did it work, with what Work counted; a date or task check says why it is due. */
export function workCheckItem(o: { task: WorkTask; brandName: string | null; multiBrand: boolean; line: string | null; event?: EventLabel }): ReviewItem | null {
  const t = o.task;
  const c = t.check;
  if (!c) return null;
  const part = c.setBy === SET_BY_MEASURE ? partOf(t.measure, c.which ?? null) : null;
  const why = part ? measureCheckDetail(`${partLine(part, { event: o.event })} ${o.line ?? ""}`) : c.note || (c.kind === "after_task" ? WORK_COPY.afterTaskDone : WORK_COPY.checkDueText);
  const detail = [brandWords(o.multiBrand, o.brandName), why].filter(Boolean).join(" · ");
  return {
    id: `work_check:${t.id}`,
    kind: "work_check",
    title: `#${t.ref} ${t.title}`,
    detail,
    details: [detail],
    href: `/admin/work/${t.ref}`,
    action: WORK_REVIEW_COPY.open,
    work: { kind: "check", ref: t.ref, measure: part !== null },
  };
}

/** When a task last became To do: its newest status change to To do, else when it was added. */
function todoSince(t: WorkTask): string {
  return t.recent.find((r) => r.field === "status" && r.after === "todo")?.at ?? t.createdAt;
}

/** A To do task with nothing in its way: Start it, or open it. */
export function workReadyItem(o: { task: WorkTask; brandName: string | null; multiBrand: boolean; timeZone: string }): ReviewItem {
  const t = o.task;
  const detail = readyDetail({ stage: t.stage ? stageLabel(t.stage) : null, brand: brandWords(o.multiBrand, o.brandName), since: dayOf(todoSince(t), o.timeZone) });
  return {
    id: `work_ready:${t.id}`,
    kind: "work_ready",
    title: `#${t.ref} ${t.title}`,
    detail,
    href: `/admin/work/${t.ref}`,
    action: WORK_REVIEW_COPY.open,
    work: { kind: "ready", ref: t.ref, title: t.title },
  };
}

/** An open suggestion from Vizzy as its card: the task, where it came from, why, and how we'll know it worked. */
export function workSuggestionItem(a: AgentAction, s: SuggestedTask, o: { multiBrand: boolean; brandName: string | null; ideaNames: ReadonlyMap<string, string> }): ReviewItem | null {
  const from = fromWords(s.from);
  const base = agentActionReviewItem(a, { title: s.title, detail: [from, s.why].filter(Boolean).join(" · "), action: WORK_REVIEW_COPY.editThenAdd });
  if (!base) return null;
  const text = suggestedMeasureText(s);
  return {
    ...base,
    kind: "work_suggestion",
    href: editThenAddHref(a.id),
    work: {
      kind: "suggestion",
      actionId: a.id,
      rev: a.rev,
      title: s.title,
      stage: stageTag(s.stage),
      brand: brandWords(o.multiBrand, o.brandName),
      ideas: ideaKeysOf(s.typedLinks)
        .map((k) => o.ideaNames.get(k))
        .filter((n): n is string => !!n),
      from,
      why: s.why,
      measure: text ? { text, why: s.proposed?.reason ?? null, ...(suggestsKindOnly(s) ? { kindOnly: true } : {}) } : null,
      editHref: editThenAddHref(a.id),
    },
  };
}

/** The names of the ideas the suggestions name, read once each, in the brands the person sees. */
async function ideaNamesOf(scope: WorkScope, suggestions: readonly SuggestedTask[], deps: WorkDeps): Promise<Map<string, string>> {
  const keys = [...new Set(suggestions.flatMap((s) => ideaKeysOf(s.typedLinks)))].slice(0, 20);
  const out = new Map<string, string>();
  await mapLimit(keys, 4, async (key) => {
    const [brandId, ideaId] = key.split(":") as [string, string];
    const b = brandIn(scope, brandId);
    if (!b || !ideaId) return;
    try {
      const c = await forTenant({ tenantId: b.id, region: b.region, source: "system" }, deps.regionDb?.(b.region)).campaigns.getById(ideaId);
      if (c && !c.archivedAt) out.set(key, c.waitlistName);
    } catch {
      // Unread: the card leaves the idea out.
    }
  });
  return out;
}

/**
 * Work's Review rows for this person: due checks, ready tasks (each at most 10) and open
 * suggestions they see. `count: false` (the sidebar's count) leaves due measure checks uncounted.
 */
export async function workReviewItems(ctx: TenantContext, deps: WorkDeps & { count?: boolean } = {}): Promise<ReviewItem[]> {
  const r = await soft("scope", workScopeFor(ctx, deps), null);
  if (!r || !r.ok) return [];
  const scope = r.scope;
  const multiBrand = scope.brands.length > 1;
  const [checks, ready, open] = await Promise.all([
    soft("checks", dueChecks(scope, deps), { tasks: [] as WorkTaskView[], regionsDown: [] }),
    soft("ready", readyTasks(scope, deps), { tasks: [] as WorkTaskView[], regionsDown: [] }),
    soft("suggestions", listOpenAgentActions(ctx, { action: WORK_SUGGEST_ACTION, limit: 50, now: nowOf(deps).toISOString(), db: deps.regionDb?.(ctx.region) }), [] as AgentAction[]),
  ]);

  let counted = 0;
  const dueViews = checks.tasks.slice(0, MAX_WORK_ITEMS);
  const dueTasks = await mapLimit(dueViews, 4, async (v) => {
    const c = v.task.check;
    if (deps.count === false || c?.setBy !== SET_BY_MEASURE || c.counted || counted >= COUNT_ON_READ) return v.task;
    counted += 1;
    return soft("count", countDueCheck(scope, v.task, deps), v.task);
  });
  const eventBrands = dueTasks.flatMap((t) => (countsProductEvent(t) ? [brandForTask(scope, t)].filter((b): b is WorkBrand => !!b) : []));
  const event = eventBrands.length ? await soft("labels", eventLabelsFor(eventBrands, deps), (() => undefined) as EventLabel) : undefined;
  const checkItems = dueTasks.map((t, i) => workCheckItem({ task: t, brandName: dueViews[i]!.brandName, multiBrand, line: checkLineOf(scope, t, event), event }));
  const readyItems = ready.tasks.slice(0, MAX_WORK_ITEMS).map((v) => workReadyItem({ task: v.task, brandName: v.brandName, multiBrand, timeZone: zoneForTask(scope, v.task) }));

  const mine = open.map((a) => ({ a, s: suggestionOf(a) })).filter((x): x is { a: AgentAction; s: SuggestedTask } => x.s !== null && seesSuggestion(scope, x.s));
  const ideaNames = mine.some((x) => ideaKeysOf(x.s.typedLinks).length) ? await ideaNamesOf(scope, mine.map((x) => x.s), deps) : new Map<string, string>();
  const suggestionItems = mine.map((x) => workSuggestionItem(x.a, x.s, { multiBrand, brandName: brandIn(scope, x.s.brandId)?.name ?? null, ideaNames }));

  return [...checkItems, ...readyItems, ...suggestionItems].filter((i): i is ReviewItem => i !== null);
}
