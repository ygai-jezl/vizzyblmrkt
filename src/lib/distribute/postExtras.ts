import { forTenant, readPostPerformanceMany } from "@/lib/tenant";
import type { FirestoreLike, TenantContext } from "@/lib/tenant/types";
import type { ScheduledPost } from "@/lib/types/scheduledPost";
import { postPerformanceDocId } from "@/lib/types/postPerformance";
import { wordDiff, wordsChanged, type DiffSegment } from "@/lib/content/wordDiff";
import { postResultView, type PostResultView } from "./postResults";

/**
 * What the Distribute page adds to each post's card: its results and what the person changed
 * from Vizzy's draft. Read on the server, sent to the browser as props. Server only.
 */

export interface DraftChangeView {
  /** False: posted (or scheduled) exactly as Vizzy wrote it. */
  changed: boolean;
  words: number;
  segments: DiffSegment[];
}

export interface PostExtras {
  result?: PostResultView | null;
  draft?: DraftChangeView | null;
}

/** The longest text the diff is worked out for (a post is far shorter). */
const MAX_DIFF_CHARS = 6000;

/** How many published posts get their results read on one page load, newest first. */
const RESULTS_LIMIT = 50;

/** What the person changed from Vizzy's draft, or null when no draft was kept. */
export function draftChangeView(post: Pick<ScheduledPost, "aiBody" | "body">): DraftChangeView | null {
  const ai = post.aiBody;
  if (!ai) return null;
  if (ai.trim() === post.body.trim()) return { changed: false, words: 0, segments: [] };
  const segments = wordDiff(ai.slice(0, MAX_DIFF_CHARS), post.body.slice(0, MAX_DIFF_CHARS));
  const words = wordsChanged(segments);
  return words ? { changed: true, words, segments } : { changed: false, words: 0, segments: [] };
}

const hasResults = (p: ScheduledPost) =>
  p.status === "done" && Boolean(p.publishedRef) && (p.channel === "linkedin" || p.channel === "x");

/**
 * Each post's extras, keyed by post id. `results` reads the newest published posts' results
 * jobs and records; `drafts` works out the changes from the posts themselves (no reads).
 */
export async function loadPostExtras(
  ctx: TenantContext,
  posts: readonly ScheduledPost[],
  opts: { results: boolean; drafts: boolean },
  db?: FirestoreLike,
): Promise<Record<string, PostExtras>> {
  const out: Record<string, PostExtras> = {};
  if (opts.drafts) {
    for (const p of posts) {
      const draft = draftChangeView(p);
      if (draft) out[p.id] = { ...out[p.id], draft };
    }
  }
  if (!opts.results) return out;
  const published = posts
    .filter(hasResults)
    .sort((a, b) => (b.publishedRef?.publishedAt ?? "").localeCompare(a.publishedRef?.publishedAt ?? ""))
    .slice(0, RESULTS_LIMIT);
  if (!published.length) return out;
  const repo = forTenant(ctx, db).scheduledPosts;
  const recordId = (p: ScheduledPost) => postPerformanceDocId(ctx.tenantId, p.channel, p.id);
  const [jobs, records] = await Promise.all([
    Promise.all(published.map((p) => repo.getById(`perf:${p.id}`).catch(() => null))),
    readPostPerformanceMany(ctx, published.map(recordId), db).catch(() => new Map()),
  ]);
  published.forEach((post, i) => {
    const job = jobs[i] ?? null;
    const result = postResultView({
      post,
      job: job && job.jobKind === "performance_fetch" ? job : null,
      record: records.get(recordId(post)) ?? null,
    });
    if (result) out[post.id] = { ...out[post.id], result };
  });
  return out;
}
