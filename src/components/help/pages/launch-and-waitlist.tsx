import { H1, H2, Lead, P } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Checks, Messages, Meta, NextPage, Open, Steps, Warning, WhoGetsWhichEmails } from "@/components/help/blocks";
import { isEditModeEmailsEnabled } from "@/lib/content/editor/flags";
import { isSiteSignupsEnabled } from "@/lib/waitlist/siteFlags";
import { isIdeasEnabled, isIdeaWordsEnabled } from "@/lib/ideas/flags";
import { isNavV2Enabled } from "@/lib/nav/flags";
import { ideaWord } from "@/lib/nav/terms";
import { ideaMessages } from "@/lib/ideas/words";
import { isWaitlistAbWinnerEnabled } from "@/lib/lifecycle/waitlist/flags";
import { isResultsChatEnabled } from "@/lib/metrics/flags";
import type { HelpBodyProps } from "@/lib/help/pages";

/**
 * With ideas on (LAUNCH_IDEAS_ENABLED) the page explains a launch's idea, and handing it off; comparing
 * launches and the status filter need the launches list too (nav v2). With ideas in the words
 * (`ideaWords`, isIdeaWordsEnabled()) a launch is called an idea; the slug and anchors stay. The
 * switches are read on the server, so the How to drawer passes them in.
 */
export default function LaunchAndWaitlistHelp({ ideas = isIdeasEnabled(), ideaWords = isIdeaWordsEnabled() }: HelpBodyProps = {}) {
  const compare = ideas && isNavV2Enabled();
  const w = ideaWord(ideaWords);
  const messages = ideaMessages(ideaWords);
  // A server switch: /help and its Markdown copies show the section; the How to drawer leaves it out.
  const abWinner = isWaitlistAbWinnerEnabled();
  return (
    <article>
      <H1>{w.One} and waitlist</H1>
      <Lead>Create a waitlist, greet everyone who joins, then share it.</Lead>
      <Meta items={["About 15 minutes", "Admins", `Once per ${w.one}`]} />

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

      <H2 id="create">Create {w.a}</H2>
      <Steps>
        <li>
          Open <Open href="/admin/launches">{w.Many}</Open> and press <strong>New {w.one}</strong>.
        </li>
        <li>
          Type {ideaWords ? "an" : "a"} <strong>{w.One} name</strong>. It&apos;s the headline on your waitlist page.
        </li>
        {ideas ? (
          <li>
            Admins can also write a <strong>Hypothesis (optional)</strong>: what you expect to happen, and for whom. You can
            change it on the Overview later.
          </li>
        ) : null}
        <li>
          Leave <strong>URL slug</strong> blank to make one from the name. Your page lives at /waitlist/ plus the slug, and
          the slug can&apos;t be changed later.
        </li>
        <li>
          Choose the <strong>Required contact detail</strong>. EMAIL suits most {w.many}.
        </li>
        <li>
          Set <strong>Spots skipped per referral</strong>: how far someone moves up for each friend who joins.
        </li>
        <li>
          Tick <strong>Require email verification (double opt-in)</strong> if people should confirm their email first.
        </li>
        <li>
          Press <strong>Create {w.one}</strong>. Your {w.one} opens on its Overview, with {ideaWords ? "an" : "a"}{" "}
          <strong>{w.One} checklist</strong>.
        </li>
      </Steps>
      <P>
        Only <strong>verified</strong> signups get the welcome email, broadcasts (one-off emails from the Emails tab) and
        invites. With double opt-in on, people are verified once they confirm their email. With it off, everyone is verified
        as soon as they join.
      </P>
      {isEditModeEmailsEnabled() ? (
        <P>
          In a broadcast or a welcome journey email, press <strong>Edit mode</strong> above the <strong>Body</strong> to write
          it the way it will look, with headings, bold, lists and links. Press <strong>Done</strong> to put it back in the email,
          then save the email as usual.
        </P>
      ) : null}

      {ideas ? (
        <>
          <H2 id="idea">Test it as an idea</H2>
          <P>
            {ideaWords ? "Each idea is tested with its own waitlist." : "Each launch tests an idea."} Its Overview starts with
            the Idea card, so your team can see what you expect and how it went.
          </P>
          <Steps>
            <li>
              Open your {w.one}. The <strong>Idea</strong> card is at the top of the Overview.
            </li>
            <li>
              Under <strong>Status</strong>, pick <strong>Exploring</strong>, <strong>Testing</strong>,{" "}
              <strong>Validated</strong>, <strong>Launched</strong>, <strong>Parked</strong> or <strong>Killed</strong>. It saves
              straight away, with your name and the date, for example &quot;Set to Testing by you on 18 Nov.&quot;
            </li>
            <li>
              Write the <strong>Hypothesis</strong> (up to 500 characters) and, as you learn, the <strong>Outcome</strong>{" "}
              (up to 2,000). Press <strong>Save</strong>.
            </li>
          </Steps>
          <P>
            Only admins change the Idea card. Everyone on your team can read it.{" "}
            {ideaWords
              ? "An idea made before statuses came in has none until someone picks one."
              : "A launch made before ideas has no status until someone picks one."}
          </P>
          <P>
            Parked or Killed leaves the waitlist open: people can still join, and its emails still go out. The card asks what
            to do. Press <strong>Keep it open</strong>, or <strong>Also close the waitlist</strong>, which does what{" "}
            <strong>Archive {w.one}</strong> on the Settings tab does: nobody new can join, its emails pause, scheduled emails go
            back to drafts, and it moves to Archived.
          </P>
          <P>
            For a newsletter or sign up list that isn&apos;t an idea, tick <strong>Just a list</strong> on the card. The card
            becomes one line, the {w.one} shows no status, and it&apos;s left out of comparisons and of{" "}
            <Open href="/help/your-audience#list">In more than one {w.one}</Open>. Press <strong>Make it an idea</strong> to undo
            it.
          </P>
        </>
      ) : null}

      <H2 id="welcome">Turn on the welcome email</H2>
      <P>Every new {w.one} starts with a draft welcome journey. Nothing sends until you publish it.</P>
      <Steps>
        <li>
          Open your {w.one}, then the <strong>Emails</strong> tab.
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
        welcome emails for this {w.one}. Vizzy saves a draft for you to check here, and it shows in Review. It never
        publishes.
      </P>

      {abWinner ? (
        <>
          <H2 id="pick-a-winner">Pick the winning email</H2>
          <P>When an email in the welcome journey runs an A/B test, you decide which version wins.</P>
          <Steps>
            <li>
              Open your {w.one}, then the <strong>Analytics</strong> tab.
            </li>
            <li>
              Under <strong>Emails</strong>, open the email sequence. Each email with a test lists its versions with their
              opens and clicks.
            </li>
            <li>
              Once a version has 50 sends, press <strong>Promote</strong> next to it, and confirm.
            </li>
          </Steps>
          <P>
            From then on, everyone who reaches that email gets the winner, in whichever journey editor this {w.one} is
            built. People who already had the email keep the version they got. The email shows{" "}
            <strong>A/B promoted</strong>, with <strong>winner</strong> next to the version you picked.
          </P>
          <P>
            To test that email again, turn <strong>A/B test this email</strong> off and on in the new journey editor, then
            publish: the new test runs and the earlier pick stops applying. In the original editor, press{" "}
            <strong>Start a new test</strong>.
            {isResultsChatEnabled() ? " Ask Vizzy how the emails did, and it says which version of each test won." : null}
          </P>
        </>
      ) : null}

      <H2 id="share">Share your waitlist</H2>
      <Steps>
        <li>
          Open your {w.one}, then the <strong>Page &amp; widget</strong> tab.
        </li>
        <li>
          To share the hosted page, choose <strong>Hosted</strong> and press <strong>Copy link</strong>. Post it anywhere.
        </li>
        <li>
          To put the form on your own site, choose <strong>Full</strong>, <strong>Mini</strong> or <strong>Docked</strong>.
          Press <strong>Copy</strong> next to <strong>Embed snippet</strong> and paste it into your page.
        </li>
        <li>
          Embedded it? On the {w.own} <strong>Settings</strong> tab, paste that page&apos;s full address into{" "}
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
            <strong>Your own form</strong>: your server adds each email with the {w.own} site key, and YouGrow sends the
            confirmation.{" "}
            {ideaWords
              ? "For a newsletter, use a waitlist just for it, and tick Just a list on its Idea card."
              : "For a newsletter, use a launch just for it."}{" "}
            See <Open href="/help/newsletter-from-your-site">Newsletter from your own site</Open>.
          </P>
          <WhoGetsWhichEmails ideaWords={ideaWords} />
        </>
      ) : null}

      {compare ? (
        <>
          <H2 id="compare">Compare {w.many} side by side</H2>
          <Steps>
            <li>
              Open <Open href="/admin/launches">{w.Many}</Open>. Each {w.one} shows its status. Pick a status at the top, such
              as <strong>Testing</strong>, to show only those.
            </li>
            <li>
              Tick 2 to 4 {w.many}, then press <strong>Compare side by side</strong>.
            </li>
            <li>
              Each {w.one} gets a column: its status, hypothesis and outcome, then <strong>Waitlisted</strong>,{" "}
              <strong>Verified</strong>, <strong>Invited</strong>, <strong>Signed up</strong> and <strong>Activated</strong>.
              Each bar is against that {w.own} own waitlist, and the line under it is the share of the step before.
            </li>
          </Steps>
          <P>
            {w.Many} marked Just a list have no box. Press <strong>All {w.many}</strong> to go back.
          </P>
        </>
      ) : null}

      {ideas ? (
        <>
          <H2 id="hand-off">Hand it off to your product</H2>
          <P>Once an idea is built, say which product it became, so the two stay linked.</P>
          <Steps>
            <li>
              On the Idea card, set the status to <strong>Launched</strong>.
            </li>
            <li>
              Under <strong>Hand off to a product</strong>, pick the product. The one your latest invite wave went to is picked
              first. Products come from <Open href="/help/connect-your-product">Connect your product</Open>, and test ones say
              Sandbox.
            </li>
            <li>
              Press <strong>Hand off</strong>. The card says which product, when and who, for example &quot;Handed off to Lumen
              app on 4 Nov by you.&quot;
            </li>
          </Steps>
          <P>
            To change it, pick another product while the status is Launched and press <strong>Hand off</strong> again. Each
            change is kept. The line stays if the status moves on later.
          </P>
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
          ideaWords
            ? ["Idea name is required.", "Type an Idea name, then press Create idea again."]
            : ["Launch name is required.", "Type a Launch name, then press Create launch again."],
          [
            "use lowercase letters, numbers and hyphens",
            "The URL slug can only use lowercase letters, numbers and hyphens. Or leave it blank.",
          ],
          [
            ideaWords
              ? "This idea's emails come from a shared default address until you verify your sending domain."
              : "This launch's emails come from a shared default address until you verify your sending domain.",
            <>
              Verify your domain in <Open href="/help/email-sending">Email sending</Open>. Until then, your welcome and invite
              emails don&apos;t come from you.
            </>,
          ],
          ["Add at least one email.", "The welcome journey has no email yet. Add one on the Canvas tab, or ask Vizzy to draft it."],
          ["Fix the issues listed before publishing.", "Open the list above the tabs, fix each item, then press Publish again."],
          ...(abWinner
            ? ([
                [
                  "Another version already won this test. Reload the page to see it.",
                  "Someone picked the winner of this email after you opened the page. Reload it to see which version won.",
                ],
              ] as Array<[string, string]>)
            : []),
          [
            "Until then, your emails come from a shared default address.",
            <>
              Your sending domain isn&apos;t verified yet. See <Open href="/help/email-sending">Email sending</Open>.
            </>,
          ],
          ...(ideas
            ? ([
                [
                  messages.hypothesisNotSaved,
                  `The ${w.one} was created, but its hypothesis didn't save. Press Open its Overview and write it on the Idea card.`,
                ],
                [messages.closeFailed, "The new status is kept. Press Also close the waitlist again, or archive it from the Settings tab."],
                [messages.notLaunched, "Pick Launched under Status first, then press Hand off."],
                [messages.productGone, "That product was disconnected. Pick another one, or connect it again."],
              ] as Array<[string, string]>)
            : []),
        ]}
      />

      <NextPage slug="launch-and-waitlist" ideaWords={ideaWords} />
    </article>
  );
}
