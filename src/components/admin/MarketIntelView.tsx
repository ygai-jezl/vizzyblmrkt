import { Hash, TrendingUp, Radar } from "lucide-react";
import type { HashtagLeaderboardEntry } from "@/lib/distribute/feedback/hashtags";
import type { TrendingTopic } from "@/lib/types/trendingTopics";

const CHANNEL_LABEL: Record<string, string> = { linkedin: "LinkedIn", x: "X", instagram: "Instagram" };
const MOMENTUM_STYLE: Record<string, string> = {
  rising: "text-emerald-600 dark:text-emerald-400",
  hot: "text-rose-600 dark:text-rose-400",
  fading: "text-neutral-400",
};

function er(composite: number): string {
  return `${(composite * 100).toFixed(1)}% ER`;
}

/**
 * Market Intelligence view (server component): the owned hashtag leaderboard + grounded theme radar.
 * Pure presentational — data is loaded in the page.
 */
export function MarketIntelView({
  leaderboard,
  trends,
}: {
  leaderboard: HashtagLeaderboardEntry[];
  trends: TrendingTopic[];
}) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Market Intelligence</h1>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          What&apos;s working for you, and what&apos;s trending in your space.
        </p>
      </div>

      <section>
        <div className="mb-3 flex items-center gap-2 text-sm font-medium">
          <Hash size={16} className="text-neutral-500" /> Hashtag leaderboard
          <span className="text-xs font-normal text-neutral-400">your top-performing posts by hashtag</span>
        </div>
        {leaderboard.length === 0 ? (
          <div className="rounded-lg border border-dashed border-neutral-200 p-6 text-center text-sm text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
            No hashtag performance yet. Once your published posts settle, your best posts per hashtag
            surface here.
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {leaderboard.map((e) => (
              <div key={e.tag} className="rounded-xl border border-neutral-200 p-3 dark:border-neutral-800">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-medium">#{e.tag}</span>
                  <span className="text-xs text-neutral-400">
                    {e.postCount} posts · {er(e.medianComposite)} median
                  </span>
                </div>
                <ul className="space-y-1.5">
                  {e.topPosts.map((p) => (
                    <li key={p.postId} className="flex items-start justify-between gap-2 text-sm">
                      <span className="min-w-0 flex-1 truncate text-neutral-600 dark:text-neutral-300">
                        <span className="mr-1 text-[11px] text-neutral-400">
                          {CHANNEL_LABEL[p.channel] ?? p.channel}
                        </span>
                        {p.bodyExcerpt || "(post)"}
                      </span>
                      <span className="shrink-0 text-[11px] text-neutral-400">{er(p.composite)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="mb-3 flex items-center gap-2 text-sm font-medium">
          <Radar size={16} className="text-neutral-500" /> Theme radar
          <span className="text-xs font-normal text-neutral-400">trending in your space (grounded research)</span>
        </div>
        {trends.length === 0 ? (
          <div className="rounded-lg border border-dashed border-neutral-200 p-6 text-center text-sm text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
            No trend snapshot yet. Trends refresh periodically once enabled.
          </div>
        ) : (
          <ul className="space-y-2">
            {trends.map((t, i) => (
              <li key={i} className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 font-medium">
                    <TrendingUp size={14} className="text-neutral-400" />
                    {t.label}
                  </span>
                  {t.momentum && (
                    <span className={`text-[11px] font-medium ${MOMENTUM_STYLE[t.momentum] ?? ""}`}>
                      {t.momentum}
                    </span>
                  )}
                </div>
                {t.whyNow && <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-300">{t.whyNow}</p>}
                {t.angle && (
                  <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">Angle: {t.angle}</p>
                )}
                {t.hashtags.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {t.hashtags.map((h) => (
                      <span
                        key={h}
                        className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
                      >
                        #{h}
                      </span>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
