import { channelLabel } from "@/lib/content/channels";
import { splitIntoTweets, tweetLength, X_MAX_CHARS } from "@/lib/distribute/preview/x";
import { truncateSeeMore } from "@/lib/distribute/preview/linkedin";
import { truncateCaption } from "@/lib/distribute/preview/instagram";

/**
 * Platform-native WYSIWYG previews — approximate how a post renders on each
 * network (X thread + 280 count, LinkedIn "…see more", Instagram caption + media).
 * Presentational only; the boundary rules live in src/lib/distribute/preview/*.
 */

const CARD = "rounded-xl border border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-950";
const AVATAR = "shrink-0 rounded-full bg-neutral-200 dark:bg-neutral-800";

function EmptyPreview() {
  return <div className={`${CARD} p-3 text-xs text-neutral-400`}>No content to preview.</div>;
}

export function XPreview({ body }: { body: string }) {
  const parts = splitIntoTweets(body);
  if (!parts.length) return <EmptyPreview />;
  return (
    <div className="space-y-2">
      {parts.map((p, i) => (
        <div key={i} className={`${CARD} p-3`}>
          <div className="flex items-center gap-2">
            <div className={`${AVATAR} h-8 w-8`} />
            <div className="text-xs leading-tight">
              <div className="font-semibold text-neutral-800 dark:text-neutral-200">Your account</div>
              <div className="text-neutral-500">@handle</div>
            </div>
          </div>
          <p className="mt-2 whitespace-pre-wrap text-sm text-neutral-900 dark:text-neutral-100">{p}</p>
          <div className="mt-2 text-[11px] text-neutral-400">
            {parts.length > 1 ? `${i + 1}/${parts.length} · ` : ""}
            {tweetLength(p)}/{X_MAX_CHARS}
          </div>
        </div>
      ))}
    </div>
  );
}

export function LinkedInPreview({ body }: { body: string }) {
  if (!body.trim()) return <EmptyPreview />;
  const { visible, truncated } = truncateSeeMore(body);
  return (
    <div className={`${CARD} p-3`}>
      <div className="flex items-center gap-2">
        <div className={`${AVATAR} h-9 w-9`} />
        <div className="text-xs leading-tight">
          <div className="font-semibold text-neutral-800 dark:text-neutral-200">Your name</div>
          <div className="text-neutral-500">Your headline · now</div>
        </div>
      </div>
      <p className="mt-2 whitespace-pre-wrap text-sm text-neutral-900 dark:text-neutral-100">
        {visible}
        {truncated ? <span className="text-neutral-500"> …see more</span> : null}
      </p>
    </div>
  );
}

export function InstagramPreview({ body }: { body: string }) {
  if (!body.trim()) return <EmptyPreview />;
  const { visible, truncated } = truncateCaption(body);
  return (
    <div className={`${CARD} overflow-hidden`}>
      <div className="flex items-center gap-2 p-2">
        <div className={`${AVATAR} h-7 w-7`} />
        <div className="text-xs font-semibold text-neutral-800 dark:text-neutral-200">your.handle</div>
      </div>
      <div className="flex aspect-square items-center justify-center bg-neutral-100 text-xs text-neutral-400 dark:bg-neutral-900">
        Media
      </div>
      <p className="p-2 text-sm text-neutral-900 dark:text-neutral-100">
        <span className="font-semibold">your.handle</span> {visible}
        {truncated ? <span className="text-neutral-500"> … more</span> : null}
      </p>
    </div>
  );
}

export function GenericPreview({ body, channel }: { body: string; channel: string }) {
  return (
    <div className={`${CARD} p-3`}>
      <div className="mb-1 text-[11px] uppercase tracking-wide text-neutral-400">
        {channelLabel(channel)}
      </div>
      <p className="whitespace-pre-wrap text-sm text-neutral-900 dark:text-neutral-100">
        {body || <span className="text-neutral-400">No content to preview.</span>}
      </p>
    </div>
  );
}

/** Dispatch to the channel-native preview; unknown channels fall back to Generic. */
export function ChannelPreview({ channel, body }: { channel: string; body: string }) {
  switch (channel) {
    case "x":
      return <XPreview body={body} />;
    case "linkedin":
      return <LinkedInPreview body={body} />;
    case "instagram":
      return <InstagramPreview body={body} />;
    default:
      return <GenericPreview body={body} channel={channel} />;
  }
}
