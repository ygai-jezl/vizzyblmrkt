import { num, type Tile } from "@/lib/nav/homeTiles";

/**
 * The four Insights tiles (nav v2 phase 4). Pure. Each falls back to "—" when its
 * numbers are unknown, and says what it's measured over.
 */

export interface InsightsTileInput {
  signupsThisWeek: number | null;
  signupsLastWeek: number | null;
  emails: { sends: number | null; opens: number | null };
  sources: { content: number; referral: number; total: number; basis: "bigquery" | "recent_signups" | "none" };
  /** With a live production product: activated / active users. */
  activation: { activated: number; users: number } | null;
  verified: { verified: number; total: number } | null;
}

const pct = (n: number, of: number) => (of > 0 ? `${Math.round((100 * n) / of)}%` : "—");

export function insightsTiles(i: InsightsTileInput): Tile[] {
  const delta =
    i.signupsThisWeek != null && i.signupsLastWeek != null
      ? i.signupsThisWeek - i.signupsLastWeek
      : null;
  const signups: Tile = {
    label: "Signups this week",
    value: num(i.signupsThisWeek),
    hint: delta == null ? "last 7 days" : `${delta >= 0 ? "+" : "−"}${num(Math.abs(delta))} on the week before`,
  };
  const emails: Tile = {
    label: "Email opens",
    value: i.emails.sends != null && i.emails.opens != null && i.emails.sends > 0 ? pct(i.emails.opens, i.emails.sends) : "—",
    hint: "all sends, last 7 days",
  };
  const fromContent: Tile =
    i.sources.basis === "none"
      ? { label: "Signups from content", value: "—", hint: "last 30 days" }
      : i.sources.content > 0 || i.sources.referral === 0
        ? { label: "Signups from content", value: num(i.sources.content), hint: "last 30 days, estimated from links" }
        : { label: "Referral share", value: pct(i.sources.referral, i.sources.total), hint: "of signups, last 30 days" };
  const conversion: Tile = i.activation
    ? {
        label: "Activation rate",
        value: pct(i.activation.activated, i.activation.users),
        hint: `${num(i.activation.activated)} of ${num(i.activation.users)} product users`,
      }
    : { label: "Verified", value: i.verified ? pct(i.verified.verified, i.verified.total) : "—", hint: "confirmed their email" };
  return [signups, emails, fromContent, conversion];
}
