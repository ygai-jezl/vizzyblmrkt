import { H1, H2, Lead, P, UL } from "@/components/developers/Doc";
import { BeforeAndUnlocks, Checks, Messages, Meta, NextPage, Open, Steps } from "@/components/help/blocks";

/** Shown only while AUDIENCE_ONE_VIEW_ENABLED is on (src/lib/help/pages.ts). */
export default function YourAudienceHelp() {
  return (
    <article>
      <H1>Your audience</H1>
      <Lead>
        Everyone you know, in one list: people who joined a launch, people from your own site&apos;s sign-up box, and the
        users of your connected products. One row and one page per person, whatever brought them.
      </Lead>
      <Meta items={["2 minutes", "Anyone on your team; erasing and exporting are for admins", "Whenever you need it"]} />

      <BeforeAndUnlocks
        before={
          <>
            <li>
              A <Open href="/help/launch-and-waitlist">launch</Open> with sign-ups, or a{" "}
              <Open href="/help/connect-your-product">connected product</Open> that has sent its users
            </li>
          </>
        }
        unlocks={
          <>
            <li>Seeing how many people you have, and how many you can email</li>
            <li>One page for each person, with their launches and their product together</li>
            <li>Erasing or exporting a person everywhere at once</li>
          </>
        }
      />

      <H2 id="list">The People list</H2>
      <Steps>
        <li>
          Open <Open href="/admin/crm">Audience</Open>. The <strong>People</strong> tab lists everyone, most recently active
          first, with the total at the bottom.
        </li>
        <li>
          Pick a group at the top: <strong>Everyone</strong>, one of your launches, <strong>From your site</strong>, or one
          of your products. A product also shows its stages: <strong>New</strong>, <strong>Onboarding</strong>,{" "}
          <strong>Stuck</strong>, <strong>Activated</strong> and <strong>Quiet</strong>.
        </li>
        <li>
          Tick <strong>Only people we can email</strong> to leave out anyone who unsubscribed, bounced or never gave
          consent.
        </li>
        <li>Or search everyone by name, email or domain.</li>
      </Steps>
      <P>
        The same email address is the same person, so someone who joined your waitlist and then signed up to your product
        is one row. Someone who only gave a phone number is a person of their own. A sign-up from your own site joins the
        list once they confirm their email.
      </P>

      <H2 id="person">One person&apos;s page</H2>
      <P>Click a row to open everything about them:</P>
      <UL>
        <li>
          <strong>Launches</strong>: each launch they joined, whether they confirmed, their referrals, their invite and their
          waitlist journey.
        </li>
        <li>
          Each <strong>product</strong> they use: their steps, journeys, emails and story, as on{" "}
          <Open href="/help/people">one person&apos;s view</Open>.
        </li>
        <li>
          <strong>Emails from your launches</strong>, and <strong>Consent, in one place</strong>: whether you can email
          them and why not.
        </li>
      </UL>

      <H2 id="stages">How stages are read</H2>
      <P>
        Each product puts its users in a stage with three clocks: New for the first 2 days, Stuck after 7 days on one step,
        Quiet after 14 days without using the product. Change them for one product on its <strong>Settings</strong> tab,
        under <strong>How we read stages</strong>, in{" "}
        <Open href="/admin/products">Products</Open>. Stages move on the next check, within a few minutes.
      </P>

      <H2 id="erase">Export or erase someone</H2>
      <P>
        On their page, an admin can press <strong>Export their data</strong> for a file of everything held about them, or{" "}
        <strong>Erase everywhere</strong>. Erasing deletes their sign-ups on every launch, their user record in every
        product, their journeys and their email history. Their unsubscribe keeps working, without their address. It
        can&apos;t be undone.
      </P>
      <P>
        To remove them from one product only, press <strong>Erase from this product</strong> in that product&apos;s part
        of their page. Their launches stay.
      </P>

      <H2 id="check">Check it worked</H2>
      <Checks>
        <li>Someone who signed up to a launch appears in People, under that launch.</li>
        <li>The same email sent by your product shows on the same row, with the product beside the launch.</li>
      </Checks>

      <H2 id="messages">If you see this</H2>
      <Messages
        rows={[
          ["Nobody in this group yet.", "Pick another group, or wait for people to sign up or for your product to send them."],
          [
            "New has to end before Stuck starts: make New fewer days than Stuck.",
            "On How we read stages, make New a smaller number of days than Stuck, then save.",
          ],
          [
            "Erasing them everywhere. It finishes within a few minutes; then this page finds nobody.",
            "Nothing to fix. The erase runs in the background; reload the page in a few minutes.",
          ],
        ]}
      />

      <NextPage slug="your-audience" />
    </article>
  );
}
