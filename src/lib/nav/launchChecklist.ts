/**
 * A launch's Overview checklist (nav v2 phase 4): the five things a launch does,
 * in order, from publishing the waitlist to inviting it into the product. Pure —
 * the Overview page gathers the inputs.
 */

export interface LaunchChecklistInput {
  campaignId: string;
  signups: number;
  /** Where the waitlist is embedded on the brand's own site, if anywhere. */
  embeddedAt?: string | null;
  welcomeLive: boolean;
  spotsPerReferral: number;
  newslettersSent: number;
  /** Present when invites are switched on. */
  invites?: { lockText: string | null; invited: number; signedUp: number } | null;
}

export interface LaunchChecklistStep {
  key: "publish" | "welcome" | "referral" | "content" | "invite";
  label: string;
  detail: string;
  done: boolean;
  href: string;
}

const n = (x: number) => x.toLocaleString("en-GB");
const hostOf = (url: string) => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

export function launchChecklist(input: LaunchChecklistInput): LaunchChecklistStep[] {
  const base = `/admin/launches/${input.campaignId}`;
  const steps: LaunchChecklistStep[] = [
    {
      key: "publish",
      label: "Publish your waitlist",
      detail: input.embeddedAt
        ? `Embedded on ${hostOf(input.embeddedAt)}`
        : input.signups > 0
          ? `${n(input.signups)} ${input.signups === 1 ? "person has" : "people have"} joined`
          : "Share the hosted page or embed the widget on your site",
      done: input.signups > 0 || !!input.embeddedAt,
      href: `${base}/widget`,
    },
    {
      key: "welcome",
      label: "Turn on the welcome email",
      detail: input.welcomeLive ? "Welcome & nurture is live" : "Greet everyone who joins, automatically",
      done: input.welcomeLive,
      href: `${base}/journey`,
    },
    {
      key: "referral",
      label: "Offer a referral reward",
      detail:
        input.spotsPerReferral > 0
          ? `Skip ${n(input.spotsPerReferral)} ${input.spotsPerReferral === 1 ? "place" : "places"} per friend`
          : "Move people up the list when they refer friends",
      done: input.spotsPerReferral > 0,
      href: `${base}/settings`,
    },
    {
      key: "content",
      label: "Grow the list with content",
      detail:
        input.newslettersSent > 0
          ? `${n(input.newslettersSent)} newsletter${input.newslettersSent === 1 ? "" : "s"} sent to this waitlist`
          : "Send a newsletter to this waitlist from a content programme",
      done: input.newslettersSent > 0,
      href: "/admin/workspace",
    },
  ];
  if (input.invites) {
    const { lockText, invited, signedUp } = input.invites;
    steps.push({
      key: "invite",
      label: "Invite your waitlist when the product is ready",
      detail: invited > 0 ? `${n(invited)} invited · ${n(signedUp)} signed up` : (lockText ?? "Your product is ready for them"),
      done: invited > 0,
      href: lockText && invited === 0 ? "/admin/products" : `${base}/invites`,
    });
  }
  return steps;
}
