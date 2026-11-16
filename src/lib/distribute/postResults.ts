import type { ScheduledPost } from "@/lib/types/scheduledPost";
import type { MetricRaw, PostPerformance } from "@/lib/types/postPerformance";
import { EXEMPLAR_MIN, MIN_ACTIONS, REACH_FLOOR, harvestable, passesFloors } from "./feedback/reward";
import { PERFORMANCE_WINDOW_MS } from "./feedback/harvest";

/**
 * What a published post's card says about its results (DISTRIBUTE_POST_RESULTS_ENABLED), from
 * the post, its results job (`perf:<post id>`, which the Distribute list hides) and its
 * `post_performance` record. Pure: the page reads the rows, this decides the words.
 */

export interface ResultNumber {
  value: number;
  label: string;
}

export type ResultTag = "example" | "small" | "stopped";

export type PostResultView =
  /** Results job queued, no numbers yet. */
  | { kind: "waiting"; firstAt: string; firstDay: string }
  /** Numbers coming in, read once a day until the post is a week old. */
  | { kind: "collecting"; day: number; finalAt: string; finalDay: string; numbers: ResultNumber[]; series: (number | null)[] }
  /** The week is over. */
  | { kind: "settled"; numbers: ResultNumber[]; tag: ResultTag | null; verdict: string | null }
  /** Results stopped: the account isn't connected, or the platform wouldn't give the numbers. */
  | { kind: "stopped"; message: string; numbers: ResultNumber[] }
  /** A LinkedIn post that went out from a personal profile. */
  | { kind: "personal" };

/** Words the card uses, kept here so tests and the help page can check them. */
export const RESULT_COPY = {
  waitingNote: "YouGrow reads this post's numbers 2 days after posting, then once a day until it is a week old.",
  personal: "No results for posts from a personal profile. Choose a company page in Post as to see them.",
  example: "Example for new drafts",
  exampleNote: "Vizzy shows itself this post as an example when it drafts new ones.",
  small: "Too few views to learn from",
  smallNote: `Vizzy learns from a post once it has ${REACH_FLOOR} impressions and ${MIN_ACTIONS} actions.`,
  stopped: "Stopped",
  comparingSoon: "Compared with your usual once YouGrow has scored it.",
  comparingCold: "Compared with your usual once 3 of your posts here have results.",
  checking: "Unusually high. YouGrow checks it again before using it as an example.",
} as const;

const CHANNEL_NAME: Record<string, string> = { linkedin: "LinkedIn", x: "X" };

/** The daily reads from 48 hours to 7 days: the card's little chart has one bar each. */
const POLL_SLOTS = 6;

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Tue 17 Nov" in UTC, like the time on the card (server and browser agree). */
export function resultDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** A snapshot's numbers in the platform's own words. */
export function resultNumbers(channel: string, raw: MetricRaw): ResultNumber[] {
  if (channel === "x") {
    return [
      { value: raw.impressions, label: plural(raw.impressions, "view", "views") },
      { value: raw.likes, label: plural(raw.likes, "like", "likes") },
      { value: raw.comments, label: plural(raw.comments, "reply", "replies") },
      { value: raw.shares, label: plural(raw.shares, "repost", "reposts") },
    ];
  }
  const out: ResultNumber[] = [
    { value: raw.impressions, label: plural(raw.impressions, "impression", "impressions") },
    { value: raw.likes, label: plural(raw.likes, "reaction", "reactions") },
    { value: raw.comments, label: plural(raw.comments, "comment", "comments") },
    { value: raw.shares, label: plural(raw.shares, "repost", "reposts") },
  ];
  if (typeof raw.clicks === "number") out.push({ value: raw.clicks, label: plural(raw.clicks, "click", "clicks") });
  return out;
}

function stoppedMessage(channel: string, lastError: string | null | undefined): string {
  const name = CHANNEL_NAME[channel] ?? "The platform";
  const reason = lastError ?? "";
  if (reason === "linkedin_not_connected") {
    return "YouGrow couldn't read this post's numbers because your LinkedIn page isn't connected. Reconnect it in Settings › Integrations so your next posts get results.";
  }
  if (reason === "x_not_connected") {
    return "YouGrow couldn't read this post's numbers because your X account isn't connected. Reconnect it in Settings › Integrations so your next posts get results.";
  }
  if (reason === "social_disabled") return "YouGrow couldn't read this post's numbers while posting to social accounts is off.";
  if (reason === "no_snapshot") return `${name} gave no numbers for this post.`;
  if (/^perf_metrics:li_api_404/.test(reason) || /^perf_metrics:.*not_found/.test(reason)) {
    return `${name} no longer has this post, so YouGrow stopped reading its numbers.`;
  }
  return `${name} wouldn't give this post's numbers, so YouGrow stopped reading them.`;
}

function verdictFor(record: PostPerformance): { tag: ResultTag | null; verdict: string | null } {
  const m = record.measurement;
  if (!m) return { tag: null, verdict: null };
  if (!passesFloors(m.metrics)) return { tag: "small", verdict: RESULT_COPY.smallNote };
  const reward = record.reward;
  if (record.rewardStatus !== "scored" || !reward) return { tag: null, verdict: RESULT_COPY.comparingSoon };
  const name = CHANNEL_NAME[record.channel] ?? record.channel;
  if (reward.tier === "cold") return { tag: null, verdict: RESULT_COPY.comparingCold };
  if (reward.tier === "quarantined") return { tag: null, verdict: RESULT_COPY.checking };
  if (reward.tier === "below") return { tag: null, verdict: `Below your usual for ${name}.` };
  if (harvestable(reward.tier) && reward.R_final >= EXEMPLAR_MIN) {
    return { tag: "example", verdict: `Above your usual for ${name}. ${RESULT_COPY.exampleNote}` };
  }
  return { tag: null, verdict: reward.z >= 1 ? `Above your usual for ${name}.` : `About your usual for ${name}.` };
}

/** Whether a LinkedIn post went out from a person, not a company page. */
function isPersonalLinkedIn(post: ScheduledPost): boolean {
  const author = post.publishedRef?.authorUrn;
  return post.channel === "linkedin" && typeof author === "string" && !author.startsWith("urn:li:organization:");
}

/**
 * The card's results, or null when it shows none (not published, not LinkedIn or X, or
 * published before results were collected).
 */
export function postResultView(input: {
  post: ScheduledPost;
  job: ScheduledPost | null;
  record: PostPerformance | null;
}): PostResultView | null {
  const { post, job, record } = input;
  if (post.status !== "done" || !post.publishedRef) return null;
  if (post.channel !== "linkedin" && post.channel !== "x") return null;
  if (!job) return isPersonalLinkedIn(post) ? { kind: "personal" } : null;
  if (job.lastError === "closed_loop_disabled") return null;

  const snapshots = record?.snapshots ?? [];
  const latest = snapshots[snapshots.length - 1] ?? null;
  const latestNumbers = latest ? resultNumbers(post.channel, latest.raw) : [];

  if (job.status === "failed") {
    return { kind: "stopped", message: stoppedMessage(post.channel, job.lastError), numbers: latestNumbers };
  }
  if (job.status === "done") {
    if (record?.measurement) {
      return { kind: "settled", numbers: resultNumbers(post.channel, record.measurement.metrics), ...verdictFor(record) };
    }
    if (latest && !job.lastError?.startsWith("perf_metrics:")) {
      return { kind: "settled", numbers: latestNumbers, tag: null, verdict: null };
    }
    return { kind: "stopped", message: stoppedMessage(post.channel, job.lastError), numbers: latestNumbers };
  }
  // pending or processing: waiting for the first read, or between daily reads.
  if (!latest) return { kind: "waiting", firstAt: job.scheduledAt, firstDay: resultDay(job.scheduledAt) };
  const publishedMs = Date.parse(record?.publishedAt ?? job.createdAt);
  const finalAt = Number.isFinite(publishedMs)
    ? new Date(publishedMs + PERFORMANCE_WINDOW_MS).toISOString()
    : job.scheduledAt;
  const day = Math.min(7, Math.max(1, Math.floor(latest.ageHours / 24)));
  const series: (number | null)[] = Array.from({ length: POLL_SLOTS }, () => null);
  for (const s of snapshots) {
    const slot = Math.min(POLL_SLOTS - 1, Math.max(0, Math.floor(s.ageHours / 24) - 2));
    series[slot] = s.raw.impressions;
  }
  return { kind: "collecting", day, finalAt, finalDay: resultDay(finalAt), numbers: latestNumbers, series };
}
