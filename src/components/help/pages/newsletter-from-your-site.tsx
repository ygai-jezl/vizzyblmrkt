import { Code, H1, H2, Lead, P, Pairs } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Checks, Messages, Meta, NextPage, Open, Steps, Warning, WhoGetsWhichEmails } from "@/components/help/blocks";
import { isIdeasEnabled, isIdeaWordsEnabled } from "@/lib/ideas/flags";
import type { HelpBodyProps } from "@/lib/help/pages";
import { ideaWord } from "@/lib/nav/terms";

const CALL = `curl https://YOUR-YOUGROW/api/v2/signups \\
  -u "$YOUGROW_KEY_ID:$YOUGROW_SECRET" \\
  -H "Content-Type: application/json" \\
  -d '{"email":"sam@example.com","locale":"en-GB","source":"blog/first-post"}'`;

/**
 * Shown only while LAUNCH_SITE_SIGNUPS_ENABLED is on (src/lib/help/pages.ts). With ideas on
 * (`ideas`) the newsletter's launch is ticked Just a list; with ideas in the words (`ideaWords`) it is
 * a waitlist just for the newsletter, and launches are called ideas. "This launch is archived, so it
 * takes no new sign-ups." is the public API's own message: piece K renames the API.
 */
export default function NewsletterFromYourSiteHelp({ ideas = isIdeasEnabled(), ideaWords = isIdeaWordsEnabled() }: HelpBodyProps = {}) {
  const w = ideaWord(ideaWords);
  // The newsletter's own list: a launch of its own, or a waitlist of its own while launches are called ideas.
  const list = ideaWords ? "waitlist" : "launch";
  return (
    <article>
      <H1>Newsletter from your own site</H1>
      <Lead>
        Keep your own sign-up box. Your server adds each email to {ideaWords ? "a waitlist just for the newsletter" : "a newsletter launch"},
        and YouGrow confirms it, welcomes them and sends the weekly newsletter.
      </Lead>
      <Meta items={["About 20 minutes", "Admins, plus your developer", "Once per newsletter"]} />

      <BeforeAndUnlocks
        before={
          <>
            <li>
              <Open href="/help/email-sending">Email sending</Open> set up, with your privacy policy link
            </li>
            <li>Someone who can change your site&apos;s server code</li>
          </>
        }
        unlocks={
          <>
            <li>Sign-ups from your own box, each confirmed by email</li>
            <li>A welcome email, then the weekly newsletter</li>
            <li>Unsubscribes handled for you</li>
          </>
        }
      />

      {ideaWords ? (
        <Warning>
          Use a waitlist just for the newsletter. Each idea has one journey and everyone who joins it gets that journey, so
          newsletter sign-ups added to an idea&apos;s waitlist would get that idea&apos;s welcome emails.
        </Warning>
      ) : (
        <Warning>
          Use a launch just for the newsletter. Each launch has one journey and everyone who joins it gets that journey, so
          newsletter sign-ups added to your waitlist launch would get your waitlist&apos;s welcome emails.
        </Warning>
      )}

      <H2 id="who-gets-what">Who gets which emails</H2>
      <WhoGetsWhichEmails ideaWords={ideaWords} />
      <P>
        {ideaWords ? "So a newsletter list is a waitlist of its own, made as an idea and ticked Just a list." : "So a newsletter list is a launch."}{" "}
        People your app sends through the API never get the newsletter.
      </P>

      <H2 id="launch">Make the newsletter {list}</H2>
      <Steps>
        <li>
          Open <Open href="/admin/launches">{w.Many}</Open> and press <strong>New {w.one}</strong>.
        </li>
        <li>
          Type {ideaWords ? "an" : "a"} <strong>{w.One} name</strong>, such as &quot;Acme newsletter&quot;. The confirmation
          email names it.
        </li>
        <li>
          Tick <strong>Require email verification (double opt-in)</strong>, so anyone who finds the {w.own} hosted
          page confirms too.
        </li>
        <li>
          Press <strong>Create {w.one}</strong>.
        </li>
        {ideas ? (
          <li>
            On the Idea card, tick <strong>Just a list</strong>, so it shows no status and stays out of comparisons and of In
            more than one {w.one}.
          </li>
        ) : null}
        <li>
          On its <strong>Settings</strong> tab, set <strong>Spots skipped per referral</strong> to 0 and tick{" "}
          <strong>Hide signup counts on the page</strong>. Press <strong>Save changes</strong>.
        </li>
      </Steps>

      <H2 id="journey">Set up the newsletter journey</H2>
      <Steps>
        <li>
          Open the {w.own} <strong>Emails</strong> tab. Next to <strong>Welcome &amp; nurture</strong>, press{" "}
          <strong>Set it up</strong>.
        </li>
        <li>
          Write a short welcome to the newsletter on the <strong>Content</strong> tab, and add it as an{" "}
          <strong>Email</strong> on the <strong>Canvas</strong> tab.
        </li>
        <li>
          On the <strong>Exit</strong> step, tick <strong>Then add them to the weekly newsletter</strong>.
        </li>
        <li>
          Press <strong>Save draft</strong>, then <strong>Publish</strong>.
        </li>
      </Steps>
      <P>People who confirm before you publish join the journey when you first publish it.</P>

      <H2 id="key">Create the site key</H2>
      <Steps>
        <li>
          On the {w.own} <strong>Page &amp; widget</strong> tab, choose <strong>Your own form</strong>.
        </li>
        <li>
          Press <strong>Create site key</strong>.
        </li>
        <li>Copy the key id and the secret into your server&apos;s secret manager. The secret is shown only once.</li>
        <li>
          Tick <strong>I&apos;ve stored the secret somewhere safe</strong> and press <strong>Done</strong>.
        </li>
        <li>
          Under <strong>After someone confirms</strong>, type your thank-you page&apos;s address in{" "}
          <strong>Send them to</strong> and press <strong>Save</strong>. Leave it blank to show a &quot;You&apos;re
          subscribed&quot; page.
        </li>
      </Steps>
      <P>
        The key can only add sign-ups to this {w.one}, and it can&apos;t read anyone. Lost the secret? Press{" "}
        <strong>Rotate secret</strong>: you get a new one, and the old one keeps working for 24 hours.{" "}
        <strong>Revoke key</strong> stops the key within a minute.
      </P>

      <H2 id="call">Send each sign-up from your server</H2>
      <P>
        When someone submits your box, your server makes one call with the key. Never make it from the page itself: the
        secret must stay on your server.
      </P>
      <Code title="The call">{CALL}</Code>
      <Pairs
        head={["Reply", "What it means"]}
        rows={[
          ["202 confirmation_sent", "The confirmation email is on its way."],
          ["200 already_confirmed", "They're already on the list. Nothing was sent."],
          ["200 not_sent, recently_sent", "A confirmation went to this address in the last day."],
          ["200 not_sent, blocked", "Email to this address bounced or was reported as spam, so it's never emailed."],
          ["200 not_sent, removed", `Someone took them off the ${list}.`],
        ]}
      />
      <P>
        Show your visitor the same &quot;Check your inbox to confirm&quot; message whatever the reply, so your box never
        shows who is subscribed. Keep a honeypot field or a captcha on your box too: YouGrow limits each key to 60 calls a
        minute and one confirmation per address a day, but bots still fill in forms. Every field and error is in{" "}
        <Open href="/developers/site-signups">Sign-ups from your site</Open>.
      </P>

      <H2 id="readers">What your readers see</H2>
      <Steps>
        <li>Your box tells them to check their inbox.</li>
        <li>An email from your address asks them to confirm.</li>
        <li>
          The link opens a page with a <strong>Confirm subscription</strong> button. Opening the link does nothing on its
          own, so email scanners that open links can&apos;t confirm for them.
        </li>
        <li>They land on your thank-you page, and the newsletter journey&apos;s welcome email follows.</li>
      </Steps>
      <P>
        Someone who unsubscribed before gets the confirmation too. The page tells them that confirming turns all your
        emails back on for them, because an unsubscribe covers your whole brand.
      </P>

      <H2 id="weekly">Send the weekly newsletter</H2>
      <P>
        Write a Newsletter hub, then on your programme&apos;s Overview press <strong>Send this week&apos;s newsletter</strong>.
        It offers the {list} with a site key first. The steps are in{" "}
        <Open href="/help/write-and-schedule#newsletter">Write and schedule</Open>.
      </P>

      <H2 id="unsubscribes">Unsubscribes</H2>
      <P>
        Every email has an unsubscribe link, and YouGrow handles it: that person gets none of your emails after that.
        YouGrow doesn&apos;t tell your server, so don&apos;t keep a second mailing list of these people.
      </P>

      <H2 id="check">Check it worked</H2>
      <Checks>
        <li>Send the call with your own email. It answers 202.</li>
        <li>
          The confirmation email arrives, and <strong>Confirm subscription</strong> takes you to your thank-you page.
        </li>
        <li>The welcome email arrives.</li>
        <li>
          On <strong>Page &amp; widget</strong>, <strong>Your own form</strong> shows when the key was last used and one
          sign-up from your site this week.
        </li>
      </Checks>

      <H2 id="messages">If you see this</H2>
      <Messages
        rows={[
          [
            "Sign-ups from your site aren't turned on for this YouGrow.",
            "Whoever runs your YouGrow needs to turn on LAUNCH_SITE_SIGNUPS_ENABLED.",
          ],
          [
            "Use HTTP Basic auth: your site key id as the username, its secret as the password.",
            "The key id or secret is wrong, or the key was revoked. Check what your server sends, or create a new key.",
          ],
          ["This launch is archived, so it takes no new sign-ups.", `Use a ${list} that isn't archived.`],
          [
            "The confirmation email couldn't be sent. Try again shortly.",
            <>
              Call again in a minute. If it keeps happening, check <Open href="/help/email-sending">Email sending</Open>.
            </>,
          ],
          [
            "Keys can't be made on this YouGrow yet. Whoever runs it needs to set CONNECT_SECRET_ENC_KEY.",
            "Ask whoever runs your YouGrow to add it.",
          ],
          ["Use a full https address, like https://example.com/thanks.", "Send them to takes an https address only."],
        ]}
      />

      <NextPage slug="newsletter-from-your-site" ideaWords={ideaWords} />
    </article>
  );
}
