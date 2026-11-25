import { forTenant } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { Campaign } from "@/lib/types/campaign";
import type { Contact } from "@/lib/types/contact";
import { MANY_LAUNCHES_TAG } from "./list";

/**
 * People after Just a list moves (LAUNCH_IDEAS_ENABLED). Ticking or unticking it can change only
 * whether someone on that launch is "in more than one launch" (`launches:many`). The PATCH only
 * records that the launch's people are owed a look (`peopleResync`, src/lib/ideas/service.ts); the
 * lifecycle tick's person sweep then flags, a page at a time and from where it stopped, the people
 * whose tag can change, and syncs them in the same tick.
 */

const PAGE = 200;
/** Launches looked at per tick. */
const LAUNCHES_PER_TICK = 5;

/**
 * Whether a person's `launches:many` can change because this launch's Just a list moved, from the
 * tags their last sync wrote. Ticked: only someone who has the tag and is on the launch can lose it.
 * Unticked: only someone on the launch and at least one other, who hasn't the tag yet, can gain it.
 */
export function mayChangeMany(memberOf: readonly string[] | null | undefined, campaignId: string, justAList: boolean): boolean {
  const tags = memberOf ?? [];
  if (!tags.includes(`launch:${campaignId}`)) return false;
  const many = tags.includes(MANY_LAUNCHES_TAG);
  if (justAList) return many;
  return !many && tags.filter((t) => t.startsWith("launch:") && t !== "launch:any").length >= 2;
}

export interface LaunchPeopleDeps {
  db?: FirestoreLike;
  now: () => number;
  deadlineMs: number;
  pageSize?: number;
}

/**
 * Flag the people of each launch owed a look, within the tick's time. Ticked, it reads the people
 * with `launches:many` (fewer than a newsletter's list); unticked, the launch's own people. Only one
 * array-contains fits in a query, so the other half of the check is done here. Returns how many
 * people it flagged.
 */
export async function flagLaunchPeople(ctx: TenantContext, deps: LaunchPeopleDeps): Promise<number> {
  const repo = forTenant(ctx, deps.db);
  const owed = await repo.campaigns.find({ where: [["peopleResync.owed", "==", true]], limit: LAUNCHES_PER_TICK });
  let flagged = 0;
  for (const launch of owed) {
    if (deps.now() >= deps.deadlineMs) break;
    flagged += await flagOne(ctx, launch, deps);
  }
  return flagged;
}

async function flagOne(ctx: TenantContext, launch: Campaign, deps: LaunchPeopleDeps): Promise<number> {
  const repo = forTenant(ctx, deps.db);
  const owed = launch.peopleResync!;
  const justAList = !!launch.idea?.justAList;
  const tag = justAList ? MANY_LAUNCHES_TAG : `launch:${launch.id}`;
  const pageSize = deps.pageSize ?? PAGE;
  let cursor = owed.cursor;
  let done = false;
  let flagged = 0;
  while (!done && deps.now() < deps.deadlineMs) {
    const page: Contact[] = await repo.contacts.find({
      where: [["memberOf", "array-contains", tag]],
      orderBy: [["sortKey", "desc"]],
      limit: pageSize,
      ...(cursor ? { startAfter: [cursor] } : {}),
    });
    const move = page.filter((p) => !p.needsSync && mayChangeMany(p.memberOf, launch.id, justAList));
    await Promise.all(move.map((p) => repo.contacts.update(p.id, { needsSync: true })));
    flagged += move.length;
    const last = page.at(-1)?.sortKey ?? null;
    done = page.length < pageSize || !last;
    cursor = done ? null : last;
  }
  if (!done && cursor === owed.cursor) return flagged;
  // Where it got to, unless Just a list moved again meanwhile: then the next tick starts over.
  await repo.campaigns.claim(launch.id, (current) =>
    current.peopleResync?.since === owed.since ? { peopleResync: done ? null : { ...owed, cursor } } : null,
  );
  return flagged;
}
