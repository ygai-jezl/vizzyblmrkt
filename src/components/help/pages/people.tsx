import { H1, H2, Lead, P, UL } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Checks, Messages, Meta, NextPage, Open, Steps } from "@/components/help/blocks";
import { isOneViewEnabled } from "@/lib/audience/flags";

export default function PeopleHelp() {
  // One People list (AUDIENCE_ONE_VIEW_ENABLED) in place of the Product users tab.
  const oneView = isOneViewEnabled();
  return (
    <article>
      <H1>One person&apos;s view</H1>
      <Lead>Everything YouGrow knows about one of your product&apos;s users: their steps, their emails and their journeys.</Lead>
      <Meta items={["1 minute", "Anyone on your team", "Whenever you need it"]} />

      <BeforeAndUnlocks
        before={
          <>
            <li>
              A <Open href="/help/connect-your-product">connected product</Open> that has sent a sign-up
            </li>
          </>
        }
        unlocks={
          <>
            <li>Seeing why someone did or didn&apos;t get an email</li>
            <li>Sending a test user&apos;s next email now</li>
          </>
        }
      />

      <H2 id="open">Open someone&apos;s page</H2>
      {oneView ? (
        <Steps>
          <li>
            Open <Open href="/admin/crm">Audience</Open>. The <strong>People</strong> tab lists everyone.
          </li>
          <li>
            Pick your product at the top, then a stage such as <strong>Stuck</strong> or <strong>Quiet</strong>, or search
            by name or email.
          </li>
          <li>
            Click their row. Their page shows each launch they joined too, and each product they use has a part like the
            one below. See <Open href="/help/your-audience">Your audience</Open>.
          </li>
        </Steps>
      ) : (
        <Steps>
          <li>
            Open <Open href="/admin/crm">Audience</Open> and choose the <strong>Product users</strong> tab.
          </li>
          <li>
            Search by name or email, or filter by stage, such as <strong>Stuck</strong> or <strong>Quiet</strong>.
          </li>
          <li>Click their row.</li>
        </Steps>
      )}

      <H2 id="page">What their page shows</H2>
      <UL>
        <li>
          <strong>Journeys</strong>: what they were sent, and the emails ahead. What&apos;s ahead follows what your product last
          said, so it can change.
        </li>
        <li>
          <strong>Emails</strong>: every email, newest first, marked <strong>Opened</strong> or <strong>Clicked</strong>. A
          skipped email is crossed out, with the reason.
        </li>
        <li>
          <strong>In the product</strong>: their onboarding steps, with the next one marked, and the facts your product sent.
        </li>
        <li>
          <strong>Consent and opt-outs</strong>: whether marketing email is allowed.
        </li>
      </UL>
      <P>
        Opens and clicks need tracking, on the journey&apos;s <strong>Settings</strong> tab. A journey published before
        tracking was on shows &quot;Opens not tracked&quot; until you publish it again.
      </P>
      <P>
        Admins can also press <strong>Run next step now</strong> for a test or shadow entry, <strong>Stop</strong> a journey
        for them, or <strong>Add to a journey</strong>.
      </P>

      <H2 id="check">Check it worked</H2>
      <Checks>
        <li>A test user you just signed up appears {oneView ? "in People, under your product" : "on the Product users tab"}.</li>
        <li>Their page shows the journey they&apos;re in and when their next email goes out.</li>
      </Checks>

      <H2 id="messages">If you see this</H2>
      <Messages
        rows={[
          ["Not in any journey.", <>See <Open href="/help/troubleshooting#nobody-joins">Nobody joins my journey</Open>.</>],
          [
            "No marketing consent",
            "Your product didn't send consent for them, so marketing emails are skipped. Ask your developer to send it at sign-up.",
          ],
          [
            "The journey is in test mode and they aren't a test recipient",
            "Add them under Test users on the journey's Delivery tab, or switch the journey to shadow or live.",
          ],
          ["They had another email in the last 20 hours", "Nothing to fix. Journeys leave 20 hours between emails to one person."],
          [
            "Marketing email needs your postal address (Settings › Sending)",
            <>
              Add it in <Open href="/admin/account">Settings › Sending</Open>.
            </>,
          ],
        ]}
      />

      <NextPage slug="people" />
    </article>
  );
}
