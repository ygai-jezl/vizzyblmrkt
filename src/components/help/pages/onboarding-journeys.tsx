import { H1, H2, H3, Lead, P, UL } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Checks, Messages, Meta, NextPage, Open, Steps, Warning } from "@/components/help/blocks";

export default function OnboardingJourneysHelp() {
  return (
    <article>
      <H1>Build an onboarding journey</H1>
      <Lead>Email each new user about what they have and haven&apos;t done yet. Test it on real people, then switch it to live.</Lead>
      <Meta items={["About 20 minutes, then a few days of testing", "Admins", "Once per product"]} />

      <BeforeAndUnlocks
        before={
          <>
            <li>
              <Open href="/help/connect-your-product">Your product connected</Open>, with onboarding steps in its catalog
            </li>
            <li>
              To go live: <Open href="/help/email-sending">email sending</Open> set up
            </li>
          </>
        }
        unlocks={
          <>
            <li>A welcome, reminders and tips for every new user</li>
            <li>Journeys that follow on from another, or start when someone goes quiet</li>
          </>
        }
      />

      <Warning>
        Publish it before your developer starts sending sign-ups. A journey only takes people who signed up in the last 72 hours.
        To reach further back, raise <strong>Ignore events older than (hours)</strong> on its <strong>Settings</strong> tab, up
        to 720.
      </Warning>

      <H2 id="build">Build it from the 7-day template</H2>
      <Steps>
        <li>
          Open <Open href="/admin/lifecycle">Journeys</Open> and press <strong>New journey</strong>. A product journey needs a
          connected product or a sandbox first.
        </li>
        <li>
          If it asks who enters it, choose <strong>Users of a connected product</strong>.
        </li>
        <li>
          Pick your <strong>Product</strong>. Keep <strong>Start from</strong> on{" "}
          <strong>7-day onboarding (splits on progress)</strong>.
        </li>
        <li>
          Press <strong>Create draft</strong>.
        </li>
      </Steps>
      <P>
        The template sends a welcome 15 minutes after sign-up. Then it emails the next business morning, and on about days 3, 5
        and 7. People who have finished onboarding get an education email. The rest get a reminder.
      </P>
      <P>
        Change the words on the <strong>Content</strong> tab and the timing on the <strong>Canvas</strong> tab. Press{" "}
        <strong>Save draft</strong> as you go. <strong>Timeline preview</strong> shows when each email would arrive.
      </P>

      <H2 id="test">Publish it in test mode</H2>
      <P>A new journey starts in test mode: only the test users you list join, and they get real emails.</P>
      <Steps>
        <li>
          On the <strong>Delivery</strong> tab, under <strong>Test users</strong>, add your own user id or email address in your
          app, one per line. A sandbox&apos;s test users are already there.
        </li>
        <li>
          Press <strong>Save delivery settings</strong>.
        </li>
        <li>
          Press <strong>Publish</strong> and confirm. If it lists things to fix before publishing, fix those first.
        </li>
        <li>
          Sign up to your app as a test user. Or enter someone by hand with <strong>Enrol someone now</strong> on the{" "}
          <strong>People</strong> tab.
        </li>
      </Steps>
      <P>
        Then try <strong>Shadow</strong> on the <strong>Delivery</strong> tab. Everyone moves through the journey, but every
        email goes to your <strong>Shadow inbox</strong> instead, saying who it was for.
      </P>

      <H2 id="live">Switch it to live</H2>
      <P>Live sends real emails to everyone who signs up. First, check that:</P>
      <UL>
        <li>
          Your From address is on a verified sending domain, in <Open href="/admin/account">Settings › Sending</Open>.
        </li>
        <li>Your postal address is saved there too. Marketing emails are held without one.</li>
        <li>Your app sends consent with each sign-up. Without it, only the welcome email goes out.</li>
      </UL>
      <Steps>
        <li>
          On the <strong>Delivery</strong> tab, choose <strong>Live</strong>.
        </li>
        <li>
          Press <strong>Save delivery settings</strong>.
        </li>
      </Steps>
      <P>
        People already in the journey keep the mode they started in. Changed an email? Press <strong>Publish</strong> again.
        People already in it stay on their version.
      </P>

      <H2 id="more">Follow-on journeys and quiet users</H2>
      <P>
        These two start without a sign-up. If you can&apos;t see their options, whoever runs your YouGrow hasn&apos;t switched
        them on.
      </P>
      <H3>A journey that continues from another</H3>
      <Steps>
        <li>
          Press <strong>New journey</strong> and pick the first journey under <strong>Starts after another journey?</strong>
        </li>
        <li>
          Keep <strong>Follow-on sequence (4 emails, 3 days apart)</strong> and press <strong>Create draft</strong>.
        </li>
      </Steps>
      <P>
        People join when they reach the end of the first journey, and its waits count from then. Nobody finishes the first
        journey until it&apos;s live.
      </P>
      <H3>A journey for people who go quiet</H3>
      <P>Your catalog needs a date fact, such as when someone was last active. Your developer sends it.</P>
      <Steps>
        <li>
          On the journey&apos;s <strong>Settings</strong> tab, under <strong>Starts when</strong>, pick the date in{" "}
          <strong>Or when a date passes</strong>.
        </li>
        <li>
          Set <strong>Start when it was at least (days ago)</strong>. The default is 14.
        </li>
        <li>
          Leave <strong>Stop when the date moves on</strong> ticked, so people who come back get no more of it.
        </li>
      </Steps>
      <P>
        A daily check from 07:00 UTC lets people in. <strong>Check now</strong> on the <strong>People</strong> tab runs it at
        once. In a sandbox, try it with <strong>Went quiet 15 days ago</strong> on the <strong>Sandbox</strong> tab.
      </P>

      <H2 id="check">Check it worked</H2>
      <Checks>
        <li>Under the journey&apos;s name, the badges say active and test, then live.</li>
        <li>
          The <strong>People</strong> tab lists everyone who has joined.
        </li>
        <li>
          On <Open href="/admin">Home</Open>, Onboard &amp; retain says &quot;In test mode&quot;, then &quot;Live&quot;.
        </li>
      </Checks>

      <H2 id="messages">If you see this</H2>
      <Messages
        rows={[
          [
            "An email shows the onboarding checklist or next step, but this product has no onboarding steps yet.",
            <>
              Add steps with <Open href="/help/connect-your-product#learn">Learn from repo</Open>, then make a new journey from
              the template.
            </>,
          ],
          [
            "Add at least one branch.",
            "The journey was made before your product had steps. Add them, then make a new journey from the template.",
          ],
          ["The journey must be published and active.", "Press Publish. If it's paused, press Resume."],
          [
            "In test mode only listed test users can be enrolled.",
            "Add them under Test users on the Delivery tab, or switch to shadow.",
          ],
          [
            "Live sending needs a From address on a verified sending domain.",
            <>
              Finish <Open href="/help/email-sending">email sending</Open>, then choose Live again.
            </>,
          ],
        ]}
      />

      <NextPage slug="onboarding-journeys" />
    </article>
  );
}
