import { MEANINGS } from "@/lib/metrics/meanings";
import { ideaWord } from "@/lib/nav/terms";
import { FORMER_TEAM_MEMBER } from "@/lib/team/former";
import { dayIn } from "./schedule";
import { stageById, stageLabel, type CompanyStage } from "./stages";
import { dayOf, movesWhat, WORK_STATUS_LABEL } from "./words";
import type { EntryState, Look, Measure, MeasureKind, RunsBetterWhat, ThenMeasure, WorkChangeField, WorkOrigin, WorkStatus, WorkWho } from "./types";

/**
 * The words Work's screens say (ADR-0020): the list, the task page, the add page and the Log. Fixed
 * sentences are literals here, so the help page can quote them and src/lib/help/help.test.ts finds
 * them in src/. The refusals the routes answer with are in words.ts. House style:
 * src/lib/content/writingRules.ts, and words that fit any business, not only software.
 *
 * Pure: plain data and pure helpers, so client components use it in the browser. Text people wrote
 * (titles, notes, names) is passed in and shown as it is, never read as instructions.
 */

// --- Labels ------------------------------------------------------------------------------------

export type WorkTone = "neutral" | "blue" | "green" | "amber" | "red" | "violet";

export const WORK_STATUS_TONE: Record<WorkStatus, WorkTone> = {
  todo: "neutral",
  in_progress: "blue",
  waiting: "amber",
  done: "green",
  dropped: "neutral",
};

/** The four kinds of win, as How we'll know it worked names them. */
export const MEASURE_KIND_LABEL: Record<MeasureKind, string> = {
  used: "Used",
  moves: "Moves a number",
  runs_better: "Runs better",
  done: "Done is the win",
};

/** What each kind means, one line, under its name in the picker. */
export const MEASURE_KIND_HINT: Record<MeasureKind, string> = {
  used: "A feature or a thing you made gets used.",
  moves: "A number goes up or down.",
  runs_better: "Fewer errors or crashes, less memory or cost, more speed.",
  done: "Finishing it is the point. No check after.",
};

/** Runs better's hint for a business with no connected repo or product, where crashes and memory aren't offered. */
export const RUNS_BETTER_HINT_NO_APP = "Fewer errors, less cost, more speed.";

/** A kind's hint in the picker: Runs better names crashes and memory only where they can be picked. */
export function kindHint(kind: MeasureKind, runsInApp: boolean): string {
  return kind === "runs_better" && !runsInApp ? RUNS_BETTER_HINT_NO_APP : MEASURE_KIND_HINT[kind];
}

export const RUNS_BETTER_LABEL: Record<RunsBetterWhat, string> = {
  errors: "Errors",
  crashes: "Crashes",
  memory: "Memory",
  cost: "Cost",
  speed: "Speed",
};

/** A Log entry's state. */
export const ENTRY_STATE_LABEL: Record<EntryState, string> = {
  doing: "In progress",
  done: "Done",
  blocked: "Blocked",
  waiting: "Waiting",
};

export const ENTRY_STATE_TONE: Record<EntryState, WorkTone> = {
  doing: "blue",
  done: "green",
  blocked: "red",
  waiting: "amber",
};

/** The columns an import knows, as the empty state lists them. */
export const IMPORT_COLUMNS = ["MVP", "Ref", "Backlog item", "Description", "Notes", "Status", "Clippings", "Stage", "Brand", "Check"] as const;

/** What a sheet's column can fill, as the import preview's pickers say it. */
export const IMPORT_FIELD_LABEL = {
  title: "Task",
  ref: "Ref",
  mustHave: "Must have",
  description: "Description",
  notes: "Notes",
  status: "Status",
  clipping: "Clipping",
  stage: "Stage",
  brand: "Brand",
  check: "Check",
  skip: "Skip this column",
} as const;

// --- Fixed sentences ---------------------------------------------------------------------------

export const WORK_COPY = {
  measureTitle: "How we'll know it worked",
  howWellKnow: "How we'll know:",
  daysAfterDone: "days after it's done",
  fromSuggestion: "From Vizzy's suggestion in Review.",
  hiddenTask: "A task you can't see",
  deletedTask: "A deleted task",
  unreadTask: "A task Work couldn't read",
  noBrand: "This brand isn't active, so Work can't show its tasks.",
  taskRegionsDown: "Work couldn't read every region just now, so a task this one names may be missing.",
  afterTaskDone: "The task it waited for is done.",
  listOrder: "Checks due first, then Must have, then last changed. A done task stays while its check is due.",
  noMatch: "No tasks match these filters.",
  foot: "Work holds the tasks people add, and each task keeps the decisions made on it. Your Path is on Home, and Review holds decisions to make.",
  importTitle: "Import your backlog",
  importText: "Upload a CSV, or copy your Backlog tab in Google Sheets and paste it. Columns it knows:",
  firstTaskTitle: "Add your first task",
  firstTaskText: "Something like Register the business, with a date to check it again.",
  vizzyStartTitle: "Ask Vizzy for a start",
  vizzyStartText: "Vizzy suggests a few tasks for the stage you're in. They wait in Review until you add them.",
  memberOneBrand: "Everyone here sees every task. You can add, edit and log, and admins import and delete.",
  quickAddPlaceholder: "What needs doing? For example: Register for VAT",
  mustHaveHint: "Has to happen before you launch or open. Must haves sit near the top of the list.",
  measureNone: "No measure yet. Pick one of four kinds of win: Used, Moves a number, Runs better or Done is the win.",
  measureDone: "No check after it's done.",
  measureFormNone: "No measure. Pick a kind of win, or leave it for later.",
  noSuggestion: "No suggestion yet. Pick the kind that fits.",
  lookHint: "On that day it sets a check for 08:00 that asks: did it work?",
  thenLookHint: "Counted from the same Done, so it looks after the first.",
  outputsHint: "Work can't count outputs yet, so this sets no check for now.",
  usedNoneHint: "Nothing counts it yet, so when the check falls due your read is the record.",
  movesHint: "A number from YouGrow's meanings, in your words. Work can't count it on the check yet, so your read is the record.",
  usedNone: "Nothing to count yet: your read is the record",
  productNeedsBrand: "A product event is counted for one brand, so tag the task with its brand to count one.",
  checkDue: "Check due.",
  checkDueText: "You asked to look at this task again now.",
  measureDueTitle: "Check due: did it work?",
  yourRead: "Your read:",
  blockedText: "It isn't done yet. When it is, this task is ready to start.",
  approveAsk: "Approve the plan?",
  approveNote: "No one recommends approving a plan. Your pick is kept as a decision on this task.",
  planNoRecommendation: "No one recommends approving a plan. People keep this gate.",
  noDecisions: "No decisions yet. When there's a choice to make, record the options, the pick and why.",
  planQuestionHere: "Approve the plan is asked from its plan link, under Connected to.",
  historyHint: "People and Vizzy, newest first",
  noHistory: "Nothing has changed yet.",
  pageFoot: "History shows the last 20 changes, with who made each. The Log keeps every one.",
  vizzyFoot: "Vizzy suggests changes in Review, and a person accepts them.",
  typedHintRepo: "Exact links that agents can follow. Pull requests and switches show because a repo is connected.",
  planUrlBad: "Use an https link to the page, with no user name or password in it.",
  linkUrlBad: "Use a full link that starts with https:// or http://.",
  linkHintRepo: "A pull request or a plan goes under Connected to, so agents can follow it.",
  linkHintNoRepo: "A plan goes under Connected to, so agents can follow it.",
  blockedByHint: "Up to 5. While one is open, the task shows Waiting on it.",
  noOpenTask: "No open task matches.",
  afterTaskHint: "The check falls due the day that task moves to Done.",
  formFoot: "It shows in Review on the day its check falls due.",
  descriptionHint: "Up to 4,000 characters.",
  /** With a repo: a command in backticks gets a Copy button on the task. */
  descriptionCodeHint: "Up to 4,000 characters. Put a command in `backticks` to show it as code.",
  /** Make it an idea (or a launch) made the idea, but linking the task to it failed. */
  ideaLinkFailed: "The idea was made, but the task couldn't be linked to it. Press Link the task to try again.",
  launchLinkFailed: "The launch was made, but the task couldn't be linked to it. Press Link the task to try again.",
  linkTaskAgain: "Link the task",
  wholeBusinessHint: "Only owners see whole business tasks.",
  wholeBusinessLabel: "Whole business",
  inFlightHint: "Newest first. The same workstream comes back each day until it's done.",
  pastDayHint: "Read only. Newest first.",
  nothingInFlight: "Nothing in flight. Type what you're on, one line per workstream.",
  nothingInFlightPast: "Nothing was in flight that day.",
  noChecks: "No checks are due.",
  nothingMoved: "Nothing has moved yet today.",
  nothingMovedPast: "Nothing moved that day.",
  noDecisionsToday: "No decisions yet today.",
  noDecisionsPast: "No decisions that day.",
  logPlaceholder: "What are you on? For example: Pricing page: copy done, check on mobile",
  logFoot: "One line per workstream. It carries over each day until you log it as done.",
  logVizzyFoot: "Ask Vizzy to draft today's note, and save it from the chat.",
  logCapped: "This day has more rows than the Log reads at once, so the oldest workstreams may be missing.",
  importIntro: "From your Backlog tab, up to 1,000 rows. Nothing is added until you import.",
  vizzySuggested: "What Vizzy suggested",
  vizzySuggestedHint: "Each field you changed before adding, as Vizzy wrote it. Both versions are kept.",
  noStage: "No stage",
  noMeasure: "None",
  importColumnsHint: "Each column of your sheet, and the field it fills. Change one if it's matched wrong.",
  pastePlaceholder: "Paste the rows here, header row first.",
  deleteConfirm: "Delete this task? Its history stays in the Log.",
  makeIdeaHint: "Opens a new one with this title, and the task links to it.",
} as const;

// --- People ------------------------------------------------------------------------------------

/** Who did something, as a sentence starts: "You", a team member's name, Vizzy, Work itself or Former team member. */
export function whoWords(who: WorkWho | { kind: "person"; id: string | null }, me: string, names: Readonly<Record<string, string>>): string {
  if (who.kind === "vizzy") return "Vizzy";
  if (who.kind === "system") return "Work";
  if (who.kind === "coding_agent") return "A coding agent";
  if (!who.id) return FORMER_TEAM_MEMBER;
  if (who.id === me) return "You";
  return Object.hasOwn(names, who.id) ? names[who.id]! : FORMER_TEAM_MEMBER;
}

/** The same, in the middle of a sentence: "you" for the viewer. */
export function whoInline(who: WorkWho | { kind: "person"; id: string | null }, me: string, names: Readonly<Record<string, string>>): string {
  const w = whoWords(who, me, names);
  return w === "You" ? "you" : w;
}

/** Two letters for an avatar: initials of a name, or V for Vizzy and W for Work. */
export function initialsOf(name: string): string {
  if (name === "You") return "YO";
  if (name === "Vizzy") return "V";
  if (name === "Work") return "W";
  const words = name.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  const letters = words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/** "Lumen Notes'" or "Fernhill's". */
export function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

// --- The list ----------------------------------------------------------------------------------

/** The line under Work's title. */
export function listSubLine(o: { name: string; view: "organisation" | "brand"; brandCount: number; empty: boolean; vizzy: boolean }): string {
  if (o.empty) return `One list for ${o.name}, at every stage of the business.`;
  const who = o.vizzy ? "People add tasks, and Vizzy suggests them in Review." : "People add tasks, and each one keeps its history.";
  if (o.view === "brand") return `${possessive(o.name)} tasks, at every stage. ${who}`;
  if (o.brandCount > 1) return `One list for all of ${o.name}, across ${o.brandCount} brands and every stage. ${who}`;
  return `One list for ${o.name}, at every stage. ${who}`;
}

/** The note a member reads in a multi brand organisation. */
export function memberBrandNote(brand: string): string {
  return `You see the tasks tagged ${brand}. Tasks for the whole business are for owners, unless an owner tags your brand.`;
}

export function emptyTitle(name: string): string {
  return `One list for everything ${name} has to do`;
}

export function emptyText(multiBrand: boolean): string {
  return multiBrand
    ? "From registering the business to whatever comes next. A task can have a stage and a brand, and you filter the list by either."
    : "From registering the business to whatever comes next. A task can have a stage, and you filter the list by stage and status.";
}

/** "Tasks · 12 open". */
export function tasksTabLabel(open: number | null): string {
  return open === null ? "Tasks" : `Tasks · ${open} open`;
}

/** The regions whose tasks couldn't be read. */
export function regionsDownText(names: readonly string[]): string {
  const list = names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Work couldn't read the tasks kept in ${list} just now, so they're missing here. Try again in a minute.`;
}

/** The regions holding more tasks than Work reads at once, as after a brand with many tasks moved in. */
export function regionsFullText(names: readonly string[]): string {
  const list = names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Work reads up to 5,000 tasks in each region, and ${list} holds more, so some are missing here. Delete done or dropped tasks you no longer need.`;
}

/** The Log's line when a region didn't answer. */
export function logRegionsDownText(names: readonly string[]): string {
  const list = names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Work couldn't read ${list} just now, so some of the day is missing. Try again in a minute.`;
}

/** What Today says after a check on it is answered, once the check has left the list: "#12: It asks again on 3 Dec at 08:00." */
export function checkSaidLine(ref: number, notice: string): string {
  return `#${ref}: ${notice}`;
}

/** A due check that waited for another task. */
export function afterTaskDueLine(ref: number): string {
  return `#${ref} is done, so look at this task again.`;
}

export function unreadableText(n: number): string {
  return n === 1 ? "1 task couldn't be read, so it's left out." : `${n} tasks couldn't be read, so they're left out.`;
}

/** "Used, then Moves a number". */
export function winLine(m: Measure | null): string | null {
  if (!m) return null;
  const then = m.kind !== "done" && m.then ? `, then ${MEASURE_KIND_LABEL[m.then.kind]}` : "";
  return `${MEASURE_KIND_LABEL[m.kind]}${then}`;
}

// --- A measure ---------------------------------------------------------------------------------

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** "14 days after it's done", or "after 20 outputs". */
export function lookWords(look: Look): string {
  if ("days" in look) return look.days === 1 ? "1 day after it's done" : `${look.days} days after it's done`;
  return `after ${look.outputs} outputs`;
}

/** Names a measure's words look up: a connected product's name, and an event's label in its catalog. */
export interface MeasureNames {
  connection?: (id: string) => string | undefined;
  /** The catalog's label for an event, as the picker shows it; the raw name when there is none. */
  event?: (connectionId: string, event: string) => string | undefined;
}

/** What a measure part counts or moves, in words: "notes made from a template" (or "note_from_template events"), "orders up", "crashes". */
export function measureWhat(p: Exclude<Measure, { kind: "done" }> | ThenMeasure, names: MeasureNames = {}): string {
  if (p.kind === "runs_better") return p.what;
  if (p.kind === "moves") return `${movesWhat(p)} ${p.direction}`;
  const c = p.counts;
  if ("none" in c) return c.none ? `your read: ${c.none}` : "your read";
  if ("purpose" in c) return `the ${c.purpose.replace(/_/g, " ")} purpose`;
  if ("type" in c) return `${c.type.replace(/_/g, " ")} records`;
  if ("loopKind" in c) return `the ${c.loopKind} loop`;
  const from = names.connection?.(c.productEvent.connectionId);
  const label = names.event?.(c.productEvent.connectionId, c.productEvent.event);
  return `${label ? lowerFirst(label) : `${c.productEvent.event} events`}${from ? ` from ${from}` : ""}`;
}

/** "Used: notes made from a template, 14 days after it's done." */
export function partLine(p: Exclude<Measure, { kind: "done" }> | ThenMeasure, names: MeasureNames = {}): string {
  return `${MEASURE_KIND_LABEL[p.kind]}: ${measureWhat(p, names)}, ${lookWords(p.look)}.`;
}

/** The kind proposed beside the one kept: "Suggested: Used. It names a switch... You kept it." */
export function proposedLine(m: Measure): string | null {
  const p = m.proposed;
  if (!p) return null;
  const by = p.by === "vizzy" ? `Vizzy suggested ${MEASURE_KIND_LABEL[p.kind]}.` : `Suggested: ${MEASURE_KIND_LABEL[p.kind]}.`;
  const kept = p.kind === m.kind ? "You kept it." : `${MEASURE_KIND_LABEL[m.kind]} was picked over it.`;
  return `${by} ${p.reason} ${kept}`;
}

/** The picker's line about the suggested kind. */
export function suggestionLine(s: { kind: MeasureKind; reason: string } | null, by: "rule" | "vizzy" = "rule"): string {
  if (!s) return WORK_COPY.noSuggestion;
  return by === "vizzy" ? `Vizzy suggests ${MEASURE_KIND_LABEL[s.kind]}. ${s.reason}` : `Suggested: ${MEASURE_KIND_LABEL[s.kind]}. ${s.reason}`;
}

/** When the person picked another kind than the suggested one. */
export function keptLine(picked: MeasureKind, suggested: MeasureKind, by: "rule" | "vizzy" = "rule"): string {
  return `You picked ${MEASURE_KIND_LABEL[picked]} over ${by === "vizzy" ? "Vizzy's" : "the suggested"} ${MEASURE_KIND_LABEL[suggested]}. Both are kept, so the suggestion can learn.`;
}

/** The line under a measure on an open task: when its look starts, and what the check will ask. */
export function measureHint(task: { status: WorkStatus }, m: Measure): string | null {
  if (m.kind === "done") return null;
  if (!("days" in m.look)) return WORK_COPY.outputsHint;
  if (task.status === "done") return null;
  const n = m.look.days;
  return `${n === 1 ? "The 1 day starts" : `The ${n} days start`} when it's done. Then it asks: did it work? Better, Same, Worse or Too soon to tell.${m.then ? " The then waits for that read." : ""}`;
}

/** A product event's hint: where it is counted from, and the 90 days. */
export function productEventHint(connection: string): string {
  return `Counted from ${connection}. Events are kept 90 days, so look within 90.`;
}

/** Runs better's hint, in the words of the check. */
export function runsBetterHint(what: RunsBetterWhat): string {
  return `Work can't count ${what}, so your read is the record.`;
}

// --- Origin and history ------------------------------------------------------------------------

/**
 * Where a task came from, as two parts the task page sets apart: "Added by Nina" and "on 18 Nov."
 * A task from a Vizzy suggestion says where Vizzy wrote it from and whether it was edited before
 * adding, when the suggestion can be read: "From Vizzy: from today's log. Added by you on 18 Nov,
 * edited before adding."
 */
export function originParts(
  origin: WorkOrigin,
  createdAt: string,
  timeZone: string,
  me: string,
  names: Readonly<Record<string, string>>,
  suggested?: { from: string; edited: boolean } | null,
): { from: string; rest: string } {
  const day = dayOf(createdAt, timeZone);
  if (origin.kind === "suggestion" && suggested) {
    return { from: "From Vizzy:", rest: `${suggested.from}. Added by ${whoInline({ kind: "person", id: origin.by }, me, names)} on ${day}${suggested.edited ? ", edited before adding" : ""}.` };
  }
  if (origin.kind === "person") return { from: `Added by ${whoInline({ kind: "person", id: origin.by }, me, names)}`, rest: `on ${day}.` };
  if (origin.kind === "import") {
    return { from: `Imported from ${origin.file ?? "a sheet"}`, rest: `by ${whoInline({ kind: "person", id: origin.by }, me, names)} on ${day}, row ${origin.row}.` };
  }
  if (origin.kind === "suggestion") return { from: "From Vizzy:", rest: `added from its suggestion by ${whoInline({ kind: "person", id: origin.by }, me, names)} on ${day}.` };
  return { from: "From a coding agent", rest: `on ${day}.` };
}

const short = (v: unknown, max = 80): string | null => {
  if (typeof v !== "string") return null;
  const one = v.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/** A plan link's key: its url and version, as a plan approval names them. */
export function planKeyOf(url: string, version: string | null | undefined): string {
  return `${url} ${version ?? ""}`;
}

/**
 * The plan a decision approves, as Today names it: its title from the task's plan link (the page's
 * host when the task wasn't read), with its version: "Shared notebooks plan, version v2".
 */
export function planApprovalWords(plan: { url: string; version?: string }, title: string | undefined): string {
  let name = title;
  if (!name) {
    try {
      name = new URL(plan.url).hostname;
    } catch {
      name = plan.url;
    }
  }
  return `${name}${plan.version ? `, version ${plan.version}` : ""}`;
}

/** The hint under Connected to, in this copy's word for an idea (`ideaWords`, isIdeaWordsEnabled() on the server). */
export function typedHintText(repo: boolean, ideaWords: boolean): string {
  return repo ? WORK_COPY.typedHintRepo : `Exact links that agents can follow: ${ideaWord(ideaWords).a}, or a plan page. Pull requests and switches show once a repo is connected.`;
}

/** Connected to with nothing in it, in this copy's word for an idea. */
export function noLinksText(repo: boolean, ideaWords: boolean): string {
  const a = ideaWord(ideaWords).a;
  return repo ? `No links yet. Add a pull request, a switch, ${a}, a plan, an AI chat or a page.` : `No links yet. Add ${a}, a plan, an AI chat or a page.`;
}

/**
 * One change in words, after who did it: "moved it from To do to In progress". `ideaWords` says
 * whether this copy calls a launch an idea.
 */
export function changeWords(field: WorkChangeField, before: unknown, after: unknown, ctx: { brandName?: (id: string) => string | undefined; tool?: string; ideaWords?: boolean } = {}): string {
  const idea = ideaWord(ctx.ideaWords === true);
  const statusLabel = (v: unknown) => (typeof v === "string" && v in WORK_STATUS_LABEL ? WORK_STATUS_LABEL[v as WorkStatus] : "a status");
  const stage = (v: unknown) => (typeof v === "string" && stageById(v) ? stageLabel(v as CompanyStage) : null);
  switch (field) {
    case "added":
      return ctx.tool === "import" ? "imported it" : "added it";
    case "deleted":
      return "deleted it";
    case "status":
      return before ? `moved it from ${statusLabel(before)} to ${statusLabel(after)}` : `set it to ${statusLabel(after)}`;
    case "stage": {
      const a = stage(after);
      const b = stage(before);
      if (!a) return "cleared the stage";
      return b ? `moved it from ${b} to ${a}` : `set the stage to ${a}`;
    }
    case "mustHave":
      return after === true ? "marked it Must have" : "took off Must have";
    case "title": {
      const t = short(after);
      return t ? `renamed it “${t}”` : "renamed it";
    }
    case "description":
      return "changed the description";
    case "notes": {
      const t = short(after, 60);
      return t ? `changed the notes to “${t}”` : "cleared the notes";
    }
    case "brandId": {
      if (after === null) return "made it a whole business task";
      const name = typeof after === "string" ? ctx.brandName?.(after) : undefined;
      return name ? `tagged it ${name}` : "tagged it with another brand";
    }
    case "organisationId":
      return "moved it with its brand to another organisation";
    case "ref":
      return typeof after === "number" ? `gave it the ref #${after}` : "gave it a new ref";
    case "links":
      return "changed the links";
    case "blockedBy":
      return "changed what it waits for";
    case "waitingOn": {
      const t = short(after, 60);
      return t ? `set it waiting on ${t}` : "took off what it was waiting on";
    }
    case "ideaId":
      return after ? `made it into ${idea.a}` : `unlinked its ${idea.one}`;
    case "ideaBrandId":
      return `changed the ${idea.own} brand`;
    // The recent list leaves out a value too big to keep (undefined); only null is taken off.
    case "clipping":
      return after === null ? "took off the clipping" : "linked a clipping";
    case "typedLinks":
      return "changed what it's connected to";
    case "measure":
      return after === null ? "took off how we'll know it worked" : "set how we'll know it worked";
    case "check":
      return checkChangeWords(after, ctx.tool);
  }
}

/** A check row's action, or a check set or cleared. */
function checkChangeWords(after: unknown, tool?: string): string {
  if (tool === "work_count") return "counted the check";
  switch (after) {
    case "checked":
      return "marked the check done";
    case "look_again":
      return "moved the check on";
    case "better":
      return "read the check: Better";
    case "same":
      return "read the check: Same";
    case "worse":
      return "read the check: Worse";
    case "too_soon":
      return "read the check: Too soon to tell";
    case null:
      return "cleared the check";
    default:
      return "set the check";
  }
}

/** "24 Nov, 16:40" in the zone, or "Today, 10:20" on the day it is now there. */
export function whenWords(iso: string, timeZone: string, today: string): string {
  const time = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  return dayIn(iso, timeZone) === today ? `Today, ${time}` : `${dayOf(iso, timeZone)}, ${time}`;
}

// --- Checks ------------------------------------------------------------------------------------

/** What a task's check reads as, in the side panel. */
export function checkSideLine(o: { kind: "date" | "after_task"; at: string | null; byMeasure: boolean; due: boolean; timeZone: string; afterRef?: number | null }): string {
  if (o.kind === "after_task") return o.afterRef ? `When #${o.afterRef} is done` : "When another task is done";
  const day = o.at ? dayOf(o.at, o.timeZone) : "";
  const time = o.at ? new Intl.DateTimeFormat("en-GB", { timeZone: o.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(o.at)) : "";
  const when = o.due ? `Due since ${day}, ${time}` : `On ${day} at ${time}`;
  return o.byMeasure ? `${when}. Set by the measure, asking did it work?` : `${when}.`;
}

/** The Log day's title: "Wednesday 25 Nov". */
export function dayTitle(day: string): string {
  const d = new Date(`${day}T12:00:00.000Z`);
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" }).format(d);
}

/** The day rail's label: "Wed 25 Nov". */
export function railLabel(day: string): string {
  const d = new Date(`${day}T12:00:00.000Z`);
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(d);
}

/** "Day 3", or "Day 31 or more" when it started before the days the Log read. */
export function dayNWords(n: number, longer: boolean): string {
  return longer ? `Day ${n} or more` : `Day ${n}`;
}

/** The Log's line under its title. */
export function logSubLine(name: string): string {
  return `What ${name} worked on each day. People type their workstreams, and each one carries over until it's done.`;
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** After a task was added from the add page: "Added #81 Register for VAT." */
export function addedLine(ref: number, title: string): string {
  return `Added #${ref} ${title}.`;
}

/** Edit then add's origin line: "Vizzy wrote it from today's log. What Vizzy wrote is kept beside what you add." */
export function suggestionFromLine(from: string): string {
  return `Vizzy wrote it ${from}. What Vizzy wrote is kept beside what you add.`;
}

/** The task page's list of what Vizzy suggested, for each field the person changed before adding. */
export const SUGGESTED_FIELD_LABEL: Record<string, string> = {
  title: "Title",
  description: "Description",
  stage: "Stage",
  brandId: "Brand",
  typedLinks: "Connected to",
  measure: "How we'll know",
};

/** Beside a title the person changed on Vizzy's suggestion. */
export function vizzyWroteLine(title: string): string {
  return `Vizzy wrote “${title}”. Both versions are kept.`;
}

/** "It becomes #81 when you add it." */
export function nextRefLine(ref: number): string {
  return `It becomes #${ref} when you add it.`;
}

/** "In Lumen Notes' time zone, Europe/London." */
export function zoneHint(brandName: string, timeZone: string): string {
  return `In ${possessive(brandName)} time zone, ${timeZone}.`;
}

/** "Everyone on Lumen Notes sees it." */
export function brandHint(brandName: string): string {
  return `Everyone on ${brandName} sees it.`;
}

/** A meaning's name as a picker lists it, with the brand's word for conversions. */
export function meaningLabel(key: keyof typeof MEANINGS, word?: string): string {
  return key === "conversions" && word ? `${word} (conversions)` : MEANINGS[key].name;
}

/** The import's line for columns the sheet doesn't have. */
export function missingColumnsText(missing: readonly string[]): string {
  if (!missing.length) return "";
  const list = missing.length < 2 ? missing[0]! : `${missing.slice(0, -1).join(", ")} or ${missing[missing.length - 1]}`;
  return `Your sheet has no ${list}, so you set those on each task after.`;
}

/** After an import. */
export function importedText(n: number, refused: number): string {
  const tasks = plural(n, "task", "tasks");
  return refused ? `Imported ${tasks} with their refs. ${plural(refused, "row was", "rows were")} left out, each with why below.` : `Imported ${tasks} with their refs.`;
}

/** "Import 12 tasks". */
export function importButton(n: number): string {
  return n === 1 ? "Import 1 task" : `Import ${n} tasks`;
}

/** "All 12 rows. The preview shows up to 20." */
export function previewHint(total: number): string {
  return total <= 20 ? `All ${plural(total, "row", "rows")}.` : `${total} rows. The preview shows the first 20.`;
}
