/**
 * Where a signup came from, for Insights (nav v2 phase 4). Content links aren't
 * tagged automatically yet, so this is an ESTIMATE from UTM tags and the referring
 * site — and says so wherever it's shown. One rule table drives both the in-app
 * classifier and the BigQuery CASE expression, so the two can't drift. Pure.
 */

export type SourceClass = "referral" | "linkedin" | "x" | "newsletter" | "other_content" | "search" | "direct";

interface SourceRule {
  key: Exclude<SourceClass, "direct">;
  label: string;
  /** Counts as "from content" (posts, newsletters, other social). */
  content: boolean;
  /** Substrings of utm_source (lowercase). */
  utmSource?: string[];
  /** Exact utm_medium values (lowercase). */
  utmMedium?: string[];
  /** Referring registrable hosts (the host itself or a subdomain). */
  hosts?: string[];
  /** Came through a friend's referral link. */
  referral?: boolean;
}

/** In priority order: the first rule that matches wins. */
export const SOURCE_RULES: SourceRule[] = [
  { key: "referral", label: "Friend referrals", content: false, referral: true },
  { key: "linkedin", label: "LinkedIn", content: true, utmSource: ["linkedin", "lnkd"], hosts: ["linkedin.com", "lnkd.in"] },
  { key: "x", label: "X", content: true, utmSource: ["twitter", "x.com"], hosts: ["t.co", "twitter.com", "x.com"] },
  {
    key: "newsletter",
    label: "Newsletter",
    content: true,
    utmSource: ["newsletter", "mailchimp", "substack", "beehiiv"],
    utmMedium: ["email", "newsletter"],
  },
  {
    key: "other_content",
    label: "Other social & content",
    content: true,
    utmMedium: ["social", "content", "blog", "organic_social"],
    hosts: ["facebook.com", "instagram.com", "reddit.com", "youtube.com", "medium.com", "substack.com", "threads.net"],
  },
  {
    key: "search",
    label: "Search",
    content: false,
    utmMedium: ["cpc", "ppc", "organic", "search"],
    hosts: ["google.com", "bing.com", "duckduckgo.com", "yahoo.com", "ecosia.org"],
  },
];

export const SOURCE_LABEL: Record<SourceClass, string> = {
  ...(Object.fromEntries(SOURCE_RULES.map((r) => [r.key, r.label])) as Record<Exclude<SourceClass, "direct">, string>),
  direct: "Direct or unknown",
};

export const CONTENT_SOURCES = new Set<SourceClass>(SOURCE_RULES.filter((r) => r.content).map((r) => r.key));

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

const hostMatches = (host: string, allowed: string[]) => allowed.some((h) => host === h || host.endsWith(`.${h}`));

export function classifySignupSource(s: {
  utm?: { source?: string | null; medium?: string | null } | null;
  referrerUrl?: string | null;
  referredBySignupToken?: string | null;
}): SourceClass {
  const source = (s.utm?.source ?? "").toLowerCase();
  const medium = (s.utm?.medium ?? "").toLowerCase();
  const host = hostOf(s.referrerUrl);
  for (const r of SOURCE_RULES) {
    if (r.referral && s.referredBySignupToken) return r.key;
    if (r.utmSource?.some((t) => source.includes(t))) return r.key;
    if (r.utmMedium?.includes(medium) && medium) return r.key;
    if (host && r.hosts && hostMatches(host, r.hosts)) return r.key;
  }
  return "direct";
}

/** Only these characters ever reach the SQL (every token above is a constant). */
const SAFE_TOKEN = /^[a-z0-9._-]+$/;
const reEscape = (t: string) => t.replace(/[.]/g, "\\.");

/**
 * The same rules as a BigQuery CASE over signups_latest (utm_source, utm_medium,
 * referrer_url, referred_by_token). Built only from the constant table above.
 */
export function bqSourceCaseSql(): string {
  const branches: string[] = [];
  for (const r of SOURCE_RULES) {
    const tokens = [...(r.utmSource ?? []), ...(r.utmMedium ?? []), ...(r.hosts ?? [])];
    if (!tokens.every((t) => SAFE_TOKEN.test(t)) || !SAFE_TOKEN.test(r.key)) throw new Error(`unsafe source rule ${r.key}`);
    const conds: string[] = [];
    if (r.referral) conds.push("referred_by_token IS NOT NULL");
    if (r.utmSource?.length) {
      conds.push(`REGEXP_CONTAINS(LOWER(IFNULL(utm_source, '')), r'(${r.utmSource.map(reEscape).join("|")})')`);
    }
    if (r.utmMedium?.length) {
      conds.push(`LOWER(IFNULL(utm_medium, '')) IN (${r.utmMedium.map((m) => `'${m}'`).join(", ")})`);
    }
    if (r.hosts?.length) {
      conds.push(`REGEXP_CONTAINS(LOWER(IFNULL(NET.HOST(referrer_url), '')), r'(^|\\.)(${r.hosts.map(reEscape).join("|")})$')`);
    }
    branches.push(`WHEN ${conds.join(" OR ")} THEN '${r.key}'`);
  }
  return `CASE ${branches.join(" ")} ELSE 'direct' END`;
}
