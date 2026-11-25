/**
 * Why a broadcast or weekly newsletter couldn't send, in plain words, from the
 * code the delivery worker stores (`no_audience_segment_for_launch`,
 * `mailchimp_config:shared_not_configured`, …). Client-safe. `ideas`
 * (useWords().ideas) names a launch an idea; the help page quotes these, so
 * each is written out in both words.
 */
export function broadcastErrorText(code: string | null | undefined, audienceMode?: "launch" | "weekly" | null, ideas = false): string {
  const c = code ?? "";
  if (c === "no_audience_segment_for_launch") {
    if (audienceMode === "weekly") {
      return ideas
        ? "Nobody has joined this idea's weekly newsletter yet, so nothing was sent. People join when they reach the weekly newsletter step of its welcome journey."
        : "Nobody has joined this launch's weekly newsletter yet, so nothing was sent. People join when they reach the weekly newsletter step of its welcome journey.";
    }
    return ideas
      ? "Nobody from this idea is in your Mailchimp audience yet, so nothing was sent. People are added once they verify their email."
      : "Nobody from this launch is in your Mailchimp audience yet, so nothing was sent. People are added once they verify their email.";
  }
  if (c === "mailchimp_config:byo_required_not_configured") return "This brand needs its own Mailchimp account connected before it can send newsletters.";
  if (c === "mailchimp_config:own_key_unreadable") return "This brand's Mailchimp key is saved but can't be unlocked on this YouGrow, so newsletters can't send. Whoever runs it needs to check the key that unlocks it, or save the Mailchimp key again.";
  if (c.startsWith("mailchimp_config:")) return "Mailchimp isn't set up on this YouGrow, so newsletters can't send. Whoever runs it needs to add it.";
  if (c === "launch_archived") return ideas ? "This idea is archived, so nothing was sent." : "This launch is archived, so nothing was sent.";
  if (c === "must_be_future") return "Pick a future date and time.";
  if (c === "not_schedulable") return "That one is already sending or sent.";
  return "Couldn't send it. Please try again.";
}
