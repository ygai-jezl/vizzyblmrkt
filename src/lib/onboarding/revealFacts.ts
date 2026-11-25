import { REVEALABLE, revealKeysOf, type RevealKey } from "@/lib/nav/reveal";
import { forTenant } from "@/lib/tenant";
import { addSidebarShown, startSidebarReveal } from "@/lib/tenant/control";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { BusinessProfile, SidebarRevealStored } from "@/lib/types/businessProfile";
import { fitSections, hasAnyAnswer } from "./sidebarFit";

/**
 * The data side of the sidebar's Coming up (ONBOARDING_ENABLED): a section with something of the
 * brand's in it always shows, and once shown it's stored, so it never hides again.
 *
 * - Content: any programme, archived ones too.
 * - Products: any product connection, a sandbox or a revoked one too.
 * - Journeys: a live welcome email, or any product journey in any status. A drafted welcome email
 *   doesn't count.
 * - People: any sign-up in any status, or any contact, company, engaged profile or product user.
 * - Insights: People has data, or a post is scheduled, or a newsletter was sent.
 *
 * Every read is a limit 1 find with equality filters only (no composite index), soft, and made only
 * for the sections still waiting. A read that fails leaves its section unknown: it shows, but it
 * isn't stored, so the next check decides.
 */

/** What the growth route already read (loadGrowthSignals and its extras), free. */
export interface RevealSignals {
  anyProgramme: boolean;
  anyConnection: boolean;
  welcomeEmailLive: boolean;
  anyProductJourney: boolean;
  /** Verified and unverified sign-ups; null when the counts failed (the People reads decide). */
  signups: number | null;
  postsScheduled: number;
  newslettersSent: number;
}

export interface RevealFacts {
  /** Sections that hold data: shown and stored. */
  has: RevealKey[];
  /** Sections a failed read couldn't decide: shown, never stored. */
  unknown: RevealKey[];
}

/** The sections the growth signals already show hold data, with no reads. */
export function factsFromSignals(s: RevealSignals): Set<RevealKey> {
  const has = new Set<RevealKey>();
  if (s.anyProgramme) has.add("content");
  if (s.anyConnection) has.add("products");
  if (s.welcomeEmailLive || s.anyProductJourney) has.add("journeys");
  if ((s.signups ?? 0) > 0) has.add("audience");
  if (has.has("audience") || s.postsScheduled > 0 || s.newslettersSent > 0) has.add("insights");
  return has;
}

type Read = () => Promise<readonly unknown[]>;

/** True when any read found a row; null when none did and one failed; false when all found none. */
async function anyOf(reads: readonly Read[]): Promise<boolean | null> {
  const found = await Promise.all(
    reads.map((read) =>
      Promise.resolve()
        .then(read)
        .then(
          (rows) => rows.length > 0,
          () => null,
        ),
    ),
  );
  return found.includes(true) ? true : found.includes(null) ? null : false;
}

const either = (a: boolean | null, b: boolean | null): boolean | null => (a === true || b === true ? true : a === null || b === null ? null : false);

/**
 * Which of `keys` hold data. With `signals` (the growth route), only the People reads are left;
 * without (the welcome's finish), each waiting section is read. A brand finishing the welcome is
 * new, so journeys stored before audiences existed (no `audience`) aren't looked for there; the
 * growth route's signals count them.
 */
export async function loadRevealFacts(
  ctx: TenantContext,
  keys: readonly RevealKey[],
  opts: { signals?: RevealSignals } = {},
  db?: FirestoreLike,
): Promise<RevealFacts> {
  const want = new Set(keys);
  const free = opts.signals ? factsFromSignals(opts.signals) : null;
  const facts = new Map<RevealKey, boolean | null>();
  for (const key of want) if (free?.has(key)) facts.set(key, true);
  const open = (key: RevealKey) => want.has(key) && !facts.has(key);
  if (!want.size || REVEALABLE.every((k) => !open(k))) return collect(facts);

  const repos = forTenant(ctx, db);
  const one = { limit: 1 };
  const people = open("audience") || open("insights")
    ? anyOf([
        () => repos.signups.find(one),
        () => repos.contacts.find(one),
        () => repos.companies.find(one),
        () => repos.socialEngaged.find(one),
        () => repos.productUsers.find(one),
      ])
    : Promise.resolve(false);

  if (free) {
    // The signals read every other fact whole: what they didn't show has no data.
    for (const key of ["content", "products", "journeys"] as const) if (open(key)) facts.set(key, false);
    const peopleHas = await people;
    if (open("audience")) facts.set("audience", peopleHas);
    if (open("insights")) facts.set("insights", peopleHas);
    return collect(facts);
  }

  const [content, products, journeys, posts, peopleHas] = await Promise.all([
    open("content") ? anyOf([() => repos.workspaces.find(one)]) : null,
    open("products") ? anyOf([() => repos.productConnections.find(one)]) : null,
    open("journeys")
      ? anyOf([
          () => repos.journeys.find({ where: [["status", "==", "active"]], limit: 1 }),
          () =>
            repos.lifecycleJourneys.find({
              where: [
                ["connectionId", "==", ""],
                ["status", "==", "active"],
              ],
              limit: 1,
            }),
          () => repos.lifecycleJourneys.find({ where: [["audience.kind", "==", "product"]], limit: 1 }),
        ])
      : null,
    open("insights")
      ? anyOf([
          () => repos.scheduledPosts.find({ where: [["jobKind", "==", "publish"]], limit: 1 }),
          () =>
            repos.broadcasts.find({
              where: [
                ["audienceMode", "==", "weekly"],
                ["status", "==", "sent"],
              ],
              limit: 1,
            }),
        ])
      : null,
    people,
  ]);
  if (open("content")) facts.set("content", content);
  if (open("products")) facts.set("products", products);
  if (open("journeys")) facts.set("journeys", journeys);
  if (open("audience")) facts.set("audience", peopleHas);
  if (open("insights")) facts.set("insights", either(posts, peopleHas));
  return collect(facts);
}

function collect(facts: ReadonlyMap<RevealKey, boolean | null>): RevealFacts {
  return {
    has: REVEALABLE.filter((k) => facts.get(k) === true),
    unknown: REVEALABLE.filter((k) => facts.has(k) && facts.get(k) === null),
  };
}

/**
 * The growth route (every sidebar load and every 5 minutes): the sections this brand shows now.
 * What's stored, what was opened and what fits the answers, plus the waiting sections that hold
 * data. Those are stored, written only when the set grows; unknown ones show and aren't stored.
 */
export async function growSidebarReveal(
  ctx: TenantContext,
  tenant: { sidebarReveal: SidebarRevealStored; businessProfile?: BusinessProfile },
  signals: RevealSignals,
  db?: FirestoreLike,
): Promise<{ shown: RevealKey[] }> {
  const stored = new Set(revealKeysOf([...tenant.sidebarReveal.shown, ...tenant.sidebarReveal.opened.map((o) => o.key)]));
  const fit = fitSections(tenant.businessProfile?.answers ?? {});
  const waiting = REVEALABLE.filter((k) => !stored.has(k) && !fit.includes(k));
  const facts = waiting.length ? await loadRevealFacts(ctx, waiting, { signals }, db) : { has: [], unknown: [] };
  // Fit that isn't stored yet is stored too (an answer changed), so it never hides again.
  const add = [...fit.filter((k) => !stored.has(k)), ...facts.has];
  // A write that fails still shows them now; the next check stores them.
  if (add.length) await addSidebarShown(ctx.tenantId, add, undefined, db).catch(() => null);
  const shown = new Set<RevealKey>([...stored, ...fit, ...facts.has, ...facts.unknown]);
  return { shown: REVEALABLE.filter((k) => shown.has(k)) };
}

/**
 * After the brand's answers were saved (the questions' finish or a pick, a call's Looks right, a
 * chip in Settings). Only the welcome's first finish with answers starts the sidebar's Coming up:
 * `started` to `done`. Skip, Settings alone, and a brand that finished before keep today's sidebar.
 * Later, a changed answer adds what now fits to a brand that has Coming up. Never fails the save.
 */
export async function revealAfterProfileSave(
  ctx: TenantContext,
  saved: { before: BusinessProfile | null; after: BusinessProfile },
  opts: { now?: () => number; db?: FirestoreLike } = {},
): Promise<void> {
  const { before, after } = saved;
  try {
    if (before?.status === "started" && after.status === "done") {
      if (!hasAnyAnswer(after.answers)) return;
      const fit = fitSections(after.answers);
      const facts = await loadRevealFacts(ctx, REVEALABLE.filter((k) => !fit.includes(k)), {}, opts.db);
      const at = new Date((opts.now ?? Date.now)()).toISOString();
      await startSidebarReveal(ctx.tenantId, [...fit, ...facts.has], at, opts.db);
      return;
    }
    if (after.status === "started" || after.rev === before?.rev) return;
    const fit = fitSections(after.answers);
    if (fit.length) await addSidebarShown(ctx.tenantId, fit, undefined, opts.db);
  } catch (err) {
    // The answers are saved; the sidebar shows today's sections until the next save or growth check.
    console.warn("[sidebar] Coming up not updated:", err instanceof Error ? err.message : err);
  }
}
