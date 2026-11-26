import { MEANINGS, type MeaningKey } from "@/lib/metrics/meanings";
import { localDateKey } from "@/lib/lifecycle/sendWindow";
import { dayWords } from "@/lib/connectors/period";
import { PURPOSE_LABELS, RESOURCES, type ResourceId, type ResourcePurpose } from "@/lib/plans/resources";
import type { Counted, Measure, ThenMeasure, WorkStatus } from "./types";

/**
 * The words Work says to people (ADR-0018): what a status, a plan link's approval and a check
 * read as, the refusals the routes answer with, and the line on a measure's check about what Work
 * counted or can't count. Fixed sentences are literals here, so the help page can quote them and
 * src/lib/help/help.test.ts finds them in src/. House style: src/lib/content/writingRules.ts.
 *
 * Pure: plain data and pure helpers, so screens can use it in the browser.
 */

export const WORK_STATUS_LABEL: Record<WorkStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  waiting: "Waiting",
  done: "Done",
  dropped: "Dropped",
};

/** A plan link's approval, from its newest decision for the same url and version. */
export type PlanState = "approved" | "change_it" | "not_now" | "not_approved_yet";
export const PLAN_STATE_LABEL: Record<PlanState, string> = {
  approved: "Approved",
  change_it: "Change it",
  not_now: "Not now",
  not_approved_yet: "Not approved yet",
};

/** What each refusal says: what happened, and what to do next. */
export const WORK_MESSAGES = {
  invalid_input: "Something in that isn't one Work can keep. Check the fields and try again.",
  no_organisation:
    "This brand's organisation doesn't list it back, so Work can't tell whose tasks to show. Ask whoever runs this copy of YouGrow to run the organisation check.",
  not_found: "There's no task with that number that you can see.",
  forbidden_delete: "Only an admin or an owner can delete a task.",
  forbidden_import: "Only an admin or an owner can import tasks.",
  whole_business_owners: "Tasks for the whole business are for owners. Tag your brand instead.",
  brand_not_yours: "You can tag a task only with your own brand.",
  brand_unknown: "That brand isn't one of this organisation's brands.",
  other_region: "That brand keeps its data in another region, so this task can't move to it. Add a new task for that brand instead.",
  changed: "This task changed while you were editing it. Refresh to see the latest, then try again.",
  tasks_full: "This organisation has 5,000 tasks, the most Work keeps. Delete some done or dropped tasks first.",
  entries_full: "The team has logged 500 entries today, the most Work takes in a day. Log the rest tomorrow.",
  decisions_full: "This task has 50 decisions, the most Work keeps on one task.",
  no_repo: "Pull request and switch links need a connected repo. Connect one in Settings, under Integrations, first.",
  repo_not_selected: "That repo isn't one this brand has selected. Select it in Settings, under Integrations, or link another.",
  loop_line_operators: "Loop lines are only for the people who run this copy's own learning loop.",
  loop_line_repo: "A loop line needs a pull request from this copy's own repo on the task.",
  idea_missing: "That idea isn't there any more, or it's in a brand you can't see.",
  measure_operators: "Counting a purpose, a type or a loop kind is only for the people who run this copy's own learning loop.",
  type_not_built: "That isn't a type YouGrow keeps yet.",
  product_missing: "That connected product isn't there, or it was disconnected. Pick another, or let your read be the record.",
  product_look: "A product event is counted over days, at most 90, because events are kept for 90 days.",
  product_whole_business: "A product event is counted for one brand. Tag the task with its brand first.",
  blocker_missing: "One of the tasks it waits for isn't one you can see.",
  blocker_self: "A task can't wait for itself.",
  no_check: "This task has no check.",
  measure_check_read: "This check asks if it worked. Answer Better, Same, Worse or Too soon to tell.",
  read_not_measure: "Only a check that asks if it worked takes a read. Mark this one checked, or look again.",
  measure_check_kept: "This task's check asks if it worked. Answer it first, or move its date.",
  check_task_missing: "The task this check waits for isn't one you can see.",
  plan_link_missing: "Approve the plan answers a plan link on this task. Add the plan link first, with the version you're approving.",
  plan_recommended: "No one recommends approving a plan, so a drafted approval can't be saved. Record it yourself.",
  plan_choice: "Approve the plan takes Approve, Change it or Not now.",
  plan_question: "Approve the plan is asked only with a plan link from this task.",
  replaces_missing: "The decision this one replaces isn't on this task.",
  import_empty: "There are no rows to import. Paste a header row and at least one task.",
  import_too_many: "Import takes up to 1,000 rows at a time. Split the sheet and import each part.",
  import_no_title: "Work couldn't find the column that holds each task. Pick it, then preview again.",
  import_too_big: "That's more than Work reads at once. Import up to 1,000 rows at a time.",
  regions_down: "Work couldn't read every region just now, so it can't be sure your refs are free. Try again in a minute.",
  day_bad: "That isn't a day Work can show.",
} as const;

export type WorkRefusal = Exclude<keyof typeof WORK_MESSAGES, "invalid_input">;

/** Why one imported row was left out. */
export const IMPORT_ROW_MESSAGES = {
  no_title: "It has no task.",
  ref_taken: "Its ref is taken already.",
  ref_twice: "Its ref is on an earlier row too.",
  ref_bad: "Its ref isn't a number from 1 to 999999.",
  too_long: "A field is longer than Work keeps.",
  check_bad: "Its check isn't a day or a task to wait for.",
  brand_unknown: "Its brand isn't one you can tag.",
  failed: "It couldn't be saved. Try importing it again.",
} as const;
export type ImportRowProblem = keyof typeof IMPORT_ROW_MESSAGES;

// --- Dates and numbers -------------------------------------------------------------------------

/** "9 Dec", the day an instant falls on in the zone. */
export function dayOf(iso: string, timeZone: string): string {
  return dayWords(localDateKey(Date.parse(iso), timeZone));
}

/** "08:00", the time an instant falls at in the zone. */
export function timeOf(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

/** "2,000". */
export function countWords(n: number): string {
  return Math.round(n).toLocaleString("en-GB");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Nov 2026", "Nov and Dec 2026", or "Dec 2026 to Feb 2027". */
export function monthsWords(fromMonth: string, toMonth: string): string {
  const w = (m: string, year: boolean) => `${MONTHS[Number(m.slice(5, 7)) - 1]}${year ? ` ${m.slice(0, 4)}` : ""}`;
  if (fromMonth === toMonth) return w(toMonth, true);
  const sameYear = fromMonth.slice(0, 4) === toMonth.slice(0, 4);
  const [fy, fm] = [Number(fromMonth.slice(0, 4)), Number(fromMonth.slice(5, 7))];
  const next = fm === 12 ? `${fy + 1}-01` : `${fy}-${String(fm + 1).padStart(2, "0")}`;
  return `${w(fromMonth, !sameYear)} ${next === toMonth ? "and" : "to"} ${w(toMonth, true)}`;
}

// --- What a measure's check counted ------------------------------------------------------------

/**
 * The resource whose units a Used purpose is counted in: of the resources that list it, the one
 * that lists fewest purposes, so a purpose that spends drafts or images is counted in those, not
 * in model tokens. Null for a purpose no resource lists.
 */
export function purposeResource(purpose: string): ResourceId | null {
  let best: ResourceId | null = null;
  for (const [id, r] of Object.entries(RESOURCES) as Array<[ResourceId, (typeof RESOURCES)[ResourceId]]>) {
    if (!(r.purposes as readonly string[]).includes(purpose)) continue;
    if (best === null || r.purposes.length < RESOURCES[best].purposes.length) best = id;
  }
  return best;
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** What a Moves a number measure moves, in the brand's word: "orders", "open rate". */
export function movesWhat(m: { meaning: MeaningKey; word?: string }): string {
  return lower(m.word ?? MEANINGS[m.meaning].name);
}

export interface CountedLineInput {
  /** The measure the check asks about: the first, or its then. */
  part: Exclude<Measure, { kind: "done" }> | ThenMeasure;
  counted: Counted | null;
  /** The brand the task is for, or null for a whole business task. */
  brandName: string | null;
  timeZone: string;
  /** The usage meter is off, so a purpose isn't counted. */
  meterOff?: boolean;
}

const READ_IS_RECORD = "so your read is the record.";

/**
 * The line on a measure's check: the number Work counted, or what it can't count. For example
 * "Work counted 212 note_from_template events from Lumen Notes' product since 11 Nov.", or "Work
 * can't count orders for Fernhill Plants yet, so your read is the record."
 */
export function countedLine(i: CountedLineInput): string {
  const p = i.part;
  const brand = i.brandName ? `${i.brandName}${/s$/i.test(i.brandName) ? "'" : "'s"}` : null;
  if (p.kind === "runs_better") return `Work can't count ${p.what}, ${READ_IS_RECORD}`;
  if (p.kind === "moves") return `Work can't count ${movesWhat(p)}${i.brandName ? ` for ${i.brandName}` : ""} yet, ${READ_IS_RECORD}`;
  const c = p.counts;
  if ("none" in c) return `Work counts nothing for this one, ${READ_IS_RECORD}`;
  if ("type" in c) return `Work can't count ${c.type.replace(/_/g, " ")} records yet, ${READ_IS_RECORD}`;
  if ("loopKind" in c) return `Work can't count ${c.loopKind} yet, ${READ_IS_RECORD}`;
  if ("purpose" in c) {
    const label = lower(PURPOSE_LABELS[c.purpose as ResourcePurpose] ?? c.purpose);
    if (i.meterOff) return `Work can't count ${label} while the usage meter is off, ${READ_IS_RECORD}`;
    if (!i.counted || i.counted.units === undefined) return "Work counts it once the check is due.";
    const r = purposeResource(c.purpose);
    const unit = r ? RESOURCES[r].unit : "units";
    const months = monthsWords(i.counted.from.slice(0, 7), i.counted.to.slice(0, 7));
    const spent = `Work counted ${countWords(i.counted.units)} ${unit} spent on ${label} in ${months}`;
    const brands = i.counted.hidden
      ? ". How many brands used it stays hidden until they come from 10 organisations."
      : `, by ${countWords(i.counted.brands ?? 0)} ${i.counted.brands === 1 ? "brand" : "brands"}.`;
    return `${spent}${brands} The month totals include days before Done.`;
  }
  const event = c.productEvent.event;
  if (!i.counted || i.counted.n === undefined) return "Work counts it once the check is due.";
  const n = i.counted.n;
  const events = `${event} ${n === 1 ? "event" : "events"}`;
  if (i.counted.capped && i.counted.backTo) {
    return `Work counted at least ${countWords(n)} ${events}${brand ? ` from ${brand} product` : ""} in the newest 2,000 events, back to ${dayOf(i.counted.backTo, i.timeZone)}.`;
  }
  return `Work counted ${countWords(n)} ${events}${brand ? ` from ${brand} product` : ""} since ${dayOf(i.counted.from, i.timeZone)}.`;
}

// --- Notices after a change --------------------------------------------------------------------

/** After Done set a measure's check, saying when, and that it replaced one. */
export function doneCheckNotice(at: string, timeZone: string, replaced: boolean): string {
  return `It asks if it worked on ${dayOf(at, timeZone)} at ${timeOf(at, timeZone)}${replaced ? ", in place of the check that was set" : ""}.`;
}

/** After Too soon to tell: when it asks again. */
export function askAgainNotice(at: string, timeZone: string): string {
  return `It asks again on ${dayOf(at, timeZone)} at ${timeOf(at, timeZone)}.`;
}

/** After Look again or Tomorrow: when the next check is. */
export function nextCheckNotice(at: string, timeZone: string): string {
  return `Next check on ${dayOf(at, timeZone)} at ${timeOf(at, timeZone)}.`;
}

/** After a read set the then's check. */
export function thenCheckNotice(at: string, timeZone: string): string {
  return `The then's check is on ${dayOf(at, timeZone)} at ${timeOf(at, timeZone)}.`;
}

/** Imported statuses Work doesn't know, as the import dialog says them. */
export function unknownStatusesText(words: readonly string[]): string {
  if (!words.length) return "";
  if (words.length === 1) return `1 status isn't one of Work's, so ${words[0]} comes in as To do.`;
  const list = words.length === 2 ? `${words[0]} and ${words[1]}` : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
  return `${words.length} statuses aren't Work's, so ${list} come in as To do.`;
}

/** "Your refs are kept. New tasks start at #13." */
export function refHintText(nextRef: number): string {
  return `Your refs are kept. New tasks start at #${nextRef}.`;
}
