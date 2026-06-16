/**
 * Canonical social share-platform registry. The single source of truth shared by
 * the admin Social tab, the post-signup ShareSection, the status-check UI, and
 * the campaign-settings schema. Each platform knows how to turn a referral link
 * (`url`) + an already-rendered promotional `message` into a share/intent URL.
 *
 * The `message` is plain text WITHOUT the link — every builder appends the
 * referral link itself (as a `url` param or combined into the text), so the link
 * always appears exactly once regardless of platform and can never be dropped.
 *
 * Text support: Facebook and LinkedIn share dialogs accept a URL only — they pull
 * the title/description from the page's Open Graph tags and ignore caller text.
 * We flag those `supportsText: false` so the admin UI can warn "posts the link
 * only". (Custom Open Graph cards are a deferred follow-up.)
 *
 * No React / server imports here on purpose: this module is pure and unit-tested.
 */

export const SHARE_PLATFORM_IDS = [
  "twitter",
  "whatsapp",
  "telegram",
  "facebook",
  "linkedin",
  "email",
  "reddit",
] as const;

export type SharePlatformId = (typeof SHARE_PLATFORM_IDS)[number];

export interface SharePlatform {
  id: SharePlatformId;
  label: string;
  /** False => the share dialog ignores custom text and posts the link only. */
  supportsText: boolean;
  buildUrl(opts: { url: string; message: string }): string;
}

const enc = encodeURIComponent;

/** Static subject for the mailto: share (the body carries the personalised copy). */
const EMAIL_SUBJECT = "Join me on the waitlist";

export const SHARE_PLATFORMS: readonly SharePlatform[] = [
  {
    id: "twitter",
    label: "X (Twitter)",
    supportsText: true,
    buildUrl: ({ url, message }) =>
      `https://twitter.com/intent/tweet?text=${enc(message)}&url=${enc(url)}`,
  },
  {
    id: "whatsapp",
    label: "WhatsApp",
    supportsText: true,
    // WhatsApp exposes a single `text` field — combine the message and link.
    buildUrl: ({ url, message }) => `https://wa.me/?text=${enc(`${message} ${url}`)}`,
  },
  {
    id: "telegram",
    label: "Telegram",
    supportsText: true,
    buildUrl: ({ url, message }) =>
      `https://t.me/share/url?url=${enc(url)}&text=${enc(message)}`,
  },
  {
    id: "facebook",
    label: "Facebook",
    supportsText: false, // sharer.php ignores custom text; the OG card supplies it
    buildUrl: ({ url }) => `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}`,
  },
  {
    id: "linkedin",
    label: "LinkedIn",
    supportsText: false, // share-offsite accepts the URL only
    buildUrl: ({ url }) =>
      `https://www.linkedin.com/sharing/share-offsite/?url=${enc(url)}`,
  },
  {
    id: "email",
    label: "Email",
    supportsText: true,
    buildUrl: ({ url, message }) =>
      `mailto:?subject=${enc(EMAIL_SUBJECT)}&body=${enc(`${message} ${url}`)}`,
  },
  {
    id: "reddit",
    label: "Reddit",
    supportsText: true,
    buildUrl: ({ url, message }) =>
      `https://www.reddit.com/submit?url=${enc(url)}&title=${enc(message)}`,
  },
];

const SHARE_PLATFORM_BY_ID = Object.fromEntries(
  SHARE_PLATFORMS.map((p) => [p.id, p]),
) as Record<SharePlatformId, SharePlatform>;

export function getSharePlatform(id: SharePlatformId): SharePlatform {
  return SHARE_PLATFORM_BY_ID[id];
}

export function isSharePlatformId(v: unknown): v is SharePlatformId {
  return (
    typeof v === "string" &&
    (SHARE_PLATFORM_IDS as readonly string[]).includes(v)
  );
}

/**
 * Narrow an untrusted list to known platform ids, de-duplicated and returned in
 * the canonical SHARE_PLATFORM_IDS order — so the share row renders consistently
 * no matter what order the admin toggled them on.
 */
export function parseEnabledPlatforms(
  raw: readonly string[] | undefined | null,
): SharePlatformId[] {
  if (!raw) return [];
  const enabled = new Set(raw.filter(isSharePlatformId));
  return SHARE_PLATFORM_IDS.filter((id) => enabled.has(id));
}

/** Build the share/intent URL for one platform. */
export function buildShareUrl(
  id: SharePlatformId,
  opts: { url: string; message: string },
): string {
  return SHARE_PLATFORM_BY_ID[id].buildUrl(opts);
}

/**
 * Default share copy when a campaign hasn't set its own. Deliberately omits the
 * referral link ({{referral_link}}) — every platform appends the link itself, so
 * embedding it here would duplicate it. Uses the same {{token}} vocabulary as the
 * email merge vars (see lib/email/mergeVars.ts), rendered server-side.
 */
export const DEFAULT_SHARE_MESSAGE =
  "I just joined the {{waitlist_name}} waitlist — come join me!";