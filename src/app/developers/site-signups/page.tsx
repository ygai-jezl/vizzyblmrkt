import Link from "next/link";
import { notFound } from "next/navigation";
import { C, Code, Fields, H1, H2, Lead, Note, OL, P, UL } from "@/components/developers/Doc";
import { WhoGetsWhichEmails } from "@/components/help/blocks";
import { docsOrigin } from "@/lib/developers/flags";
import { isSiteSignupsEnabled } from "@/lib/waitlist/siteFlags";
import { SITE_SIGNUP_LIMITS, SITE_SIGNUPS_PATH } from "@/lib/waitlist/siteSignupContract";

/** Served (and listed) only while LAUNCH_SITE_SIGNUPS_ENABLED is on. */
export default function SiteSignupsDocs() {
  if (!isSiteSignupsEnabled()) notFound();
  const url = `${docsOrigin()}${SITE_SIGNUPS_PATH}`;
  const kb = SITE_SIGNUP_LIMITS.maxBodyBytes / 1024;
  return (
    <article>
      <H1>Sign-ups from your site</H1>
      <Lead>
        Keep your own sign-up box. When someone submits it, your server sends their email to YouGrow with the launch&apos;s
        site key. YouGrow confirms the address by email, then the person joins the launch like anyone else: its journey, its
        broadcasts and its weekly newsletter.
      </Lead>
      <Note>
        <strong>Newsletter or app user?</strong> People you send to <Link href="/developers/users">API v2 users</Link> get
        onboarding journeys only, never broadcasts or the weekly newsletter. A newsletter list is a launch, filled from your
        box with this call.
      </Note>

      <H2 id="when">Who gets which emails</H2>
      <WhoGetsWhichEmails />

      <H2 id="setup">Before you start</H2>
      <OL>
        <li>
          In YouGrow, make a launch for the newsletter and publish its journey, with the weekly newsletter step on its Exit.
          The steps are in <Link href="/help/newsletter-from-your-site">Newsletter from your own site</Link>.
        </li>
        <li>
          On the launch&apos;s <strong>Page &amp; widget</strong> tab, choose <strong>Your own form</strong> and press{" "}
          <strong>Create site key</strong>. You get a <strong>key id</strong> (<C>ygl_…</C>) and a <strong>secret</strong>{" "}
          (<C>ygls_…</C>, shown once). Store both in your server&apos;s secret manager.
        </li>
        <li>
          Optional: set <strong>Send them to</strong>, the page people land on after confirming.
        </li>
      </OL>

      <H2 id="add">Add a sign-up</H2>
      <P>
        <C>POST {SITE_SIGNUPS_PATH}</C> with HTTP Basic auth: the key id as the username and the secret as the password. The
        launch comes from the key. Server to server only: never put the secret in a page or an app.
      </P>
      <Code title="curl">{`curl ${url} \\
  -u "$YOUGROW_KEY_ID:$YOUGROW_SECRET" \\
  -H "Content-Type: application/json" \\
  -d '{"email":"sam@example.com","locale":"en-GB","source":"blog/first-post"}'`}</Code>
      <Code title="Node (fetch)">{`const res = await fetch("${url}", {
  method: "POST",
  headers: {
    Authorization: "Basic " + Buffer.from(\`\${process.env.YOUGROW_KEY_ID}:\${process.env.YOUGROW_SECRET}\`).toString("base64"),
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ email, locale: "en-GB", source: "blog/first-post" }),
});
// Whatever it answers, tell your visitor: "Check your inbox to confirm."`}</Code>

      <H2 id="fields">Fields</H2>
      <Fields
        rows={[
          ["email", "string", "Required. The address to confirm and subscribe."],
          ["firstName", "string", "Optional. Used in the greeting."],
          ["locale", "string", "Optional, e.g. en-GB. Their emails use it when the launch offers that language."],
          ["source", "string", "Optional, up to 200 characters. Where on your site they signed up, e.g. blog/first-post."],
        ]}
      />
      <P>Any other field is refused with a 400.</P>

      <H2 id="responses">Responses</H2>
      <Fields
        head={["Status", "Body", "What it means"]}
        rows={[
          ["202", "confirmation_sent", "The confirmation email is on its way."],
          ["200", "already_confirmed", "They're already on the list. Nothing was sent."],
          ["200", "not_sent: recently_sent", "A confirmation went to this address in the last day."],
          ["200", "not_sent: blocked", "Email to this address bounced or was reported as spam. It's never emailed."],
          ["200", "not_sent: removed", "Someone took them off the launch."],
          ["400", "invalid", "A field is wrong: fields lists each problem. Fix it; don't retry as it is."],
          ["401", "unauthorized", "The key id or secret is wrong, or the key was revoked."],
          ["404", "site_signups_disabled", "Sign-ups from your site aren't turned on for this YouGrow."],
          ["409", "launch_closed", "The launch is archived."],
          ["413", "body_too_large", `The body is over ${kb} KB.`],
          ["429", "rate_limited", "Over the limit. Wait Retry-After seconds."],
          ["503", "email_unavailable", "The confirmation couldn't be sent. Retry after Retry-After."],
        ]}
      />
      <P>Every call is safe to repeat: the same email on the same launch is one sign-up, and one email a day at most.</P>

      <H2 id="next">What happens next</H2>
      <OL>
        <li>YouGrow emails the person from the brand&apos;s address, asking them to confirm.</li>
        <li>
          The link opens a page with a <strong>Confirm subscription</strong> button. Opening the link changes nothing, so
          email scanners can&apos;t confirm for anyone.
        </li>
        <li>Once they press it, they go to your Send them to page and join the launch&apos;s journey.</li>
        <li>The journey&apos;s weekly step puts them on the weekly newsletter.</li>
      </OL>
      <P>
        Unsubscribes are handled in YouGrow. No webhook tells your server about these people, so don&apos;t keep a second
        mailing list of them. Someone who unsubscribed before can sign up again: confirming lifts their unsubscribe. A
        bounced address or a spam report is never lifted.
      </P>

      <H2 id="limits">Limits</H2>
      <UL>
        <li>
          {SITE_SIGNUP_LIMITS.perMinute} calls a minute and {SITE_SIGNUP_LIMITS.perHour.toLocaleString("en-GB")} an hour, per
          key.
        </li>
        <li>{kb} KB per call.</li>
        <li>One confirmation email per address per launch a day.</li>
      </UL>

      <H2 id="keys">Keys</H2>
      <UL>
        <li>One key per launch. It can only add sign-ups to that launch, and it can&apos;t read anyone.</li>
        <li>
          <strong>Rotate secret</strong> gives a new secret; the old one keeps working for 24 hours, so you can switch
          without missing sign-ups.
        </li>
        <li>
          <strong>Revoke key</strong> stops it within a minute. A product&apos;s API key never works here, and a site key never
          works on API v2.
        </li>
      </UL>

      <H2 id="practice">Good practice</H2>
      <UL>
        <li>Show your visitor the same &quot;Check your inbox to confirm&quot; message whatever the reply.</li>
        <li>Keep a honeypot field or a captcha on your box, and limit how often one visitor can submit it.</li>
        <li>Retry a 429 or a 503 after Retry-After, and a network error with backoff.</li>
      </UL>
    </article>
  );
}
