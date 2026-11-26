import { addDaysToKey } from "@/lib/lifecycle/sendWindow";
import { MEANINGS, type MeaningKey } from "@/lib/metrics/meanings";
import { LOOPS, VENDOR, type LoopKind } from "@/lib/loops/registry";
import { EVENT_NAME_RE } from "@/lib/types/productConnection";
import type { CheckInput, MeasureInput, ThenInput } from "./inputs";
import { PlanUrlSchema, SWITCH_NAME, startingDirection, WorkLinkSchema, type Look, type Measure, type MeasureKind, type RunsBetterWhat, type ThenMeasure, type TypedLink, type WorkLink } from "./types";
import { WORK_COPY } from "./screenWords";

/**
 * The add page's and the task page's forms as plain data (ADR-0018), and what each sends Work's
 * routes. The routes check everything again and set what only the server may (origin, setBy, the
 * proposed kind): this only turns a form into a request, and says in words what would be refused,
 * so the person fixes it before sending. Pure, so client components use it in the browser.
 */

// --- How we'll know it worked ------------------------------------------------------------------

/**
 * The longest a product event measure may look, as the picker says it: events are kept for 90
 * days (EVENT_TTL_MS, server only; form.test.ts holds the two together).
 */
export const PRODUCT_EVENT_DAYS = 90;

export type UsedCountsKind = "none" | "event" | "purpose" | "type" | "loopKind";

/** One measure (the first or its then) as the picker holds it: every kind's fields kept, so switching kind keeps them. */
export interface PartDraft {
  kind: Exclude<MeasureKind, "done">;
  counts: UsedCountsKind;
  noneReason: string;
  connectionId: string;
  event: string;
  purpose: string;
  type: string;
  loopKind: string;
  meaning: MeaningKey;
  direction: "up" | "down";
  word: string;
  what: RunsBetterWhat;
  lookBy: "days" | "outputs";
  days: number;
  outputs: 10 | 20 | 40;
}

export interface MeasureDraft {
  /** null: no measure. */
  kind: MeasureKind | null;
  first: PartDraft;
  then: PartDraft | null;
}

export function blankPart(over: Partial<PartDraft> = {}): PartDraft {
  return {
    kind: "used",
    counts: "none",
    noneReason: "",
    connectionId: "",
    event: "",
    purpose: "",
    type: "",
    loopKind: "",
    meaning: "conversions",
    direction: "up",
    word: "",
    what: "errors",
    lookBy: "days",
    days: 14,
    outputs: 20,
    ...over,
  };
}

export function blankMeasure(): MeasureDraft {
  return { kind: null, first: blankPart(), then: null };
}

function partOfMeasure(p: Exclude<Measure, { kind: "done" }> | ThenMeasure): PartDraft {
  const look: Partial<PartDraft> = "days" in p.look ? { lookBy: "days", days: p.look.days } : { lookBy: "outputs", outputs: p.look.outputs as 10 | 20 | 40 };
  if (p.kind === "runs_better") return blankPart({ kind: "runs_better", what: p.what, ...look });
  if (p.kind === "moves") return blankPart({ kind: "moves", meaning: p.meaning, direction: p.direction, word: p.word ?? "", ...look });
  const c = p.counts;
  const counts: Partial<PartDraft> =
    "none" in c
      ? { counts: "none", noneReason: c.none }
      : "purpose" in c
        ? { counts: "purpose", purpose: c.purpose }
        : "type" in c
          ? { counts: "type", type: c.type }
          : "loopKind" in c
            ? { counts: "loopKind", loopKind: c.loopKind }
            : { counts: "event", connectionId: c.productEvent.connectionId, event: c.productEvent.event };
  return blankPart({ kind: "used", ...counts, ...look });
}

/** A kept measure as the picker edits it. */
export function draftOfMeasure(m: Measure | null): MeasureDraft {
  if (!m) return blankMeasure();
  if (m.kind === "done") return { kind: "done", first: blankPart(), then: null };
  return { kind: m.kind, first: partOfMeasure(m), then: m.then ? partOfMeasure(m.then) : null };
}

/** A measure as Vizzy suggested it (a request's shape), as the picker edits it: Edit then add starts from it. */
export function draftOfMeasureInput(m: MeasureInput | null | undefined): MeasureDraft {
  if (!m) return blankMeasure();
  if (m.kind === "done") return { kind: "done", first: blankPart(), then: null };
  const part = (p: ThenInput): ThenMeasure => (p.kind === "moves" ? { ...p, direction: p.direction ?? startingDirection(p.meaning) } : p) as ThenMeasure;
  const { then, ...first } = m;
  return { kind: m.kind, first: partOfMeasure(part(first as ThenInput)), then: then ? partOfMeasure(part(then)) : null };
}

function lookOf(p: PartDraft): Look {
  return p.lookBy === "outputs" ? { outputs: p.outputs } : { days: Math.round(p.days) };
}

function partInput(p: PartDraft): ThenInput {
  const look = lookOf(p);
  if (p.kind === "runs_better") return { kind: "runs_better", what: p.what, look };
  if (p.kind === "moves") {
    const word = p.meaning === "conversions" ? p.word.trim() : "";
    return { kind: "moves", meaning: p.meaning, direction: p.direction, ...(word ? { word } : {}), look };
  }
  const counts =
    p.counts === "event"
      ? { productEvent: { connectionId: p.connectionId, event: p.event.trim() } }
      : p.counts === "purpose"
        ? { purpose: p.purpose }
        : p.counts === "type"
          ? { type: p.type.trim() }
          : p.counts === "loopKind"
            ? { loopKind: p.loopKind as LoopKind }
            : { none: p.noneReason.trim() };
  return { kind: "used", counts, look } as ThenInput;
}

/** What the measure picker sends: null for no measure. */
export function measureInputOf(d: MeasureDraft): MeasureInput | null {
  if (d.kind === null) return null;
  if (d.kind === "done") return { kind: "done" };
  const first = partInput({ ...d.first, kind: d.kind });
  return { ...first, then: d.then ? partInput(d.then) : null } as MeasureInput;
}

/** What would be refused, in words, before sending. Empty when the measure can be sent. */
export function measureProblems(d: MeasureDraft): string[] {
  if (d.kind === null || d.kind === "done") return [];
  const out: string[] = [];
  const parts = [{ ...d.first, kind: d.kind }, ...(d.then ? [d.then] : [])];
  for (const p of parts) {
    if (p.lookBy === "days" && (!Number.isInteger(p.days) || p.days < 1 || p.days > 365)) out.push("When to look is 1 to 365 days after it's done.");
    if (p.kind === "used" && p.counts === "event") {
      if (!p.connectionId) out.push("Pick the connected product the event comes from.");
      if (!EVENT_NAME_RE.test(p.event.trim()) || p.event.trim().length > 80) out.push("Type the event's name as your product sends it, such as note_created.");
      if (p.lookBy !== "days" || p.days > PRODUCT_EVENT_DAYS) out.push(`A product event is counted over days, at most ${PRODUCT_EVENT_DAYS}, because events are kept for ${PRODUCT_EVENT_DAYS} days.`);
    }
    if (p.kind === "used" && p.counts === "purpose" && !p.purpose) out.push("Pick the purpose it counts.");
    if (p.kind === "used" && p.counts === "type" && !/^[a-z][a-z0-9_]{0,63}$/.test(p.type.trim())) out.push("Type the record type's id, such as work_task.");
    if (p.kind === "used" && p.counts === "loopKind" && !Object.hasOwn(LOOPS, p.loopKind)) out.push("Pick the loop kind it counts.");
    if (p.kind === "moves" && p.word.trim().length > 40) out.push("Your word for it is up to 40 characters.");
  }
  const first = d.first;
  if (d.then && first.lookBy === "days" && d.then.lookBy === "days" && d.then.days <= first.days) out.push("The then looks later than the first measure.");
  return [...new Set(out)];
}

/** A new then: the other kind of win, looking later than the first. */
export function thenFor(d: MeasureDraft): PartDraft {
  const days = Math.min(365, Math.max(d.first.days + 1, 60));
  return blankPart({ kind: d.kind === "moves" ? "used" : "moves", days, meaning: d.first.meaning, word: d.first.word });
}

/** The meanings a Moves a number measure offers: never a provider's number or a date, and the result numbers for everyone. */
export function meaningChoices(o: { operator: boolean; current?: MeaningKey | null }): MeaningKey[] {
  return (Object.keys(MEANINGS) as MeaningKey[]).filter((k) => {
    const m = MEANINGS[k] as { unit: string; better?: string; family?: string };
    if (VENDOR.test(k) || m.unit === "date") return false;
    if (k === o.current) return true;
    return m.family === "result" || (o.operator && m.better !== undefined);
  });
}

/** A meaning picked: its direction starts from what better means for it. */
export function withMeaning(p: PartDraft, meaning: MeaningKey): PartDraft {
  return { ...p, meaning, direction: startingDirection(meaning) };
}

// --- Typed links -------------------------------------------------------------------------------

export type TypedLinkKind = TypedLink["kind"];

export interface TypedLinkDraft {
  kind: TypedLinkKind;
  /** "github:Owner/name". */
  repo: string;
  number: string;
  switchName: string;
  /** "brandId:ideaId". */
  idea: string;
  planTitle: string;
  planUrl: string;
  planVersion: string;
  loopKind: string;
  /** No switch, or no loop line, with why. */
  none: boolean;
  noneReason: string;
}

export function blankTypedLink(kind: TypedLinkKind, repo = ""): TypedLinkDraft {
  return { kind, repo, number: "", switchName: "", idea: "", planTitle: "", planUrl: "", planVersion: "", loopKind: "", none: false, noneReason: "" };
}

/** A switch's name as the code reads it, from what was typed. */
export function switchNameOf(typed: string): string {
  return typed.toUpperCase().replace(/\s+/g, "_").replace(/[^A-Z0-9_]/g, "").slice(0, 80);
}

/** The typed link a draft makes, or why it can't be added yet. */
export function typedLinkOf(d: TypedLinkDraft): { ok: true; link: TypedLink } | { ok: false; problem: string } {
  switch (d.kind) {
    case "pull_request": {
      const at = d.repo.indexOf(":");
      const provider = d.repo.slice(0, at);
      const repo = d.repo.slice(at + 1);
      const n = Number(d.number);
      if ((provider !== "github" && provider !== "gitlab") || !repo) return { ok: false, problem: "Pick a repo your brand selected." };
      if (!/^\d{1,9}$/.test(d.number) || n < 1) return { ok: false, problem: "Type the pull request's number, like 84." };
      return { ok: true, link: { kind: "pull_request", provider, repo, number: n } };
    }
    case "switch":
      if (d.none) return d.noneReason.trim() ? { ok: true, link: { kind: "switch", none: d.noneReason.trim().slice(0, 140) } } : { ok: false, problem: "Say why there is no switch." };
      return SWITCH_NAME.test(d.switchName) ? { ok: true, link: { kind: "switch", name: d.switchName } } : { ok: false, problem: "Type the switch's name: capitals, digits and underscores." };
    case "idea": {
      const at = d.idea.indexOf(":");
      if (at < 1) return { ok: false, problem: "Pick an idea." };
      return { ok: true, link: { kind: "idea", brandId: d.idea.slice(0, at), ideaId: d.idea.slice(at + 1) } };
    }
    case "plan": {
      const title = d.planTitle.trim();
      const url = d.planUrl.trim();
      const version = d.planVersion.trim();
      if (!title) return { ok: false, problem: "Give the plan a title." };
      if (!PlanUrlSchema.safeParse(url).success) return { ok: false, problem: WORK_COPY.planUrlBad };
      return { ok: true, link: { kind: "plan", url, title: title.slice(0, 120), ...(version ? { version: version.slice(0, 40) } : {}) } };
    }
    case "loop_line":
      if (d.none) return d.noneReason.trim() ? { ok: true, link: { kind: "loop_line", none: d.noneReason.trim().slice(0, 140) } } : { ok: false, problem: "Say why there is no loop line." };
      return Object.hasOwn(LOOPS, d.loopKind) ? { ok: true, link: { kind: "loop_line", loopKind: d.loopKind as LoopKind } } : { ok: false, problem: "Pick the loop line it changes." };
  }
}

/** The same link twice: by what it points at. */
export function sameTypedLink(a: TypedLink, b: TypedLink): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "pull_request":
      return b.kind === "pull_request" && a.provider === b.provider && a.repo.toLowerCase() === b.repo.toLowerCase() && a.number === b.number;
    case "switch":
      return b.kind === "switch" && (a.name ?? null) === (b.name ?? null) && (a.none ?? null) === (b.none ?? null);
    case "idea":
      return b.kind === "idea" && a.brandId === b.brandId && a.ideaId === b.ideaId;
    case "plan":
      return b.kind === "plan" && a.url === b.url && (a.version ?? null) === (b.version ?? null);
    case "loop_line":
      return b.kind === "loop_line" && (a.loopKind ?? null) === (b.loopKind ?? null) && (a.none ?? null) === (b.none ?? null);
  }
}

/** A typed link in words, and what kind of link it is. */
export function typedLinkWords(l: TypedLink, o: { ideaName?: (brandId: string, ideaId: string) => string | undefined } = {}): { label: string; where: string } {
  switch (l.kind) {
    case "pull_request":
      return { label: `#${l.number} in ${l.repo}`, where: "Pull request" };
    case "switch":
      return l.name ? { label: l.name, where: "Switch" } : { label: `No switch: ${l.none}`, where: "Switch" };
    case "idea":
      return { label: o.ideaName?.(l.brandId, l.ideaId) ?? "An idea", where: "Idea" };
    case "plan": {
      let host = "";
      try {
        host = new URL(l.url).hostname;
      } catch {
        host = "";
      }
      return { label: l.title, where: `Plan${l.version ? `, version ${l.version}` : ""}${host ? ` · ${host}` : ""}` };
    }
    case "loop_line":
      return l.loopKind ? { label: l.loopKind, where: "Loop line" } : { label: `No loop line: ${l.none}`, where: "Loop line" };
  }
}

/** Where a typed link opens: a pull request on its host, a plan's page, an idea's Overview. Null for a switch or a loop line. */
export function typedLinkHref(l: TypedLink, sessionBrandId: string): string | null {
  if (l.kind === "plan") return l.url;
  if (l.kind === "pull_request") return l.provider === "github" ? `https://github.com/${l.repo}/pull/${l.number}` : `https://gitlab.com/${l.repo}/-/merge_requests/${l.number}`;
  if (l.kind === "idea") return l.brandId === sessionBrandId ? `/admin/launches/${encodeURIComponent(l.ideaId)}` : null;
  return null;
}

// --- Free links --------------------------------------------------------------------------------

/** A pasted link, or why it can't be kept. */
export function freeLinkOf(url: string, label: string): { ok: true; link: WorkLink } | { ok: false; problem: string } {
  const u = url.trim();
  const l = label.trim().replace(/\s+/g, " ").slice(0, 120);
  const parsed = WorkLinkSchema.safeParse({ url: u, ...(l ? { label: l } : {}) });
  return parsed.success ? { ok: true, link: parsed.data } : { ok: false, problem: WORK_COPY.linkUrlBad };
}

/** A free link's words: its label, or its host and path. */
export function freeLinkWords(l: WorkLink): { label: string; where: string } {
  let host = "";
  let path = "";
  try {
    const u = new URL(l.url);
    host = u.hostname.replace(/^www\./, "");
    path = u.pathname === "/" ? "" : u.pathname;
  } catch {
    host = l.url;
  }
  return { label: l.label || `${host}${path}`.slice(0, 120), where: l.label ? `Link · ${host}` : "Link" };
}

// --- Checks ------------------------------------------------------------------------------------

export type CheckPick = "tomorrow" | "week" | "two" | "pick";

export interface CheckDraft {
  kind: "none" | "date" | "after_task";
  pick: CheckPick;
  /** YYYY-MM-DD, for Pick a date. */
  day: string;
  time: string;
  afterRef: number | null;
  note: string;
}

export function blankCheck(): CheckDraft {
  return { kind: "none", pick: "tomorrow", day: "", time: "08:00", afterRef: null, note: "" };
}

/** The day a quick pick means, from today in the brand's zone. */
export function dayOfPick(pick: CheckPick, today: string, picked: string): string {
  if (pick === "tomorrow") return addDaysToKey(today, 1);
  if (pick === "week") return addDaysToKey(today, 7);
  if (pick === "two") return addDaysToKey(today, 14);
  return picked;
}

/** What a check draft sends: null for no check, or undefined when it isn't complete yet. */
export function checkInputOf(d: CheckDraft, today: string): CheckInput | null | undefined {
  const note = d.note.trim().slice(0, 280);
  if (d.kind === "none") return null;
  if (d.kind === "after_task") return d.afterRef ? { kind: "after_task", ref: d.afterRef, ...(note ? { note } : {}) } : undefined;
  const day = dayOfPick(d.pick, today, d.day);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(d.time) && d.time !== "08:00" ? d.time : undefined;
  return { kind: "date", day, ...(time ? { time } : {}), ...(note ? { note } : {}) };
}

// --- The Log box -------------------------------------------------------------------------------

/** "Pricing page: copy done" is the workstream Pricing page with the note copy done. */
export function logLineOf(text: string): { workstream: string; note: string } | null {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return null;
  const at = t.indexOf(":");
  const workstream = (at >= 0 ? t.slice(0, at) : t).trim().slice(0, 80);
  const note = (at >= 0 ? t.slice(at + 1) : "").trim().slice(0, 280);
  return workstream ? { workstream, note } : null;
}
