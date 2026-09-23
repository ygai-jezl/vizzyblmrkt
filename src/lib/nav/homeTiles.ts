import type { GrowthSignals, StageKey } from "./growth";
import type { WeekCounts } from "./growthSignals";

/**
 * The four metric tiles on Home (nav v2 phase 2), chosen for the stage the brand
 * is in: signups while launching, content while growing, the connection while
 * launching the product, journeys once retaining. Unknown values show "—".
 */

export interface Tile {
  label: string;
  value: string;
  hint: string;
}

type Signals = GrowthSignals & { lastEventAt: string | null; catalogSteps: number };

const num = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("en-GB"));

/** "4 min ago", "3 h ago", "2 days ago". */
export function ago(iso: string | null, now: Date): string {
  if (!iso) return "Never";
  const ms = now.getTime() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "—";
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return "Just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function openRate(week: WeekCounts): string {
  if (week.emailsSent == null || week.emailsOpened == null) return "—";
  if (week.emailsSent === 0) return "—";
  return `${Math.round((100 * week.emailsOpened) / week.emailsSent)}%`;
}

export function homeTiles(stage: StageKey | null, s: Signals, week: WeekCounts, now: Date): Tile[] {
  const signups: Tile = { label: "Signups", value: num(s.signups), hint: "verified and unverified" };
  const thisWeek: Tile = { label: "New this week", value: num(week.signups), hint: "signups, last 7 days" };
  const emails: Tile = { label: "Emails sent", value: num(week.emailsSent), hint: "last 7 days" };
  switch (stage) {
    case "launch":
      return [signups, thisWeek, { label: "Launches", value: num(s.activeLaunches), hint: "collecting signups" }, emails];
    case "grow":
      return [
        signups,
        thisWeek,
        { label: "Posts scheduled", value: num(s.postsScheduled), hint: "sent to Distribute" },
        { label: "Newsletters sent", value: num(s.newslettersSent), hint: "to your waitlist" },
      ];
    case "product":
      return [
        signups,
        { label: "Products connected", value: num(s.products), hint: "not counting sandboxes" },
        { label: "Onboarding steps", value: num(s.catalogSteps), hint: "in your catalog" },
        { label: "Last event", value: ago(s.lastEventAt, now), hint: "from your product" },
      ];
    default:
      return [
        { label: "Live journeys", value: num(week.liveJourneys), hint: "sending to real users" },
        { label: "People in journeys", value: num(week.peopleInJourneys), hint: "active right now" },
        emails,
        { label: "Open rate", value: openRate(week), hint: "of emails sent, last 7 days" },
      ];
  }
}
