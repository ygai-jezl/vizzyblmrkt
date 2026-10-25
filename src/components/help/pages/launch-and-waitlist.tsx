import { H1, H2, Lead, P } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Checks, Messages, Meta, NextPage, Open, Steps, Warning, WhoGetsWhichEmails } from "@/components/help/blocks";
import { isSiteSignupsEnabled } from "@/lib/waitlist/siteFlags";

export default function LaunchAndWaitlistHelp() {
  return (
    <article>
      <H1>Launch and waitlist</H1>
      <Lead>Create a waitlist, greet everyone who joins, then share it.</Lead>
      <Meta items={["About 15 minutes", "Admins", "Once per launch"]} />

      <BeforeAndUnlocks
        before={
          <>
            <li>Your brand in YouGrow</li>
            <li>
              <Open href="/help/email-sending">Email sending</Open> set up, so emails come from your own address
            </li>
          </>
        }
        unlocks={
          <>
            <li>A hosted waitlist page, and a widget for your own site</li>
            <li>A welcome email for everyone who joins</li>
            <li>Inviting your waitlist into your product later</li>
          </>
        }
      />

      <Warning>
        Turn on the welcome email before you share your page, so everyone gets it from the start. If people are already on
        the list when you first publish it, YouGrow asks whether they should get it too.
      </Warning>

      <H2 id="create">Create a launch</H2>
      <Steps>
        <li>
          Open <Open href="/admin/launches">Launches</Open> and press <strong>New launch</strong>.
        </li>
        <li>
          Type a <strong>Launch name</strong>. It&apos;s the headline on your waitlist page.
        </li>
        <li>
          Leave <strong>URL slug</strong> blank to make one from the name. Your page lives at /waitlist/ plus the slug, and
          the slug can&apos;t be changed later.
        </li>
        <li>
          Choose the <strong>Required contact detail</strong>. EMAIL suits most launches.
        </li>
        <li>
          Set <strong>Spots skipped per referral</strong>: how far someone moves up for each friend who joins.
        </li>
        <li>
          Tick <strong>Require email verification (double opt-in)</strong> if people should confirm their email first.
        </li>
        <li>
          Press <strong>Create launch</strong>. Your launch opens on its Overview, with a <strong>Launch checklist</strong>.
        </li>
      </Steps>
      <P>
        Only <strong>verified</strong> signups get the welcome email, broadcasts (one-off emails from the Emails tab) and
        invites. With double opt-in on, people are verified once they confirm their email. With it off, everyone is verified
        as soon as they join.
      </P>

      <H2 id="welcome">Turn on the welcome email</H2>
      <P>Every new launch starts with a draft welcome journey. Nothing sends until you publish it.</P>
      <Steps>
        <li>
          Open your launch, then the <strong>Emails</strong> tab.
        </li>
        <li>
          Next to <strong>Welcome &amp; nurture</strong>, press <strong>Set it up</strong>.
        </li>
        <li>
          On the <strong>Content</strong> tab, press <strong>Content pool</strong>. Write the email&apos;s{" "}
          <strong>Subject</strong> and body.
        </li>
        <li>
          On the <strong>Canvas</strong> tab, press <strong>Email</strong>. Under <strong>Sends from</strong>, choose the
          content you wrote.
        </li>
        <li>
          Connect <strong>Trigger</strong> to the email, and the email to <strong>End</strong>. Delete the old line from
          Trigger straight to End.
        </li>
        <li>
          Press <strong>Save draft</strong>, then <strong>Publish</strong>, and confirm.
        </li>
        <li>
          If people are already on the list, YouGrow asks whether they should get it too. Choose{" "}
          <strong>Send to them too</strong> or <strong>Only people who join from now</strong>.
        </li>
      </Steps>
      <P>
        If Publish is refused, the editor lists what to fix above its tabs. Rather have Vizzy write it? Ask Vizzy (⌘J) for
        welcome emails for this launch. Vizzy saves a draft for you to check here, and it shows in Review. It never
        publishes.
      </P>

      <H2 id="share">Share your waitlist</H2>
      <Steps>
        <li>
          Open your launch, then the <strong>Page &amp; widget</strong> tab.
        </li>
        <li>
          To share the hosted page, choose <strong>Hosted</strong> and press <strong>Copy link</strong>. Post it anywhere.
        </li>
        <li>
          To put the form on your own site, choose <strong>Full</strong>, <strong>Mini</strong> or <strong>Docked</strong>.
          Press <strong>Copy</strong> next to <strong>Embed snippet</strong> and paste it into your page.
        </li>
        <li>
          Embedded it? On the launch&apos;s <strong>Settings</strong> tab, paste that page&apos;s full address into{" "}
          <strong>Waitlist URL</strong>, so referral links point to your site. Press <strong>Save changes</strong>.
        </li>
        <li>
          Back on <strong>Page &amp; widget</strong>, open <strong>Social</strong>. Write a <strong>Share message</strong>,
          pick the share buttons people see after joining, and press <strong>Save</strong>.
        </li>
      </Steps>
      <P>
        Your referral reward is <strong>Spots skipped per referral</strong>, under <strong>Gamification</strong> on the
        Settings tab. Keep it above 0 so people move up when friends join.
      </P>

      {isSiteSignupsEnabled() ? (
        <>
          <H2 id="own-form">Use your own sign-up form</H2>
          <P>
            Rather keep your own box than embed ours? On <strong>Page &amp; widget</strong>, choose{" "}
            <strong>Your own form</strong>: your server adds each email with the launch&apos;s site key, and YouGrow sends the
            confirmation. For a newsletter, use a launch just for it. See{" "}
            <Open href="/help/newsletter-from-your-site">Newsletter from your own site</Open>.
          </P>
          <WhoGetsWhichEmails />
        </>
      ) : null}

      <H2 id="check">Check it worked</H2>
      <Checks>
        <li>
          On the Overview, the checklist ticks &quot;Publish your waitlist&quot;, &quot;Turn on the welcome email&quot; and
          &quot;Offer a referral reward&quot;.
        </li>
        <li>
          The <strong>Emails</strong> tab shows <strong>Welcome &amp; nurture</strong> as <strong>Live</strong>.
        </li>
        <li>
          Join from your own hosted page. The welcome email arrives (confirm your email first if double opt-in is on).
        </li>
        <li>
          <strong>Total signups</strong> and <strong>Verified</strong> on the Overview go up.
        </li>
      </Checks>

      <H2 id="messages">If you see this</H2>
      <Messages
        rows={[
          ["Launch name is required.", "Type a Launch name, then press Create launch again."],
          [
            "use lowercase letters, numbers and hyphens",
            "The URL slug can only use lowercase letters, numbers and hyphens. Or leave it blank.",
          ],
          [
            "This launch's emails come from a shared default address until you verify your sending domain.",
            <>
              Verify your domain in <Open href="/help/email-sending">Email sending</Open>. Until then, your welcome and invite
              emails don&apos;t come from you.
            </>,
          ],
          ["Add at least one email.", "The welcome journey has no email yet. Add one on the Canvas tab, or ask Vizzy to draft it."],
          ["Fix the issues listed before publishing.", "Open the list above the tabs, fix each item, then press Publish again."],
          [
            "Until then, your emails come from a shared default address.",
            <>
              Your sending domain isn&apos;t verified yet. See <Open href="/help/email-sending">Email sending</Open>.
            </>,
          ],
        ]}
      />

      <NextPage slug="launch-and-waitlist" />
    </article>
  );
}
