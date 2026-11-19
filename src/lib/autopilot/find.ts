import { isBrandMapScaleEnabled } from "@/lib/brandMap/flags";
import { nearestSubjects } from "@/lib/brandMap/embed";
import { parseSubject } from "@/lib/brandMap/records";
import { readBrandMap } from "@/lib/brandMap/store";
import { articlesOnSubject } from "@/lib/competitors/articles";
import { listCompetitors } from "@/lib/competitors/store";
import { searchBrand, type SearchOutcome } from "@/lib/search/query";
import type { SearchKind } from "@/lib/search/types";
import { collectSignal, lookUpQuestion, ownHostsOf, type CollectDeps } from "@/lib/signals/collect";
import { candidatesOf, judgeItems, type JudgeDeps } from "@/lib/signals/judge";
import { getSignal } from "@/lib/signals/store";
import { getTenantById } from "@/lib/tenant";
import { brandMapRecords } from "@/lib/tenant/brandMapRecords";
import type { TenantContext } from "@/lib/tenant/types";
import type { AutopilotRun, TrayItem, Trays } from "@/lib/types/autopilot";
import type { JudgedItem } from "@/lib/types/brandSignal";
import { GIVE_UP_MS } from "@/lib/signals/store";
import type { StepPatch } from "./runs";

/**
 * Finding and sorting what buyers ask for one question (a run's find, waiting and sort steps):
 * Google's People also ask and "people also search for" through a DataForSEO lookup, and the
 * questions competitors' recent articles on the subject answer; then the judge sorts them into
 * three trays: In this article, Another subject, Not for us. Each kept item shows the brand's own
 * closest page, and a competitor's question shows who answers it.
 */

export interface FindDeps extends CollectDeps, Pick<JudgeDeps, "generate" | "configured"> {
  search?: (ctx: TenantContext, query: string, opts: { limit: number }) => Promise<SearchOutcome>;
  judge?: typeof judgeItems;
  subjectsNear?: (ctx: TenantContext, text: string) => Promise<string[]>;
}

/** Questions taken from competitors' articles on the subject, at most. */
const THEIRS = 6;
/** Kept items given a "closest page of yours" (one brand search each). */
const YOU_MARKS = 8;
const OWN_KINDS = new Set<SearchKind>(["article", "newsletter", "ebook", "post", "journey_email", "broadcast", "note", "knowledge"]);
const LOOK_AGAIN_MS = 20_000;

/** The brand map subjects nearest some words, by name (large maps by meaning, small maps all). */
export async function subjectNamesNear(ctx: TenantContext, text: string, deps: FindDeps = {}): Promise<string[]> {
  if (deps.subjectsNear) return deps.subjectsNear(ctx, text);
  const read = await readBrandMap(ctx, deps.db).catch(() => null);
  if (!read || read.state !== "ok") return [];
  if (isBrandMapScaleEnabled() && read.map.moved) {
    const near = await nearestSubjects(ctx, text, { limit: 10, statuses: ["decided"] }, { db: deps.db }).catch(() => []);
    const rows = await brandMapRecords(ctx, deps.db).getMany("sub", near.map((n) => n.ref)).catch(() => []);
    return rows.flatMap((r) => parseSubject(r)?.name ?? []);
  }
  return read.map.subjects.map((s) => s.name).slice(0, 12);
}

/** The find step: ask Google (or reuse a lookup from the last 90 days). Never fails the run. */
export async function findStep(ctx: TenantContext, run: AutopilotRun, deps: FindDeps = {}): Promise<StepPatch> {
  const q = run.question!;
  const got = await lookUpQuestion(ctx, { query: q.text, questionId: q.questionId, subjectId: q.subjectId }, deps).catch(() => null);
  if (!got || !got.ok) return { step: "sort", googleSkipped: got && !got.ok ? got.error : "lookup_failed" };
  if (got.signal.status === "ready") return { step: "sort", signalId: got.signal.id };
  return { step: "waiting", signalId: got.signal.id, nextAt: got.signal.dueAt };
}

/** The waiting step: collect the lookup when it's due; sort without it after half an hour. */
export async function waitingStep(ctx: TenantContext, run: AutopilotRun, deps: FindDeps = {}): Promise<StepPatch> {
  const now = (deps.now ?? (() => new Date()))();
  let sig = run.signalId ? await getSignal(ctx, run.signalId, deps) : null;
  if (sig?.status === "posted" && Date.parse(sig.dueAt) <= now.getTime()) {
    const tenant = await (deps.loadTenant ?? getTenantById)(ctx.tenantId).catch(() => null);
    await collectSignal(ctx, sig, await ownHostsOf(ctx, tenant, deps), deps);
    sig = await getSignal(ctx, sig.id, deps);
  }
  if (!sig || sig.status === "ready") return { step: "sort" };
  if (sig.status === "failed") return { step: "sort", googleSkipped: sig.error ?? "lookup_failed" };
  if (now.getTime() - Date.parse(run.createdAt) >= GIVE_UP_MS) return { step: "sort", googleSkipped: "not_ready_in_time" };
  return { nextAt: new Date(Math.max(now.getTime() + LOOK_AGAIN_MS, Date.parse(sig.dueAt))).toISOString() };
}

/** Everything found, once each: Google's first, then competitors' questions. */
export async function foundItems(ctx: TenantContext, run: AutopilotRun, deps: FindDeps = {}): Promise<Array<Pick<JudgedItem, "text" | "kind"> & { them: string | null }>> {
  const q = run.question!;
  const sig = run.signalId ? await getSignal(ctx, run.signalId, deps) : null;
  const google = sig?.status === "ready" ? candidatesOf(sig).map((i) => ({ ...i, them: null })) : [];
  const [articles, competitors] = await Promise.all([
    articlesOnSubject(ctx, q.subjectId, { db: deps.db }).catch(() => []),
    listCompetitors(ctx, { db: deps.db }).catch(() => []),
  ]);
  const names = new Map(competitors.map((c) => [c.id, c.name] as const));
  const seen = new Set([q.text.toLowerCase(), ...google.map((g) => g.text.toLowerCase())]);
  const theirs: Array<Pick<JudgedItem, "text" | "kind"> & { them: string | null }> = [];
  for (const a of articles) {
    const t = (a.question ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    theirs.push({ text: t, kind: "theirs", them: names.get(a.competitorId) ?? null });
    if (theirs.length >= THEIRS) break;
  }
  return [...google, ...theirs];
}

/** The sort step: the judge's trays, with the brand's closest page on what goes in the article. */
export async function sortStep(ctx: TenantContext, run: AutopilotRun, deps: FindDeps = {}): Promise<StepPatch> {
  const q = run.question!;
  const items = await foundItems(ctx, run, deps);
  const subjects = await subjectNamesNear(ctx, `${q.subjectName}\n${q.text}`, deps).catch(() => [] as string[]);
  const verdicts = await (deps.judge ?? judgeItems)(ctx, { question: q.text, subjectId: q.subjectId, items: items.map(({ text, kind }) => ({ text, kind })), subjects }, deps);
  // The judge didn't answer: try this step again (the run fails after its tries).
  if (!verdicts) return { error: "judge_failed" };
  const trays: Trays = { use: [], other: [], drop: [] };
  verdicts.forEach((v, i) => {
    const item: TrayItem = { text: v.text, kind: v.kind, reason: v.reason, subject: v.subject ?? null, you: null, them: items[i]?.them ?? null };
    trays[v.verdict].push(item);
  });
  const search = deps.search ?? ((c, t, o) => searchBrand(c, t, o));
  for (const item of trays.use.slice(0, YOU_MARKS)) {
    const found = await search(ctx, item.text, { limit: 3 }).catch(() => null);
    const own = found?.ok ? found.result.hits.find((h) => OWN_KINDS.has(h.kind)) : undefined;
    item.you = own ? own.title.slice(0, 120) : null;
  }
  return { step: run.mode === "draft" ? "create" : "sorted", trays, error: null };
}
